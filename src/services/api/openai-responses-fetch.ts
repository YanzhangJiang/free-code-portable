import { responsesMessage, responsesRequest, wireObject } from './openai-responses-protocol.js'
import { collectResponsesMessage, responsesEventStream } from './openai-responses-stream.js'
import { createNativeMessageSource } from '../../providers/messages.js'
import { invalidProviderRequest } from './provider-wire-errors.js'
import type { NativeMessageSource } from '../../providers/messages.js'
import type { WireObject } from './openai-responses-protocol.js'

type OpenAIResponsesFetchOptions = {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  supportsReasoning?: boolean
  supportsImages?: boolean
  codex?: boolean
  /** Origin is retained with transcript items; it must not contain API secrets. */
  nativeIdentity?: { provider: string; account?: string }
  fetch?: typeof globalThis.fetch
}

/**
 * Adapt Messages requests to a configured Responses endpoint, without forwarding
 * Anthropic credentials. The caller owns the returned Response body and must
 * consume or cancel it; the request's AbortSignal reaches the provider unchanged.
 */
export function createOpenAIResponsesFetch(options: OpenAIResponsesFetchOptions): typeof globalThis.fetch {
  const transport = options.fetch ?? globalThis.fetch
  const baseURL = new URL(options.baseURL)
  if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.search || baseURL.hash) {
    throw new Error('OpenAI Responses base URL must use HTTP(S) without credentials, query parameters, or fragments')
  }
  const endpoint = `${options.baseURL.replace(/\/+$/, '').replace(/\/responses$/, '')}/responses`
  const headers = new Headers(options.headers)
  headers.set('content-type', 'application/json')
  if (options.apiKey) headers.set('authorization', `Bearer ${options.apiKey}`)

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!/^\/v1\/messages(?:\/count_tokens)?\/?$/.test(url.pathname)) {
      throw new Error(`OpenAI Responses adapter does not support ${url.pathname}`)
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    signal?.throwIfAborted()
    const rawBody = init?.body !== undefined
      ? await new Response(init.body).text()
      : input instanceof Request ? await input.clone().text() : ''
    if (url.pathname.replace(/\/$/, '').endsWith('/count_tokens')) {
      // Let the caller's existing token estimation fallback handle this explicitly.
      return Response.json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'This provider does not support Messages count_tokens; use local estimation.' },
      }, { status: 400 })
    }
    let request: WireObject
    let body: WireObject
    let source: NativeMessageSource | undefined
    try {
      request = wireObject(JSON.parse(rawBody), 'Messages request')
      source = options.nativeIdentity ? createNativeMessageSource('openai-responses', {
        ...options.nativeIdentity, endpoint, model: String(request.model),
      }) : undefined
      body = responsesRequest(request, options, source)
    } catch (error) {
      return invalidProviderRequest(error)
    }
    if (options.codex) {
      body.stream = true
      body.instructions ??= ''
      delete body.max_output_tokens
      delete body.temperature
      delete body.top_p
    }
    const requestHeaders = new Headers(headers)
    requestHeaders.set('accept', body.stream ? 'text/event-stream' : 'application/json')
    const response = await transport(endpoint, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal,
      // Credentials belong to this endpoint; never replay them through redirects.
      redirect: 'error',
    })
    if (!response.ok) {
      const text = await response.text()
      let message = text
      let remoteError: Record<string, unknown> = {}
      try {
        const remote = JSON.parse(text)
        if (typeof remote?.error?.message === 'string') {
          message = remote.error.message
          remoteError = remote.error
        }
      } catch {
        // Gateways can return plain text or HTML errors; preserve that context.
      }
      const errorType = response.status === 401 ? 'authentication_error'
        : response.status === 403 ? 'permission_error'
          : response.status === 429 ? 'rate_limit_error'
            : response.status === 400 ? 'invalid_request_error' : 'api_error'
      const errorHeaders = new Headers({ 'content-type': 'application/json' })
      for (const name of ['retry-after', 'retry-after-ms', 'x-request-id', 'request-id']) {
        const value = response.headers.get(name)
        if (value) errorHeaders.set(name, value)
      }
      return new Response(JSON.stringify({ type: 'error', error: {
        type: typeof remoteError.type === 'string' ? remoteError.type : errorType,
        message,
        ...(typeof remoteError.code === 'string' ? { code: remoteError.code } : {}),
        ...(typeof remoteError.param === 'string' ? { param: remoteError.param } : {}),
      } }), {
        status: response.status, headers: errorHeaders,
      })
    }
    const responseHeaders = new Headers({
      'content-type': body.stream ? 'text/event-stream' : 'application/json',
    })
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
    if (requestId) responseHeaders.set('request-id', requestId)
    if (body.stream) {
      if (!response.body) throw new Error('OpenAI Responses: response body is missing')
      const translated = responsesEventStream(response.body, String(body.model), signal, source)
      if (request.stream !== true) {
        responseHeaders.set('content-type', 'application/json')
        return Response.json(await collectResponsesMessage(translated), { headers: responseHeaders })
      }
      return new Response(translated, { headers: responseHeaders })
    }
    return Response.json(responsesMessage(wireObject(await response.json(), 'response'), String(body.model), source), {
      headers: responseHeaders,
    })
  }) as typeof globalThis.fetch
}
