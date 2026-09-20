/** Token budgets for a complete turn, including output and recovery headroom. */
export type ContextBudget = {
  contextWindow: number
  defaultOutputTokens: number
  summaryOutputTokens: number
  effectiveContextWindow: number
  autoCompactThreshold: number
  warningBufferTokens: number
  blockingBufferTokens: number
  postCompactTargetTokens: number
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000

function positiveTokenCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

/** Configured maxima are capabilities, not a request to reserve the entire window. */
export function getProfileDefaultOutputTokens(
  contextWindow: number,
  maxOutputTokens: number,
): number {
  positiveTokenCount(contextWindow, 'contextWindow')
  positiveTokenCount(maxOutputTokens, 'maxOutputTokens')
  return Math.min(maxOutputTokens, Math.max(1, Math.floor(contextWindow / 4)))
}

/**
 * Legacy budgets retain the snapshot's 200k/1m behavior. Explicit profiles use
 * proportional buffers capped at the existing large-window limits, so small
 * windows cannot acquire negative compaction or warning thresholds.
 */
export function calculateContextBudget({
  contextWindow,
  maxOutputTokens,
  adaptive,
  requestedOutputTokens,
  compactWindow,
  autoCompactPercent,
}: {
  contextWindow: number
  maxOutputTokens: number
  adaptive: boolean
  requestedOutputTokens?: number
  compactWindow?: number
  autoCompactPercent?: number
}): ContextBudget {
  positiveTokenCount(contextWindow, 'contextWindow')
  positiveTokenCount(maxOutputTokens, 'maxOutputTokens')
  if (requestedOutputTokens !== undefined) positiveTokenCount(requestedOutputTokens, 'requestedOutputTokens')
  const window = Number.isSafeInteger(compactWindow) && compactWindow! > 0
    ? Math.min(contextWindow, compactWindow!)
    : contextWindow
  const defaultOutputTokens = adaptive
    ? getProfileDefaultOutputTokens(window, maxOutputTokens)
    : maxOutputTokens
  const summaryOutputTokens = Math.min(
    maxOutputTokens,
    COMPACT_MAX_OUTPUT_TOKENS,
    adaptive ? Math.max(1, Math.floor(window / 8)) : Infinity,
  )
  const outputReservation = adaptive
    ? Math.max(Math.min(requestedOutputTokens ?? defaultOutputTokens, maxOutputTokens), summaryOutputTokens)
    : summaryOutputTokens
  const effectiveContextWindow = Math.max(1, window - outputReservation)
  const autoBuffer = adaptive
    ? Math.min(AUTOCOMPACT_BUFFER_TOKENS, Math.max(1, Math.floor(effectiveContextWindow * 0.08)))
    : AUTOCOMPACT_BUFFER_TOKENS
  let autoCompactThreshold = Math.max(1, effectiveContextWindow - autoBuffer)
  if (autoCompactPercent !== undefined && Number.isFinite(autoCompactPercent) && autoCompactPercent > 0 && autoCompactPercent <= 100) {
    autoCompactThreshold = Math.max(1, Math.min(
      autoCompactThreshold,
      Math.floor(effectiveContextWindow * autoCompactPercent / 100),
    ))
  }
  return {
    contextWindow: window,
    defaultOutputTokens,
    summaryOutputTokens,
    effectiveContextWindow,
    autoCompactThreshold,
    warningBufferTokens: adaptive
      ? Math.min(WARNING_THRESHOLD_BUFFER_TOKENS, Math.floor(autoCompactThreshold * 0.1))
      : WARNING_THRESHOLD_BUFFER_TOKENS,
    blockingBufferTokens: adaptive
      ? Math.min(MANUAL_COMPACT_BUFFER_TOKENS, Math.floor(effectiveContextWindow * 0.02))
      : MANUAL_COMPACT_BUFFER_TOKENS,
    // Leave half the usable input for new work, including tool results.
    postCompactTargetTokens: Math.max(1, Math.floor(autoCompactThreshold / 2)),
  }
}

/** Optional restored files and skills share the space left by required context. */
export function calculateRestorationBudget(
  budget: ContextBudget,
  occupiedTokens: number,
): { files: number; skills: number; perFile: number; perSkill: number } {
  if (!Number.isFinite(occupiedTokens) || occupiedTokens < 0) {
    throw new RangeError('occupiedTokens must be finite and nonnegative')
  }
  const remaining = Math.max(0, budget.postCompactTargetTokens - Math.ceil(occupiedTokens))
  const skills = Math.min(POST_COMPACT_SKILLS_TOKEN_BUDGET, Math.floor(remaining / 3))
  const files = Math.min(POST_COMPACT_TOKEN_BUDGET, remaining - skills)
  return {
    files,
    skills,
    perFile: Math.min(POST_COMPACT_MAX_TOKENS_PER_FILE, files),
    perSkill: Math.min(POST_COMPACT_MAX_TOKENS_PER_SKILL, skills),
  }
}
