import { setMainLoopModelOverride, setModelStrings } from '../../bootstrap/state.js'
import type { TaskStateBase } from '../../Task.js'
import {
  getActiveProviderProfile,
  getProviderProfiles,
  getQualifiedModelId,
  resolveSessionProviderModel,
  selectProviderForModel,
  selectProviderProfile,
} from '../../providers/runtime.js'
import { clearBetasCaches } from '../../utils/betas.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { clearModelValidationCache } from '../../utils/model/validateModel.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'

type SelectionTasks = Readonly<Record<string, Pick<TaskStateBase, 'type' | 'status'>>>

function ensureModelAllowed(model: string | null): void {
  if (model !== null && !isModelAllowed(model)) {
    throw new Error(`Model '${model}' is not available. Your organization restricts model selection.`)
  }
}

function clearProviderCaches(): void {
  // These caches depend on the provider, but credentials and account state do not
  // belong to model selection and must survive a session-only switch.
  setModelStrings(null)
  clearBetasCaches()
  clearToolSchemaCache()
  clearModelValidationCache()
}

export function selectSessionProvider(providerId: string | undefined, _tasks: SelectionTasks = {}): {
  model: string | null
  label: string
} {
  const profile = providerId === undefined
    ? undefined
    : getProviderProfiles().find(provider => provider.id === providerId)
  if (providerId !== undefined && !profile) {
    throw new Error(`Unknown provider '${providerId}'. Run /provider to see configured providers.`)
  }
  const model = profile ? getQualifiedModelId(profile.id, profile.defaultModel) : null
  ensureModelAllowed(model)
  // The registry validates both the profile and its credentials before changing
  // the active selection. Failed selections leave all session state untouched.
  selectProviderProfile(providerId)
  clearProviderCaches()
  setMainLoopModelOverride(model)
  return { model, label: profile?.name ?? profile?.id ?? 'legacy environment configuration' }
}

export function selectSessionModel(model: string | null, _tasks: SelectionTasks = {}): string | null {
  const previousProvider = getActiveProviderProfile()?.id
  const resolved = resolveSessionProviderModel(model)
  // Apply the same namespaced identity as the model menu, including default and
  // alias selections, so neither entry point can bypass availableModels.
  ensureModelAllowed(resolved?.qualifiedModel ?? model)
  if (model !== null) {
    selectProviderForModel(model)
  }
  if (previousProvider !== getActiveProviderProfile()?.id) {
    clearProviderCaches()
  }
  // A default selection stays within the current provider; keeping null also
  // preserves the existing UI's default-model indication.
  return model === null ? null : resolved?.qualifiedModel ?? model
}
