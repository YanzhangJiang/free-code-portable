import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  parseProviderConfiguration,
  type ProviderModel,
  type ProviderProfile,
} from './config.js'
import {
  getProviderExecutionContext,
  type ProviderExecutionContext,
} from './execution-context.js'

type ProviderRuntime = {
  configPath: string
  configurationLoaded: boolean
  profiles: readonly ProviderProfile[]
  activeProviderId?: string
}

export type ResolvedProviderModel = {
  profile: ProviderProfile
  model: ProviderModel
  qualifiedModel: string
}

// The CLI composition root owns this session state. Getters never initialize it or
// read environment variables. Requests retain a frozen profile, not the selection.
let runtime: ProviderRuntime = { configPath: '', configurationLoaded: false, profiles: [] }
const profileEnvironments = new WeakMap<ProviderProfile, Readonly<NodeJS.ProcessEnv>>()

function profileById(state: ProviderRuntime, id: string): ProviderProfile | undefined {
  return state.profiles.find(profile => profile.id === id)
}

function qualifiedProfile(state: ProviderRuntime, model: string): ProviderProfile | undefined {
  const separator = model.indexOf('/')
  return separator < 0 ? undefined : profileById(state, model.slice(0, separator))
}

export function getQualifiedModelId(profileId: string, modelId: string): string {
  return `${profileId}/${modelId}`
}

function resolveModel(state: ProviderRuntime, requested?: string | null): ResolvedProviderModel | undefined {
  const explicitProfile = requested ? qualifiedProfile(state, requested) : undefined
  const profile = explicitProfile ?? (state.activeProviderId ? profileById(state, state.activeProviderId) : undefined)
  if (!profile) return undefined
  return resolveModelInProviderProfile(profile, requested)
}

/**
 * Pure resolution against a retained request profile, independent of the session's
 * current selection. A slash-containing remote ID is accepted only when declared
 * in this profile; resolution never selects a different provider.
 */
export function resolveModelInProviderProfile(profile: ProviderProfile, requested?: string | null): ResolvedProviderModel {
  const isQualified = requested?.startsWith(`${profile.id}/`) ?? false
  let modelId = isQualified ? requested!.slice(profile.id.length + 1) : requested
  if (!modelId && !isQualified) modelId = profile.defaultModel
  // Exact model IDs take precedence over legacy aliases, preserving configured IDs.
  let model = profile.models.find(candidate => candidate.id === modelId)
  if (!model && !isQualified) {
    const alias = modelId!.toLowerCase()
    if (alias === 'default' || alias === 'sonnet' || alias === 'opus' || alias === 'best' || alias === 'opusplan') {
      modelId = profile.defaultModel
    } else if (alias === 'haiku') {
      modelId = profile.smallModel ?? profile.defaultModel
    }
    model = profile.models.find(candidate => candidate.id === modelId)
  }
  if (!model) {
    throw new Error(`Model is not configured for provider "${profile.id}". Select a model from /model or add it to the provider configuration.`)
  }
  return { profile, model, qualifiedModel: getQualifiedModelId(profile.id, model.id) }
}

function credentialsForEnvironment(profile: ProviderProfile, env: Readonly<NodeJS.ProcessEnv>): { apiKey?: string; headers?: Record<string, string> } {
  const apiKey = profile.apiKeyEnv ? env[profile.apiKeyEnv] : undefined
  if (profile.apiKeyEnv && !apiKey?.trim()) {
    throw new Error(`Provider "${profile.id}" requires environment variable ${profile.apiKeyEnv}. Set it before starting Free Code.`)
  }
  return { apiKey, headers: profile.headers ? { ...profile.headers } : undefined }
}

function freezeProfile(profile: ProviderProfile): ProviderProfile {
  for (const model of profile.models) {
    if (model.cost) Object.freeze(model.cost)
    Object.freeze(model)
  }
  Object.freeze(profile.models)
  if (profile.headers) Object.freeze(profile.headers)
  return Object.freeze(profile)
}

/**
 * Called explicitly by the CLI composition root, once startup arguments are known.
 * A missing default file means legacy behavior. Explicit file paths must exist.
 * Validation and credential checks finish before replacing the current session.
 */
export function initializeProviderRuntime(options: {
  configPath?: string
  provider?: string
  model?: string
  env?: NodeJS.ProcessEnv
} = {}): void {
  const env = Object.freeze({ ...(options.env ?? process.env) })
  const explicitPath = options.configPath ?? env.FREE_CODE_PROVIDERS_FILE
  const configPath = resolve(explicitPath ?? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'providers.json'))
  let input: unknown = { providers: {} }
  let fileContent: string | undefined
  try {
    fileContent = readFileSync(configPath, 'utf8')
  } catch (error) {
    if (explicitPath !== undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Cannot read provider configuration ${configPath}. Check that the file exists and is readable.`)
    }
  }
  if (fileContent !== undefined) {
    try {
      input = JSON.parse(fileContent)
    } catch {
      throw new Error(`Provider configuration ${configPath} must contain valid JSON.`)
    }
  }
  const configuration = parseProviderConfiguration(input)
  const next: ProviderRuntime = {
    configPath,
    configurationLoaded: fileContent !== undefined,
    profiles: Object.freeze(Object.entries(configuration.providers).map(([id, profile]) => freezeProfile({ ...profile, id }))),
  }
  const requestedProvider = options.provider ?? env.FREE_CODE_PROVIDER ?? configuration.defaultProvider
  const modelProfile = options.model ? qualifiedProfile(next, options.model) : undefined
  const selectedId = modelProfile?.id ?? requestedProvider
  if (selectedId && selectedId !== 'legacy') {
    const profile = profileById(next, selectedId)
    if (!profile) throw new Error(`Unknown provider. Choose a configured provider from ${configPath}, or use "legacy".`)
    credentialsForEnvironment(profile, env)
    next.activeProviderId = profile.id
  }
  resolveModel(next, options.model)
  for (const profile of next.profiles) profileEnvironments.set(profile, env)
  runtime = next
}

/** Frozen profiles may be retained by a request for its entire lifetime. */
export function getProviderProfiles(): readonly ProviderProfile[] {
  return runtime.profiles
}

export function getActiveProviderProfile(): ProviderProfile | undefined {
  return runtime.activeProviderId ? profileById(runtime, runtime.activeProviderId) : undefined
}

/** Request-scoped profile, falling back to UI selection only outside a query. */
export function getExecutionProviderProfile(): ProviderProfile | undefined {
  const context = getProviderExecutionContext()
  return context
    ? context.kind === 'profile' ? context.resolved.profile : undefined
    : getActiveProviderProfile()
}

export function getProviderConfigPath(): string {
  return runtime.configPath
}

/** True even for an intentionally empty file, which child processes must inherit. */
export function hasLoadedProviderConfiguration(): boolean {
  return runtime.configurationLoaded
}

/** Known profile prefixes are explicit; otherwise slashes remain part of a remote model ID. */
export function resolveProviderModel(model?: string | null): ResolvedProviderModel | undefined {
  const context = getProviderExecutionContext()
  if (context) {
    // Keep the exact frozen profile even if the session registry was reloaded.
    if (context.kind === 'profile' && model?.startsWith(`${context.resolved.profile.id}/`)) {
      return resolveModelInProviderProfile(context.resolved.profile, model)
    }
    const explicitProfile = model ? qualifiedProfile(runtime, model) : undefined
    if (explicitProfile) return resolveModelInProviderProfile(explicitProfile, model)
    return context.kind === 'profile'
      ? resolveModelInProviderProfile(context.resolved.profile, model)
      : undefined
  }
  return resolveModel(runtime, model)
}

/** Explicit configured namespace only; malformed known namespaces fail closed. */
export function resolveExplicitProviderModel(model: string): ResolvedProviderModel | undefined {
  const context = getProviderExecutionContext()
  const retained = context?.kind === 'profile' ? context.resolved.profile : undefined
  const profile = retained && model.startsWith(`${retained.id}/`)
    ? retained
    : qualifiedProfile(runtime, model)
  return profile ? resolveModelInProviderProfile(profile, model) : undefined
}

/** UI selection must not inherit the context of a background callback. */
export function resolveSessionProviderModel(model?: string | null): ResolvedProviderModel | undefined {
  return resolveModel(runtime, model)
}

/** Capture at a query boundary, before any await or iterator advancement. */
export function createProviderExecutionContext(model?: string | null): ProviderExecutionContext {
  const inherited = getProviderExecutionContext()
  if (model === undefined && inherited) return inherited
  const resolved = resolveProviderModel(model)
  if (resolved) {
    resolveProviderCredentials(resolved.profile)
    return Object.freeze({ kind: 'profile', resolved: Object.freeze(resolved) })
  }
  return Object.freeze({ kind: 'legacy', model: model ?? (inherited?.kind === 'legacy' ? inherited.model : undefined) })
}

/** Historical/display lookup only: never remap legacy IDs or validate a request. */
export function findQualifiedProviderModel(modelId: string): ResolvedProviderModel | undefined {
  const profile = qualifiedProfile(runtime, modelId)
  if (!profile) return undefined
  const remoteModelId = modelId.slice(profile.id.length + 1)
  const model = profile.models.find(candidate => candidate.id === remoteModelId)
  return model ? { profile, model, qualifiedModel: modelId } : undefined
}

/** Session-only selection; credentials are validated before changing state. */
export function selectProviderProfile(id: string | undefined): void {
  if (id === undefined || id === 'legacy') {
    runtime = { ...runtime, activeProviderId: undefined }
    return
  }
  const profile = profileById(runtime, id)
  if (!profile) throw new Error(`Unknown provider. Choose a configured provider from ${runtime.configPath}, or use "legacy".`)
  resolveProviderCredentials(profile)
  runtime = { ...runtime, activeProviderId: profile.id }
}

/** Validates the requested model first; a failed model/credential check preserves selection. */
export function selectProviderForModel(model: string): void {
  const resolved = resolveModel(runtime, model)
  if (resolved) selectProviderProfile(resolved.profile.id)
}

/**
 * Credentials belong to the snapshot which produced this profile. Switching or
 * reinitializing the session cannot redirect an already resolved request's key.
 * A caller-created profile is rejected instead of borrowing another profile's key.
 */
export function resolveProviderCredentials(profile: ProviderProfile): { apiKey?: string; headers?: Record<string, string> } {
  const env = profileEnvironments.get(profile)
  if (!env) throw new Error('Provider credentials require a profile from the initialized provider runtime.')
  return credentialsForEnvironment(profile, env)
}
