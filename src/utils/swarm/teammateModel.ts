import { CLAUDE_OPUS_4_6_CONFIG } from '../model/configs.js'
import { parseUserSpecifiedModel } from '../model/model.js'
import { getAPIProvider } from '../model/providers.js'
import { isModelAllowed } from '../model/modelAllowlist.js'
import {
  resolveExplicitProviderModel,
  resolveModelInProviderProfile,
  resolveProviderCredentials,
  resolveProviderModel,
} from '../../providers/runtime.js'

// @[MODEL LAUNCH]: Update the fallback model below.
// When the user has never set teammateDefaultModel in /config, new teammates
// use the configured provider default, or Opus 4.6 for legacy transports.
export function getHardcodedTeammateModelFallback(): string {
  const configured = resolveProviderModel()
  if (configured) return configured.qualifiedModel
  return CLAUDE_OPUS_4_6_CONFIG[getAPIProvider()]
}

/**
 * Qualified models, including configured defaults, can select another provider.
 * Aliases stay within the leader's provider. Credentials and organization policy
 * are checked before creating a task; stale saved model IDs fall back locally.
 */
export function resolveTeammateModelSelection(
  inputModel: string | undefined,
  leaderModel: string | null,
  savedDefault: string | null | undefined,
): string {
  const selected = resolveTeammateModel(inputModel, leaderModel, savedDefault)
  if (!isModelAllowed(selected)) {
    throw new Error(`Model '${selected}' is not available. Your organization restricts model selection.`)
  }
  const configured = resolveProviderModel(selected)
  if (configured) resolveProviderCredentials(configured.profile)
  return selected
}

function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
  savedDefault: string | null | undefined,
): string {
  if (inputModel) {
    const explicit = resolveExplicitProviderModel(inputModel)
    if (explicit) return explicit.qualifiedModel
  }
  if (inputModel === undefined && savedDefault) {
    try {
      const saved = resolveExplicitProviderModel(savedDefault)
      if (saved) return saved.qualifiedModel
    } catch {
      // A configured profile can survive a removed model in a saved setting.
    }
  }
  const parent = resolveProviderModel(leaderModel)
  if (parent) {
    if (
      inputModel === 'inherit' ||
      (inputModel === undefined && savedDefault === null)
    ) {
      return parent.qualifiedModel
    }
    if (inputModel !== undefined) {
      return resolveModelInProviderProfile(parent.profile, inputModel)
        .qualifiedModel
    }
    if (savedDefault !== undefined && savedDefault !== null) {
      try {
        return resolveModelInProviderProfile(parent.profile, savedDefault)
          .qualifiedModel
      } catch {
        // Persisted /config defaults can belong to an earlier provider session.
      }
    }
    return resolveModelInProviderProfile(parent.profile).qualifiedModel
  }

  if (inputModel === 'inherit') {
    return (
      leaderModel ??
      resolveTeammateModel(undefined, null, savedDefault)
    )
  }
  if (inputModel !== undefined) {
    return inputModel
  }
  if (savedDefault === null) {
    return leaderModel ?? getHardcodedTeammateModelFallback()
  }
  if (savedDefault !== undefined) {
    try {
      if (!resolveProviderModel(savedDefault)) {
        return parseUserSpecifiedModel(savedDefault)
      }
    } catch {
      // A saved model may have been removed from its configured profile.
    }
  }
  return getHardcodedTeammateModelFallback()
}
