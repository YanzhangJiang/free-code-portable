/** Return a terminal client error, so SDKs do not retry local conversion failures. */
export function invalidProviderRequest(error: unknown): Response {
  return Response.json({ type: 'error', error: {
    type: 'invalid_request_error',
    code: 'invalid_provider_request',
    message: error instanceof Error ? error.message : 'Invalid provider request',
  } }, { status: 400 })
}

/** Preserve standard machine-readable fields when a provider fails inside SSE. */
export function providerStreamError(value: unknown, prefix: string): Error {
  const failure = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : { message: String(value) }
  const cause = Object.fromEntries(['message', 'code', 'type', 'param', 'status']
    .filter(key => typeof failure[key] === 'string' || (key === 'status' && typeof failure[key] === 'number'))
    .map(key => [key, failure[key]]))
  const { message: _message, ...fields } = cause
  return Object.assign(new Error(`${prefix}: ${String(failure.message ?? 'response failed')}`, { cause }), fields)
}
