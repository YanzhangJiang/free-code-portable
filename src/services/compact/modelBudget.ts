import { getSdkBetas } from '../../bootstrap/state.js'
import { calculateContextBudget, type ContextBudget } from '../../providers/context-budget.js'
import { resolveProviderModel } from '../../providers/runtime.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'

/** Resolve runtime configuration once before applying the pure token policy. */
export function getCompactionBudget(model: string): ContextBudget {
  const configured = resolveProviderModel(model)
  const requestOutputTokens = getMaxOutputTokensForModel(model)
  return calculateContextBudget({
    contextWindow: getContextWindowForModel(model, getSdkBetas()),
    maxOutputTokens: configured?.model.maxOutputTokens ?? requestOutputTokens,
    requestedOutputTokens: configured ? requestOutputTokens : undefined,
    adaptive: configured !== undefined,
    compactWindow: Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
    autoCompactPercent: Number(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE),
  })
}
