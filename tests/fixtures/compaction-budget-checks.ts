import assert from 'node:assert/strict'
import { mock } from 'bun:test'

const stub = (path: string, exports: Record<string, unknown>) => {
  mock.module(new URL(`../../src/${path}`, import.meta.url).pathname, () => exports)
}
mock.module('bun:bundle', () => ({ feature: () => false }))
stub('bootstrap/state.ts', { markPostCompaction: () => {}, getSdkBetas: () => [] })
stub('utils/config.ts', { getGlobalConfig: () => ({ autoCompactEnabled: true }) })
stub('utils/context.ts', { getContextWindowForModel: (model: string) => model === 'legacy' ? 200_000 : 16_384 })
stub('providers/runtime.ts', { resolveProviderModel: (model: string) => model === 'legacy' ? undefined : { model: { maxOutputTokens: 4096 } } })
stub('utils/debug.ts', { logForDebugging: () => {} })
stub('utils/log.ts', { logError: () => {} })
stub('utils/envUtils.ts', { isEnvTruthy: (value: string) => value === '1' })
stub('utils/errors.ts', { hasExactErrorMessage: () => false })
stub('utils/tokens.ts', { tokenCountWithEstimation: (messages: { tokens: number }[]) => messages[0]?.tokens ?? 0 })
stub('services/analytics/growthbook.ts', { getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) => fallback })
stub('services/api/claude.ts', { getMaxOutputTokensForModel: (model: string) => model === 'legacy' ? 32_000 : 4096 })
stub('services/api/promptCacheBreakDetection.ts', { notifyCompaction: () => {} })
stub('services/SessionMemory/sessionMemoryUtils.ts', { setLastSummarizedMessageId: () => {} })
stub('services/compact/compact.ts', { compactConversation: () => {}, ERROR_MESSAGE_USER_ABORT: 'abort' })
stub('services/compact/postCompactCleanup.ts', { runPostCompactCleanup: () => {} })
stub('services/compact/sessionMemoryCompact.ts', { trySessionMemoryCompaction: () => null })

const compact = await import('../../src/services/compact/autoCompact.js')
assert.equal(compact.getEffectiveContextWindowSize('local/model'), 12_288)
assert.equal(compact.getAutoCompactThreshold('local/model'), 11_305)
assert.deepEqual(compact.calculateTokenWarningState(0, 'local/model'), {
  percentLeft: 100,
  isAboveWarningThreshold: false,
  isAboveErrorThreshold: false,
  isAboveAutoCompactThreshold: false,
  isAtBlockingLimit: false,
})
assert.equal(compact.calculateTokenWarningState(11_305, 'local/model').isAboveAutoCompactThreshold, true)
assert.equal(compact.calculateTokenWarningState(12_100, 'local/model').isAtBlockingLimit, true)
assert.equal(compact.calculateTokenWarningState(-100, 'local/model').percentLeft, 100)
assert.equal(compact.getAutoCompactThreshold('legacy'), 167_000)
assert.equal(compact.calculateTokenWarningState(146_999, 'legacy').isAboveWarningThreshold, false)
assert.equal(compact.calculateTokenWarningState(147_000, 'legacy').isAboveWarningThreshold, true)

const messages = [{ tokens: 11_305 }] as never
assert.equal(await compact.shouldAutoCompact(messages, 'local/model'), true)
assert.equal(await compact.shouldAutoCompact(messages, 'local/model', 'compact'), false)
assert.equal(await compact.shouldAutoCompact(messages, 'local/model', undefined, 100), false)
process.env.DISABLE_AUTO_COMPACT = '1'
assert.equal(await compact.shouldAutoCompact(messages, 'local/model'), false)
assert.equal(compact.calculateTokenWarningState(11_305, 'local/model').isAboveAutoCompactThreshold, false)
delete process.env.DISABLE_AUTO_COMPACT

process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '8192'
process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50'
assert.equal(compact.getAutoCompactThreshold('local/model'), 2048)
process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1'
assert.equal(compact.getAutoCompactThreshold('local/model'), 1)
assert.equal(compact.calculateTokenWarningState(0, 'local/model').percentLeft, 100)
console.log('compaction budget checks passed')
