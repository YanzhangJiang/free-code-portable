import { describe, expect, test } from 'bun:test'
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { classifyProviderError, getProviderOutputTokenRetry, parseProviderContextOverflow, redactProviderErrorMessage } from './errors.js'

// These fixtures preserve the wire field names and messages used by Messages,
// Chat Completions, Responses and Gemini/Vertex APIs. No live credentials needed.
describe('provider error boundary', () => {
  test.each([
    { status: 400, error: { type: 'invalid_request_error', message: 'prompt is too long: 137500 tokens > 135000 maximum' } },
    { status: 400, error: { code: 'context_length_exceeded', message: 'Context full' } },
    { status: 400, error: { message: "This model's maximum context length is 16385 tokens. However, you requested 20000 tokens (15000 in the messages, 5000 in the completion)." } },
    { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The input token count (2097153) exceeds the maximum number of tokens allowed (2097152).' } },
    { status: 413, error: { message: 'Request Entity Too Large' } },
    new APIConnectionError({ cause: new Error('400 {"error":{"code":"context_length_exceeded","message":"Too much input"}}') }),
  ])('recognizes a reducible context rejection %#', error => {
    expect(classifyProviderError(error).kind).toBe('context_overflow')
    expect(classifyProviderError(error).retryable).toBe(false)
  })

  test('parses counts without inventing an input/output split', () => {
    expect(parseProviderContextOverflow('Prompt is too long: 137,500 tokens > 135,000 maximum')).toEqual({ inputTokens: 137500, actualTokens: 137500, limitTokens: 135000 })
    expect(parseProviderContextOverflow('input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000')).toEqual({ inputTokens: 188059, outputTokens: 20000, actualTokens: 208059, limitTokens: 200000 })
    expect(parseProviderContextOverflow("This model's maximum context length is 16385 tokens. However, you requested 20000 tokens (15000 in the messages, 5000 in the completion)." )).toEqual({ inputTokens: 15000, outputTokens: 5000, actualTokens: 20000, limitTokens: 16385 })
    expect(parseProviderContextOverflow('maximum context length is 8192 tokens. Your messages resulted in 10000 tokens.')).toEqual({ limitTokens: 8192, inputTokens: 10000, actualTokens: 10000, outputTokens: undefined })
    expect(parseProviderContextOverflow('The input token count (4097) exceeds the maximum allowed tokens (4096).')).toEqual({ inputTokens: 4097, actualTokens: 4097, limitTokens: 4096 })
    expect(parseProviderContextOverflow('context_length_exceeded')).toBeUndefined()
    expect(parseProviderContextOverflow('prompt is too long: 99999999999999999999 tokens > 4096')).toBeUndefined()
  })

  test.each([
    [{ status: 401, error: { message: 'Bad credentials' } }, 'authentication', false],
    [{ error: { code: 'invalid_api_key', message: 'Invalid key' } }, 'authentication', false],
    [{ status: 403 }, 'permission', false],
    [{ status: 429, error: { code: 'insufficient_quota' } }, 'quota_exceeded', false],
    [{ status: 429 }, 'rate_limit', true],
    [{ error: { status: 'RESOURCE_EXHAUSTED' } }, 'rate_limit', true],
    [{ status: 503 }, 'server', true],
    [{ error: { type: 'overloaded_error' } }, 'server', true],
    [{ status: 408 }, 'timeout', true],
    [{ error: { code: 'unsupported_parameter' } }, 'unsupported', false],
    [new APIConnectionError({ cause: new Error('unsupported content block document') }), 'unsupported', false],
    [new APIConnectionError({ cause: Object.assign(new Error('Failed'), { code: 'ECONNRESET' }) }), 'connection', true],
    [new APIUserAbortError(), 'cancelled', false],
    [new DOMException('User cancelled', 'AbortError'), 'cancelled', false],
    [new APIConnectionTimeoutError(), 'timeout', true],
    [new Error('Request timed out.', { cause: new DOMException('Fetch aborted', 'AbortError') }), 'timeout', true],
    [new Error('Connection error.', { cause: new Error('Socket closed') }), 'connection', true],
  ] as const)('classifies failure %# without depending on one SDK', (error, kind, retryable) => {
    expect(classifyProviderError(error)).toMatchObject({ kind, retryable })
  })

  test('does not classify unrelated token limits as context overflow', () => {
    for (const error of [
      new Error('Rate limit on tokens per minute exceeded'),
      { status: 400, message: 'image exceeds 5 MB maximum' },
      { status: 400, message: 'maximum of 100 PDF pages' },
      new Error('context initialization failed'),
      { status: 403, error: { code: 'context_length_exceeded' } },
    ]) expect(classifyProviderError(error).kind).not.toBe('context_overflow')
  })

  test('handles cyclic wrappers and ignores request/headers fields', () => {
    const error: Record<string, unknown> = { message: 'Failed', headers: { authorization: 'private' }, request: { body: 'secret' } }
    error.cause = error
    expect(classifyProviderError(error)).toMatchObject({ kind: 'unknown', message: 'Failed' })
    expect(classifyProviderError(new APIError(400, { code: 'context_length_exceeded', message: 'Too much input' }, undefined, new Headers())).kind).toBe('context_overflow')
  })

  test('redacts displayed credential fields without mutating the original error', () => {
    const message = 'Incorrect API key provided: abc123. Authorization: Bearer bearer-value x-api-key=key123 access_token=abc refresh_token=xyz https://user:pass@example.com?api_key=secret sk-private-key123'
    const error = new Error(message)
    const safe = classifyProviderError(error).message
    for (const secret of ['abc123', 'bearer-value', 'key123', 'abc', 'xyz', 'user:pass', 'secret', 'sk-private-key123']) expect(safe).not.toContain(secret)
    expect(error.message).toBe(message)
    expect(redactProviderErrorMessage('prompt is too long: 13000 tokens > 12000')).toBe('prompt is too long: 13000 tokens > 12000')
  })
})

describe('bounded output recovery', () => {
  test('reduces a small-window request below the available context', () => {
    const failure = classifyProviderError(new Error('input length and `max_tokens` exceed context limit: 3000 + 2048 > 4096'))
    expect(getProviderOutputTokenRetry(failure, {})).toBe(1055)
    expect(getProviderOutputTokenRetry(failure, { thinkingBudgetTokens: 1055 })).toBeUndefined()
    expect(getProviderOutputTokenRetry(failure, { requestedMaxTokens: 1055 })).toBeUndefined()
  })

  test('does not retry when input itself exceeds the context or counts are absent', () => {
    expect(getProviderOutputTokenRetry(classifyProviderError(new Error('input length and `max_tokens` exceed context limit: 5000 + 2000 > 4096')), {})).toBeUndefined()
    expect(getProviderOutputTokenRetry(classifyProviderError({ error: { code: 'context_length_exceeded' } }), { requestedMaxTokens: 1000 })).toBeUndefined()
    expect(getProviderOutputTokenRetry(classifyProviderError({ status: 413 }), { requestedMaxTokens: 1000 })).toBeUndefined()
  })

  test('reduces a provider-rejected max output parameter, without exceeding the original request', () => {
    const failure = classifyProviderError({ status: 400, error: { code: 'unsupported_value', param: 'max_tokens', message: 'max_tokens is too large: 8192. This model supports at most 4096 completion tokens.' } })
    expect(failure).toMatchObject({ kind: 'output_limit', outputLimit: 4096, retryable: false })
    expect(getProviderOutputTokenRetry(failure, { requestedMaxTokens: 8192 })).toBe(4096)
    expect(getProviderOutputTokenRetry(failure, {})).toBeUndefined()
    expect(getProviderOutputTokenRetry(failure, { requestedMaxTokens: 4096 })).toBeUndefined()
    expect(getProviderOutputTokenRetry(failure, { requestedMaxTokens: 8192, thinkingBudgetTokens: 4096 })).toBeUndefined()
  })
})
