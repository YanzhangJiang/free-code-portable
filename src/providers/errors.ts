/** Provider failures at the transport boundary; independent of SDK error classes. */
export type ProviderErrorKind =
  | 'cancelled'
  | 'context_overflow'
  | 'output_limit'
  | 'authentication'
  | 'permission'
  | 'quota_exceeded'
  | 'rate_limit'
  | 'unsupported'
  | 'timeout'
  | 'connection'
  | 'server'
  | 'invalid_request'
  | 'unknown'

export type ProviderContextOverflow = {
  inputTokens?: number
  outputTokens?: number
  actualTokens?: number
  limitTokens?: number
}

export type ProviderFailure = {
  kind: ProviderErrorKind
  retryable: boolean
  status?: number
  /** Safe diagnostic text, never a serialization of headers or request bodies. */
  message: string
  context?: ProviderContextOverflow
  outputLimit?: number
}

/** Error objects remain intact for callers; only their displayed diagnostics change. */
export function redactProviderErrorMessage(message: string): string {
  return message
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, '$1 [redacted]')
    .replace(/(\b(?:x-api-key|api[-_ ]?key|access_token|refresh_token|authorization)["']?\s*[:=]\s*["']?)[^\s,"';&}]+/gi, '$1[redacted]')
    .replace(/(\b(?:incorrect|invalid)\s+api\s+key\s+(?:provided\s*)?:\s*)\S+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
}

function tokenCount(value: string | undefined): number | undefined {
  if (!value) return undefined
  const count = Number(value.replaceAll(',', ''))
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined
}

/** Formats observed in Anthropic Messages, OpenAI completions and Vertex/Gemini failures. */
export function parseProviderContextOverflow(message: string): ProviderContextOverflow | undefined {
  const number = '([\\d,]+)'
  const sum = message.match(new RegExp(`input length and [\x60'"]?max_(?:completion_|output_)?tokens[\x60'"]? exceed context limit:\\s*${number}\\s*\\+\\s*${number}\\s*>\\s*${number}`, 'i'))
  if (sum) {
    const inputTokens = tokenCount(sum[1])
    const outputTokens = tokenCount(sum[2])
    const limitTokens = tokenCount(sum[3])
    if (inputTokens !== undefined && outputTokens !== undefined && limitTokens) {
      return { inputTokens, outputTokens, actualTokens: inputTokens + outputTokens, limitTokens }
    }
  }
  const anthropic = message.match(new RegExp(`prompt is too long[^0-9]*${number}\\s*tokens?\\s*>\\s*${number}`, 'i'))
  const google = message.match(new RegExp(`input token count\\s*\\(?${number}\\)?\\s*exceeds (?:the )?maximum (?:number of tokens allowed|allowed tokens)\\s*\\(?${number}`, 'i'))
  const pair = anthropic ?? google
  if (pair) {
    const actualTokens = tokenCount(pair[1])
    const limitTokens = tokenCount(pair[2])
    if (actualTokens !== undefined && limitTokens) return { inputTokens: actualTokens, actualTokens, limitTokens }
  }
  const maximum = message.match(new RegExp(`maximum context length is\\s*${number}\\s*tokens`, 'i'))
  const requested = message.match(new RegExp(`(?:requested|resulted in)\\s*${number}\\s*tokens`, 'i'))
  const breakdown = message.match(new RegExp(`${number}\\s+in (?:the )?messages?,?\\s*${number}\\s+in (?:the )?completion`, 'i'))
  const inputOnly = message.match(new RegExp(`messages resulted in\\s*${number}\\s*tokens`, 'i'))
  const limitTokens = tokenCount(maximum?.[1])
  if (limitTokens) {
    const inputTokens = tokenCount(breakdown?.[1] ?? inputOnly?.[1])
    const outputTokens = tokenCount(breakdown?.[2])
    return { limitTokens, actualTokens: tokenCount(requested?.[1]), inputTokens, outputTokens }
  }
  return undefined
}

function parseOutputLimit(message: string): number | undefined {
  if (!/max_(?:completion_|output_)?tokens|output token limit/i.test(message)) return undefined
  const match = message.match(/(?:at most|less than or equal to|maximum (?:value|allowed))\s*[:=]?\s*([\d,]+)(?:\s+(?:completion|output))?(?:\s+tokens)?/i)
  const limit = tokenCount(match?.[1])
  return limit && limit > 0 ? limit : undefined
}

/**
 * Read only standard error fields, including SDK .cause wrappers. The bounded
 * walk handles cyclic foreign error objects without inspecting request bodies.
 */
export function classifyProviderError(error: unknown): ProviderFailure {
  const messages: string[] = []
  const codes = new Set<string>()
  const names = new Set<string>()
  const seen = new Set<object>()
  let status: number | undefined
  function inspect(value: unknown, depth: number): void {
    if (depth > 6) return
    if (typeof value === 'string') {
      const text = value.slice(0, 16_384)
      if (!messages.includes(text)) messages.push(text)
      // The SDK may stringify a provider envelope instead of preserving .error.
      const encoded = text.replace(/^\d{3}\s+/, '')
      if (encoded.startsWith('{')) {
        try { inspect(JSON.parse(encoded), depth + 1) } catch { /* Ordinary diagnostic text. */ }
      }
      return
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const record = value as Record<string, unknown>
    for (const key of ['status', 'statusCode']) {
      const candidate = record[key]
      if (status === undefined && typeof candidate === 'number' && candidate >= 100 && candidate <= 599) status = candidate
    }
    for (const key of ['code', 'type', 'status']) {
      if (typeof record[key] === 'string') codes.add(record[key].toLowerCase())
    }
    if (typeof record.name === 'string') names.add(record.name)
    if (value instanceof Error) names.add(value.constructor.name)
    if (typeof record.message === 'string') inspect(record.message, depth + 1)
    inspect(record.error, depth + 1)
    inspect(record.cause, depth + 1)
  }
  inspect(error, 0)
  const text = messages.join('\n')
  const message = redactProviderErrorMessage(messages.at(-1) ?? 'Unknown provider error')
  const hasCode = (...values: string[]) => values.some(value => codes.has(value))
  const result = (kind: ProviderErrorKind, retryable = false): ProviderFailure => ({ kind, retryable, status, message })
  // SDK constructor names are mangled in production bundles; its stable timeout
  // diagnostic also distinguishes SDK timeouts from nested fetch AbortErrors.
  const isTimeout = names.has('APIConnectionTimeoutError') || messages.some(message => /^Request timed out\.?$/i.test(message))

  if (names.has('APIUserAbortError') || (!isTimeout && (names.has('AbortError') || hasCode('abort_err', 'err_canceled', 'cancelled'))) || /^Request was aborted\.?$/i.test(text)) return result('cancelled')
  if (status === 401 || hasCode('invalid_api_key', 'authentication_error', 'unauthenticated', 'api_key_invalid') || /(?:incorrect|invalid) api key/i.test(text)) return result('authentication')
  if (status === 403 || hasCode('permission_denied', 'permission_error')) return result('permission')
  if (hasCode('insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active') || /credit balance is too low|exceeded your current quota|billing hard limit/i.test(text)) return result('quota_exceeded')

  const context = parseProviderContextOverflow(text)
  if (status === 413 || context || hasCode('context_length_exceeded', 'context_window_exceeded', 'model_context_window_exceeded', 'prompt_too_long', 'input_too_long') || /prompt is too long|input (?:is too long|exceeds (?:the )?(?:maximum )?context)|exceed(?:s|ed)? (?:the )?(?:model'?s? )?(?:maximum )?context (?:length|window|limit)|maximum context length/i.test(text)) {
    return { ...result('context_overflow'), context }
  }
  const outputLimit = parseOutputLimit(text)
  if (outputLimit !== undefined) return { ...result('output_limit'), outputLimit }
  if (hasCode('unsupported_parameter', 'unsupported_value', 'not_supported', 'not_implemented') || /unsupported (?:content block|server tool|parameter)|does not support (?:images|tools|reasoning)|not supported (?:with|by|for) (?:this|the) model/i.test(text)) return result('unsupported')
  if (status === 429 || hasCode('rate_limit_exceeded', 'rate_limit_error', 'resource_exhausted')) return result('rate_limit', true)
  if (status === 408 || isTimeout || names.has('TimeoutError') || hasCode('etimedout', 'deadline_exceeded', 'und_err_connect_timeout')) return result('timeout', true)
  if ((status !== undefined && status >= 500) || hasCode('overloaded_error', 'server_error', 'internal_error', 'unavailable')) return result('server', true)
  if (status === 409) return result('server', true)
  if (status !== undefined && status >= 400) return result('invalid_request')
  if (names.has('APIConnectionError') || hasCode('econnreset', 'econnrefused', 'epipe', 'enotfound', 'eai_again') || messages.some(message => /^(?:fetch failed|Connection error\.)$/i.test(message))) return result('connection', true)
  return result('unknown')
}

/**
 * An output adjustment is useful only if it fits both the remaining context and
 * the explicit thinking budget, and strictly reduces the rejected request.
 */
export function getProviderOutputTokenRetry(
  failure: ProviderFailure,
  options: { requestedMaxTokens?: number; thinkingBudgetTokens?: number },
): number | undefined {
  const requested = options.requestedMaxTokens ?? failure.context?.outputTokens
  if (!requested || !Number.isSafeInteger(requested)) return undefined
  let limit: number | undefined
  if (failure.kind === 'output_limit') limit = failure.outputLimit
  if (failure.kind === 'context_overflow') {
    const { inputTokens, limitTokens } = failure.context ?? {}
    if (inputTokens === undefined || limitTokens === undefined) return undefined
    // Small-window models cannot afford a fixed 1,000-token safety reserve.
    const reserve = Math.min(1000, Math.max(1, Math.ceil(limitTokens * 0.01)))
    limit = limitTokens - inputTokens - reserve
  }
  if (limit === undefined || !Number.isSafeInteger(limit)) return undefined
  if (limit <= (options.thinkingBudgetTokens ?? 0) || limit >= requested || limit < 1) return undefined
  return limit
}
