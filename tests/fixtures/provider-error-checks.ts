import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import type Anthropic from '@anthropic-ai/sdk'

const stub = (path: string, exports: Record<string, unknown>) => {
  mock.module(new URL(`../../src/${path}`, import.meta.url).pathname, () => exports)
}
let authReads = 0
let authRefreshes = 0
let cacheClears = 0
let profile: { api: string; id: string; apiKeyEnv: string } | undefined = { api: 'openai-completions', id: 'test', apiKeyEnv: 'TEST_KEY' }
let onSleep: ((signal?: AbortSignal) => void) | undefined
let sleepCount = 0
stub('providers/runtime.ts', { resolveProviderModel: () => profile ? { profile } : undefined })
stub('utils/auth.ts', {
  clearApiKeyHelperCache: () => { cacheClears++ },
  clearAwsCredentialsCache: () => { cacheClears++ },
  clearGcpCredentialsCache: () => { cacheClears++ },
  getClaudeAIOAuthTokens: () => { authReads++; return { accessToken: 'unused' } },
  handleOAuth401Error: async () => { authRefreshes++ },
  isClaudeAISubscriber: () => false,
  isEnterpriseSubscriber: () => false,
  getAnthropicApiKeyWithSource: () => { authReads++; return { source: 'ANTHROPIC_API_KEY' } },
  getOauthAccountInfo: () => undefined,
})
stub('utils/aws.ts', { isAwsCredentialsProviderError: () => false })
stub('utils/debug.ts', { logForDebugging: () => {} })
stub('utils/log.ts', { logError: () => {} })
stub('utils/messages.ts', {
  createSystemAPIErrorMessage: () => ({ type: 'system' }),
  createAssistantAPIErrorMessage: (options: Record<string, unknown>) => ({ ...options, isApiErrorMessage: true, message: { content: [{ type: 'text', text: options.content }] } }),
  NO_RESPONSE_REQUESTED: 'none',
})
stub('utils/model/providers.ts', { getAPIProviderForStatsig: () => 'openai', getAPIProvider: () => profile ? 'openai' : 'firstParty' })
stub('utils/model/model.ts', { isNonCustomOpusModel: () => false, getDefaultMainLoopModelSetting: () => 'test/model' })
stub('utils/model/modelStrings.ts', { getModelStrings: () => ({}) })
stub('utils/fastMode.ts', {
  handleFastModeOverageRejection: () => {}, handleFastModeRejectedByAPI: () => {},
  isFastModeCooldown: () => false, isFastModeEnabled: () => false, triggerFastModeCooldown: () => {},
})
stub('utils/proxy.ts', { disableKeepAlive: () => {} })
stub('utils/sleep.ts', {
  sleep: async (_milliseconds: number, signal: AbortSignal | undefined, options: { abortError: () => Error }) => {
    sleepCount++
    onSleep?.(signal)
    if (signal?.aborted) throw options.abortError()
  },
})
stub('services/analytics/growthbook.ts', { getFeatureValue_CACHED_MAY_BE_STALE: (_name: string, fallback: unknown) => fallback })
stub('services/analytics/index.ts', { logEvent: () => {} })
stub('services/rateLimitMocking.ts', { checkMockRateLimitError: () => undefined, isMockRateLimitError: () => false, shouldProcessRateLimits: () => false })
stub('bootstrap/state.ts', { getIsNonInteractiveSession: () => false })
stub('utils/imageResizer.ts', { ImageResizeError: class ImageResizeError extends Error {} })
stub('utils/imageValidation.ts', { ImageSizeError: class ImageSizeError extends Error {} })
stub('services/claudeAiLimits.ts', { getRateLimitErrorMessage: () => undefined })
stub('services/api/errorUtils.ts', { extractConnectionErrorDetails: () => undefined, formatAPIError: (error: Error) => error.message })

const { withRetry, CannotRetryError } = await import('../../src/services/api/withRetry.js')
const { getAssistantMessageFromError, getPromptTooLongTokenGap, isPromptTooLongMessage, classifyAPIError, getErrorMessageIfRefusal } = await import('../../src/services/api/errors.js')
const options = { model: 'test/model', thinkingConfig: { type: 'disabled' as const }, maxRetries: 3, maxOutputTokens: 2048 }
const apiError = (status: number, message: string, code?: string, headers?: Headers) => new APIError(status, { message, ...(code && { code }) }, undefined, headers ?? new Headers())
const getClient = async () => ({} as Anthropic)
async function consume<T>(generator: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) { const event = await generator.next(); if (event.done) return event.value }
}

for (const error of [
  apiError(401, 'Incorrect API key provided: top-secret.'),
  apiError(403, 'Access denied'),
  apiError(429, 'Quota reached', 'insufficient_quota'),
  new APIConnectionError({ cause: new Error('unsupported content block document') }),
]) {
  let attempts = 0
  await assert.rejects(consume(withRetry(getClient, async () => { attempts++; throw error }, options)), caught => {
    assert.ok(caught instanceof CannotRetryError)
    assert.equal(caught.originalError, error)
    assert.ok(!caught.message.includes('top-secret'))
    return true
  })
  assert.equal(attempts, 1)
}
assert.equal(authReads, 0)
assert.equal(authRefreshes, 0)
assert.equal(cacheClears, 0)
assert.equal(sleepCount, 0)

let attempts = 0
const controller = new AbortController()
await assert.rejects(consume(withRetry(getClient, async () => {
  attempts++; controller.abort(); throw apiError(503, 'unavailable')
}, { ...options, signal: controller.signal })), APIUserAbortError)
assert.equal(attempts, 1)

const waitingController = new AbortController()
onSleep = () => waitingController.abort()
attempts = 0
await assert.rejects(consume(withRetry(getClient, async () => { attempts++; throw apiError(429, 'rate limit') }, { ...options, signal: waitingController.signal })), APIUserAbortError)
assert.equal(attempts, 1)
onSleep = undefined

for (const error of [apiError(429, 'rate limit'), apiError(503, 'temporarily unavailable'), new APIConnectionError({ cause: new Error('socket closed') })]) {
  attempts = 0
  const result = await consume(withRetry(getClient, async () => { attempts++; if (attempts === 1) throw error; return 'ok' }, options))
  assert.equal(result, 'ok')
  assert.equal(attempts, 2)
}

const overflow = apiError(400, 'input length and `max_tokens` exceed context limit: 3000 + 2048 > 4096')
attempts = 0
const result = await consume(withRetry(getClient, async (_client, attempt, context) => {
  attempts++
  if (attempt === 1) throw overflow
  assert.equal(context.maxTokensOverride, 1055)
  return 'reduced'
}, options))
assert.equal(result, 'reduced')
assert.equal(attempts, 2)

// A stale/repeated error cannot keep resending the same supposedly-fixed limit.
attempts = 0
await assert.rejects(consume(withRetry(getClient, async () => { attempts++; throw overflow }, options)), CannotRetryError)
assert.equal(attempts, 2)
attempts = 0
await assert.rejects(consume(withRetry(getClient, async () => { attempts++; throw overflow }, { ...options, thinkingConfig: { type: 'enabled', budgetTokens: 1100 } })), CannotRetryError)
assert.equal(attempts, 1)

const tooMuchOutput = apiError(400, 'max_output_tokens must be less than or equal to 1024', 'unsupported_value')
await consume(withRetry(getClient, async (_client, attempt, context) => {
  if (attempt === 1) throw tooMuchOutput
  assert.equal(context.maxTokensOverride, 1024)
}, options))

const structuredOverflow = apiError(400, 'Too much input', 'context_length_exceeded')
attempts = 0
await assert.rejects(consume(withRetry(getClient, async () => { attempts++; throw structuredOverflow }, options)), CannotRetryError)
assert.equal(attempts, 1)
assert.equal(isPromptTooLongMessage(getAssistantMessageFromError(structuredOverflow, 'test/model')), true)
assert.equal(isPromptTooLongMessage(getAssistantMessageFromError(apiError(413, 'Payload Too Large'), 'test/model')), true)
const googleOverflow = getAssistantMessageFromError(new Error('The input token count (5000) exceeds the maximum number of tokens allowed (4096).'), 'test/model')
assert.equal(getPromptTooLongTokenGap(googleOverflow), 904)
const openaiOverflow = getAssistantMessageFromError(new Error("This model's maximum context length is 4096 tokens. However, you requested 5048 tokens (3000 in the messages, 2048 in the completion)."), 'test/model')
assert.equal(getPromptTooLongTokenGap(openaiOverflow), 952)
assert.equal(classifyAPIError(structuredOverflow), 'prompt_too_long')
const keyFailure = getAssistantMessageFromError(apiError(401, 'Incorrect API key provided: secret123'), 'test/model')
assert.match(JSON.stringify(keyFailure), /TEST_KEY/)
assert.ok(!JSON.stringify(keyFailure).includes('secret123'))
assert.ok(!JSON.stringify(keyFailure).includes('/login'))
assert.equal(authReads, 0)
const refusal = JSON.stringify(getErrorMessageIfRefusal('refusal', 'test/model'))
assert.ok(!refusal.includes('anthropic.com'))
assert.ok(!refusal.includes('claude-sonnet'))

// Legacy key-helper refresh remains available without a configured profile.
profile = undefined
attempts = 0
await consume(withRetry(getClient, async () => { if (++attempts === 1) throw apiError(401, 'expired'); return 'ok' }, options))
assert.equal(cacheClears, 1)
assert.equal(authRefreshes, 1)
console.log('provider error checks passed')
