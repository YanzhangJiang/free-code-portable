import { convertCompletionStream, convertCompletionResponse } from './openai-compatible-response.js'
import { invalidProviderRequest } from './provider-wire-errors.js'
import { createNativeMessageSource, replayNativeContent, type NativeMessageSource } from '../../providers/messages.js'

export type OpenAICompatibleFetchOptions = {
  /** API root, including a version prefix when required (for example /v1). */
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Allows replaying reasoning_content and sending an explicit reasoning effort. */
  supportsReasoning?: boolean
  supportsImages?: boolean
  nativeIdentity?: { provider: string }
  fetch?: typeof globalThis.fetch
}

type JsonObject = Record<string, unknown>

function object(value: unknown, description: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`OpenAI-compatible request: expected ${description}`)
  }
  return value as JsonObject
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`OpenAI-compatible request: expected ${description}`)
  }
  return value
}

function blocks(content: unknown): JsonObject[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) {
    throw new TypeError('OpenAI-compatible request: message content must be text or content blocks')
  }
  return content.map(block => object(block, 'content block'))
}

function imagePart(block: JsonObject, options: OpenAICompatibleFetchOptions): JsonObject {
  if (options.supportsImages === false) {
    throw new Error('The selected provider model does not support images. Select an image-capable model or remove the image.')
  }
  const source = object(block.source, 'image source')
  switch (source.type) {
    case 'base64':
      return {
        type: 'image_url',
        image_url: {
          url: `data:${requiredString(source.media_type, 'image media type')};base64,${requiredString(source.data, 'image data')}`,
        },
      }
    case 'url':
      return { type: 'image_url', image_url: { url: requiredString(source.url, 'image URL') } }
    default:
      throw new Error(`OpenAI-compatible request: unsupported image source ${String(source.type)}`)
  }
}

function textPart(block: JsonObject): JsonObject {
  if (typeof block.text !== 'string') throw new TypeError('OpenAI-compatible request: text block must contain text')
  return { type: 'text', text: block.text }
}

function unsupportedBlock(block: JsonObject): never {
  throw new Error(`OpenAI-compatible request: unsupported content block ${String(block.type)}. This content cannot be sent using Chat Completions.`)
}

function messageContent(parts: JsonObject[]): string | JsonObject[] {
  return parts.every(part => part.type === 'text')
    ? parts.map(part => part.text).join('\n')
    : parts
}

function translateMessages(request: JsonObject, options: OpenAICompatibleFetchOptions, source?: NativeMessageSource): JsonObject[] {
  const messages: JsonObject[] = []
  const pendingToolResults = new Set<string>()
  let pendingUserParts: JsonObject[] = []
  if (request.system !== undefined) {
    messages.push({
      role: 'system',
      content: blocks(request.system).map(block => {
        if (block.type !== 'text') unsupportedBlock(block)
        return textPart(block).text
      }).join('\n\n'),
    })
  }
  if (!Array.isArray(request.messages)) throw new TypeError('OpenAI-compatible request: messages must be an array')
  for (const value of request.messages) {
    const message = object(value, 'message')
    const content = blocks(message.content)
    const parts: JsonObject[] = []
    if (message.role === 'assistant') {
      if (pendingToolResults.size) {
        throw new Error('OpenAI-compatible request: an assistant tool call is missing its result')
      }
      const toolCalls: JsonObject[] = []
      const reasoning: string[] = []
      for (const block of content) {
        switch (block.type) {
          case 'text':
            parts.push(textPart(block))
            break
          case 'tool_use':
            pendingToolResults.add(requiredString(block.id, 'tool call ID'))
            toolCalls.push({
              id: requiredString(block.id, 'tool call ID'),
              type: 'function',
              function: {
                name: requiredString(block.name, 'tool name'),
                arguments: JSON.stringify(object(block.input, 'tool input')),
              },
            })
            break
          case 'thinking':
            if (options.supportsReasoning && typeof block.thinking === 'string' &&
                (!source || 'nativeItem' in replayNativeContent([block], source)[0]!)) reasoning.push(block.thinking)
            break
          case 'redacted_thinking':
            // Anthropic's opaque signed/redacted reasoning is not portable.
            break
          default:
            unsupportedBlock(block)
        }
      }
      if (parts.length === 0 && toolCalls.length === 0 && reasoning.length === 0) continue
      const translated: JsonObject = { role: 'assistant', content: parts.length ? messageContent(parts) : null }
      if (toolCalls.length) translated.tool_calls = toolCalls
      if (reasoning.length) translated.reasoning_content = reasoning.join('\n')
      messages.push(translated)
    } else if (message.role === 'user') {
      for (const block of content) {
        switch (block.type) {
          case 'text':
            parts.push(textPart(block))
            break
          case 'image':
            parts.push(imagePart(block, options))
            break
          case 'tool_result': {
            const toolCallId = requiredString(block.tool_use_id, 'tool result ID')
            pendingToolResults.delete(toolCallId)
            const resultText: string[] = []
            const resultImages: JsonObject[] = []
            for (const result of blocks(block.content ?? '')) {
              if (result.type === 'text') resultText.push(String(textPart(result).text))
              else if (result.type === 'image') resultImages.push(imagePart(result, options))
              else unsupportedBlock(result)
            }
            const prefix = block.is_error === true ? 'Tool execution failed:\n' : ''
            messages.push({ role: 'tool', tool_call_id: toolCallId, content: prefix + resultText.join('\n') })
            if (resultImages.length) {
              // Chat Completions tool messages cannot carry images. Keep all tool
              // responses adjacent, then associate the image with its result ID.
              parts.push({ type: 'text', text: `Images from tool result ${toolCallId}:` }, ...resultImages)
            }
            break
          }
          default:
            unsupportedBlock(block)
        }
      }
      pendingUserParts.push(...parts)
      if (pendingToolResults.size === 0 && (pendingUserParts.length || content.length === 0)) {
        messages.push({ role: 'user', content: messageContent(pendingUserParts) })
        pendingUserParts = []
      }
    } else {
      throw new TypeError(`OpenAI-compatible request: unsupported message role ${String(message.role)}`)
    }
  }
  if (pendingToolResults.size) {
    throw new Error('OpenAI-compatible request: an assistant tool call is missing its result')
  }
  return messages
}

function translateRequest(request: JsonObject, options: OpenAICompatibleFetchOptions, source?: NativeMessageSource): JsonObject {
  const translated: JsonObject = {
    model: requiredString(request.model, 'model ID'),
    messages: translateMessages(request, options, source),
    stream: request.stream === true,
  }
  if (request.stream === true) translated.stream_options = { include_usage: true }
  if (request.max_tokens !== undefined) translated[options.maxTokensField ?? 'max_tokens'] = request.max_tokens
  for (const name of ['temperature', 'top_p'] as const) {
    if (request[name] !== undefined) translated[name] = request[name]
  }
  if (Array.isArray(request.stop_sequences) && request.stop_sequences.length) translated.stop = request.stop_sequences
  if (Array.isArray(request.tools) && request.tools.length) {
    translated.tools = request.tools.map(value => {
      const tool = object(value, 'tool')
      // Server tools (web search, tool search, etc.) have no local implementation.
      if (tool.type && tool.type !== 'custom') {
        throw new Error(`OpenAI-compatible request: unsupported server tool ${String(tool.type)}`)
      }
      return {
        type: 'function',
        function: {
          name: requiredString(tool.name, 'tool name'),
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          parameters: object(tool.input_schema, 'tool input schema'),
        },
      }
    })
  }
  if (request.tool_choice !== undefined) {
    const choice = object(request.tool_choice, 'tool choice')
    switch (choice.type) {
      case 'auto': translated.tool_choice = 'auto'; break
      case 'none': translated.tool_choice = 'none'; break
      case 'any': translated.tool_choice = 'required'; break
      case 'tool':
        translated.tool_choice = { type: 'function', function: { name: requiredString(choice.name, 'chosen tool name') } }
        break
      default:
        throw new Error(`OpenAI-compatible request: unsupported tool choice ${String(choice.type)}`)
    }
    if (typeof choice.disable_parallel_tool_use === 'boolean') translated.parallel_tool_calls = !choice.disable_parallel_tool_use
  }
  if (request.output_config !== undefined) {
    const output = object(request.output_config, 'output configuration')
    if (options.supportsReasoning && typeof output.effort === 'string') {
      translated.reasoning_effort = output.effort === 'max' ? 'high' : output.effort
    }
    if (output.format !== undefined) {
      const format = object(output.format, 'output format')
      if (format.type !== 'json_schema') {
        throw new Error(`OpenAI-compatible request: unsupported output format ${String(format.type)}`)
      }
      translated.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', schema: object(format.schema, 'output JSON schema'), strict: false },
      }
    }
  }
  return translated
}

/**
 * Adapts Anthropic Messages calls to one configured Chat Completions endpoint.
 * Owns no credentials or global provider state. Only explicitly supplied headers
 * leave this boundary; SDK authentication and Anthropic headers are discarded.
 * A response stream owns its upstream reader and cancels it when abandoned.
 */
export function createOpenAICompatibleFetch(options: OpenAICompatibleFetchOptions): typeof globalThis.fetch {
  const endpoint = new URL(options.baseURL)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new TypeError('OpenAI-compatible baseURL must be an HTTP(S) URL without embedded credentials')
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/chat/completions`
  endpoint.hash = ''
  const transport = options.fetch ?? globalThis.fetch
  const headers = new Headers(options.headers)
  headers.set('content-type', 'application/json')
  if (options.apiKey) headers.set('authorization', `Bearer ${options.apiKey}`)

  const adaptedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    const path = new URL(request.url).pathname
    if (path.endsWith('/messages/count_tokens')) {
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Chat Completions has no token counting endpoint; use local token estimation.' } }, { status: 400 })
    }
    if (!path.endsWith('/messages') || request.method !== 'POST') {
      throw new Error(`OpenAI-compatible adapter does not support ${request.method} ${path}`)
    }
    let body: JsonObject
    let source: NativeMessageSource | undefined
    try {
      const message = object(await request.json(), 'JSON request body')
      source = options.nativeIdentity ? createNativeMessageSource('openai-completions', {
        ...options.nativeIdentity, endpoint: endpoint.toString(), model: String(message.model),
      }) : undefined
      body = translateRequest(message, options, source)
    } catch (error) {
      request.signal.throwIfAborted()
      return invalidProviderRequest(error)
    }
    const response = await transport(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
      redirect: 'error',
    })
    if (!response.ok) return response
    if (body.stream === true) return convertCompletionStream(response, String(body.model), request.signal, source)
    const requestId = response.headers.get('request-id') ?? response.headers.get('x-request-id')
    return Response.json(convertCompletionResponse(await response.json(), String(body.model), source), {
      headers: requestId ? { 'request-id': requestId } : {},
    })
  }
  return adaptedFetch as typeof globalThis.fetch
}
