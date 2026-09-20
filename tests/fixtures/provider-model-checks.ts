import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseShellCommand } from 'shell-quote'
import { ALL_MODEL_CONFIGS } from '../../src/utils/model/configs.js'

// Keep the real model/provider functions and isolate their external capabilities.
// Loading the full app here would read the developer's settings and credentials.
const settings: { availableModels?: string[]; model?: string } = {}
let unknownCost = false
let validationRequests = 0
let validationSignal: AbortSignal | undefined
let modelOverride: string | undefined
let teammateMode: 'auto' | 'in-process' | 'tmux' = 'in-process'
let isNonInteractiveSession = false
const stub = (path: string, exports: Record<string, unknown>) => {
  mock.module(new URL(`../../src/${path}`, import.meta.url).pathname, () => exports)
}
stub('bootstrap/state.ts', {
  getMainLoopModelOverride: () => modelOverride,
  getInitialMainLoopModel: () => null,
  setHasUnknownModelCost: () => { unknownCost = true },
  getIsNonInteractiveSession: () => isNonInteractiveSession,
  getSdkBetas: () => ['context-1m-2025-08-07'],
  getChromeFlagOverride: () => undefined,
  getFlagSettingsPath: () => undefined,
  getInlinePlugins: () => [],
  getSessionBypassPermissionsMode: () => false,
  getSessionId: () => 'fixture-session',
})
stub('utils/auth.ts', {
  getSubscriptionType: () => null,
  isClaudeAISubscriber: () => false,
  isCodexSubscriber: () => false,
  isMaxSubscriber: () => false,
  isProSubscriber: () => false,
  isTeamSubscriber: () => false,
  isTeamPremiumSubscriber: () => false,
})
stub('utils/settings/settings.ts', {
  getSettings_DEPRECATED: () => settings,
  getInitialSettings: () => ({}),
  getSettingsWithErrors: () => ({ settings: {} }),
})
stub('utils/config.ts', { getGlobalConfig: () => ({}) })
stub('utils/model/modelStrings.ts', {
  getModelStrings: () => Object.fromEntries(Object.entries(ALL_MODEL_CONFIGS).map(([key, config]) => [key, config.firstParty])),
  resolveOverriddenModel: (model: string) => model,
})
stub('utils/model/modelCapabilities.ts', { getModelCapability: () => undefined })
stub('utils/model/bedrock.ts', {
  getBedrockRegionPrefix: () => undefined,
  applyBedrockRegionPrefix: (model: string) => model,
})
stub('utils/fastMode.ts', { isFastModeEnabled: () => false })
stub('utils/log.ts', { logError: () => {} })
stub('utils/slowOperations.ts', { jsonStringify: JSON.stringify })
stub('utils/swarm/backends/teammateModeSnapshot.ts', {
  getTeammateModeFromSnapshot: () => teammateMode,
})
stub('utils/debug.ts', { logForDebugging: () => {} })
stub('utils/platform.ts', { getPlatform: () => 'linux' })
stub('utils/swarm/backends/detection.ts', {
  isInsideTmuxSync: () => true,
  isInsideTmux: async () => true,
  isInITerm2: () => false,
  isIt2CliAvailable: async () => false,
  isTmuxAvailable: async () => true,
})
stub('utils/swarm/backends/it2Setup.ts', { getPreferTmuxOverIterm2: () => false })
stub('utils/swarm/backends/InProcessBackend.ts', {
  createInProcessBackend: () => ({ type: 'in-process' }),
})
let paneSideEffects = 0
stub('utils/cleanupRegistry.ts', { registerCleanup: () => { paneSideEffects += 1 } })
stub('utils/teammateMailbox.ts', { writeToMailbox: async () => { paneSideEffects += 1 } })
stub('utils/swarm/teammateLayoutManager.ts', {
  assignTeammateColor: () => { paneSideEffects += 1; return 'blue' },
})
stub('utils/envUtils.ts', {
  isEnvTruthy: (value?: string) => value === '1' || value === 'true',
  isEnvDefinedFalsy: (value?: string) => value === '0' || value === 'false',
})
stub('constants/figures.ts', { LIGHTNING_BOLT: '↯' })
stub('services/analytics/index.ts', { logEvent: () => {} })
stub('services/analytics/growthbook.ts', {
  getFeatureValue_CACHED_MAY_BE_STALE: (_name: string, fallback: unknown) => fallback,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
})
stub('utils/sideQuery.ts', {
  sideQuery: async (options: { signal?: AbortSignal }) => {
    validationRequests += 1
    validationSignal = options.signal
    options.signal?.throwIfAborted()
    return {}
  },
})
stub('services/api/codex-fetch-adapter.ts', { isCodexModel: () => false })

const runtime = await import('../../src/providers/runtime.js')
const externalServices = await import('../../src/services/external/runtime.js')
const { runWithProviderExecutionContext } = await import('../../src/providers/execution-context.js')
const model = await import('../../src/utils/model/model.js')
const options = await import('../../src/utils/model/modelOptions.js')
const context = await import('../../src/utils/context.js')
const cost = await import('../../src/utils/modelCost.js')
const thinking = await import('../../src/utils/thinking.js')
const effort = await import('../../src/utils/effort.js')
const betas = await import('../../src/utils/betas.js')
const validation = await import('../../src/utils/model/validateModel.js')
const teammates = await import('../../src/utils/swarm/teammateModel.js')
const agents = await import('../../src/utils/model/agent.js')
const spawning = await import('../../src/utils/swarm/spawnUtils.js')
const backends = await import('../../src/utils/swarm/backends/registry.js')
const { PaneBackendExecutor } = await import('../../src/utils/swarm/backends/PaneBackendExecutor.js')

const directory = mkdtempSync(join(tmpdir(), 'free-code-model-checks-'))
try {
  const configPath = join(directory, 'provider --model config.json')
  writeFileSync(configPath, JSON.stringify({
    providers: {
      local: {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:11434/v1',
        defaultModel: 'Org/Model[1m]',
        smallModel: 'Small',
        models: [
          { id: 'Org/Model[1m]', contextWindow: 48_000, maxOutputTokens: 4096, reasoning: true, cost: { input: 2, output: 7, cacheRead: 0.5, cacheWrite: 3 } },
          { id: 'Small', contextWindow: 8192, maxOutputTokens: 512, reasoning: false },
          // A misleading Claude-like remote ID must never inherit Claude features or prices.
          { id: 'claude-opus-4-6', contextWindow: 16000, maxOutputTokens: 1024, reasoning: false },
        ],
      },
      second: {
        api: 'openai-responses',
        baseURL: 'https://example.invalid/v1',
        defaultModel: 'Other',
        models: [{ id: 'Other', contextWindow: 1_048_576, maxOutputTokens: 9000, reasoning: false, cost: { input: 1, output: 2 } }],
      },
      cloud: {
        api: 'bedrock',
        defaultModel: 'arn:aws:bedrock:region:123:inference-profile/ExactID',
        models: [{ id: 'arn:aws:bedrock:region:123:inference-profile/ExactID' }],
      },
      secured: {
        api: 'openai-completions',
        baseURL: 'https://example.invalid/v1',
        apiKeyEnv: 'TEST_PROFILE_KEY',
        defaultModel: 'Secret',
        models: [{ id: 'Secret' }],
      },
    },
  }))
  runtime.initializeProviderRuntime({ configPath, provider: 'local', env: { TEST_PROFILE_KEY: 'fixture-only-key' } })
  assert.deepEqual(spawning.buildInheritedProviderCliFlags(), [`--providers-file '${configPath}'`])
  modelOverride = 'local/Small'
  assert.deepEqual(parseShellCommand(spawning.buildInheritedCliFlags({ model: 'local/Org/Model[1m]' })), [
    '--providers-file', configPath, '--model', 'local/Org/Model[1m]', '--teammate-mode', 'in-process',
  ])
  modelOverride = undefined

  assert.equal(model.parseUserSpecifiedModel(' local/Org/Model[1m] '), 'local/Org/Model[1m]')
  assert.equal(model.normalizeModelStringForAPI('local/Org/Model[1m]'), 'local/Org/Model[1m]')
  for (const alias of ['sonnet', 'OPUS', 'best', 'opusplan', 'default']) {
    assert.equal(model.parseUserSpecifiedModel(alias), 'local/Org/Model[1m]')
  }
  assert.equal(model.parseUserSpecifiedModel('haiku'), 'local/Small')
  assert.equal(model.getDefaultMainLoopModel(), 'local/Org/Model[1m]')
  settings.model = 'claude-sonnet-4-6'
  process.env.ANTHROPIC_MODEL = 'claude-opus-4-6'
  assert.equal(model.getMainLoopModel(), 'local/Org/Model[1m]')
  delete settings.model
  delete process.env.ANTHROPIC_MODEL
  assert.equal(model.getDefaultSonnetModel(), 'local/Org/Model[1m]')
  assert.equal(model.getDefaultOpusModel(), 'local/Org/Model[1m]')
  assert.equal(model.getDefaultHaikuModel(), 'local/Small')
  assert.equal(model.getSmallFastModel(), 'local/Small')
  assert.equal(teammates.getHardcodedTeammateModelFallback(), 'local/Org/Model[1m]')
  assert.equal(teammates.resolveTeammateModelSelection(undefined, 'local/Small', undefined), 'local/Org/Model[1m]')
  assert.equal(teammates.resolveTeammateModelSelection(undefined, 'local/Small', null), 'local/Small')
  assert.equal(teammates.resolveTeammateModelSelection(undefined, 'local/Small', 'claude-sonnet-4-6'), 'local/Org/Model[1m]')
  assert.equal(teammates.resolveTeammateModelSelection(undefined, 'local/Small', 'second/Other'), 'second/Other')
  assert.equal(teammates.resolveTeammateModelSelection(undefined, 'local/Small', 'second/Removed'), 'local/Org/Model[1m]')
  assert.equal(teammates.resolveTeammateModelSelection(undefined, 'local/Small', 'haiku'), 'local/Small')
  assert.equal(teammates.resolveTeammateModelSelection('inherit', 'local/Small', 'second/Other'), 'local/Small')
  assert.equal(teammates.resolveTeammateModelSelection('local/Small', 'local/Org/Model[1m]', undefined), 'local/Small')
  assert.equal(teammates.resolveTeammateModelSelection('second/Other', 'local/Small', undefined), 'second/Other')
  assert.equal(runtime.getActiveProviderProfile()?.id, 'local')
  settings.availableModels = ['local/Small']
  assert.throws(() => teammates.resolveTeammateModelSelection('second/Other', 'local/Small', undefined), /organization restricts/)
  assert.throws(() => teammates.resolveTeammateModelSelection(undefined, 'local/Small', 'second/Other'), /organization restricts/)
  assert.throws(() => teammates.resolveTeammateModelSelection(undefined, 'local/Small', undefined), /organization restricts/)
  assert.equal(teammates.resolveTeammateModelSelection('inherit', 'local/Small', undefined), 'local/Small')
  delete settings.availableModels
  assert.equal(agents.getAgentModel(undefined, 'local/Small'), 'local/Small')
  assert.ok(agents.getAgentModelOptions().some(option => option.value === 'second/Other'))
  assert.ok(agents.getAgentModelOptions().some(option => option.value === 'inherit'))
  assert.ok(!agents.getAgentModelOptions().some(option => option.value === 'sonnet'))
  assert.equal(agents.getAgentModel('opus', 'local/Small'), 'local/Org/Model[1m]')
  assert.equal(agents.getAgentModel(undefined, 'local/Org/Model[1m]', 'haiku'), 'local/Small')
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'old-claude-model'
  assert.throws(() => agents.getAgentModel(undefined, 'local/Small'), /not configured/)
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'second/Other'
  assert.equal(agents.getAgentModel(undefined, 'local/Small'), 'second/Other')
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'haiku'
  assert.equal(agents.getAgentModel(undefined, 'local/Org/Model[1m]'), 'local/Small')
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  assert.equal(model.getCanonicalName('local/claude-opus-4-6'), 'local/claude-opus-4-6')
  // /cost and /stats traverse legacy history after the active provider changes.
  // A matching raw remote ID in the new profile must not relabel old history.
  assert.equal(model.getCanonicalName('claude-opus-4-6'), 'claude-opus-4-6')
  assert.equal(model.renderModelName('claude-sonnet-4-6'), 'Sonnet 4.6')
  assert.equal(model.renderModelName('retired/UnknownModel'), 'retired/UnknownModel')
  assert.equal(model.renderModelName(''), '')
  assert.equal(model.getPublicModelDisplayName('claude-opus-4-6'), 'Opus 4.6')
  assert.equal(model.getPublicModelName('claude-opus-4-6'), 'Claude Opus 4.6')
  assert.equal(model.getMarketingNameForModel('claude-sonnet-4-6'), 'Sonnet 4.6')
  assert.equal(model.resolveSkillModelOverride('haiku', 'local/Org/Model[1m]'), 'local/Small')
  assert.equal(model.resolveSkillModelOverride('second/Other', 'local/Small'), 'second/Other')
  assert.equal(agents.getAgentModel('second/Other', 'local/Small'), 'second/Other')
  assert.equal(agents.getAgentModel(undefined, 'local/Small', 'second/Other'), 'second/Other')
  assert.throws(() => agents.getAgentModel('second/Missing', 'local/Small'), /not configured/)
  assert.throws(() => model.resolveSkillModelOverride('second/Missing', 'local/Small'), /not configured/)
  settings.availableModels = ['local/Small']
  assert.throws(() => agents.getAgentModel('second/Other', 'local/Small'), /organization restricts/)
  assert.throws(() => model.resolveSkillModelOverride('second/Other', 'local/Small'), /organization restricts/)
  delete settings.availableModels
  assert.equal(model.getPublicModelName('local/Small'), 'Small')
  assert.equal(model.normalizeModelStringForAPI('cloud/arn:aws:bedrock:region:123:inference-profile/ExactID'), 'arn:aws:bedrock:region:123:inference-profile/ExactID')
  assert.throws(() => model.parseUserSpecifiedModel('org/model[1m]'), /not configured/)

  assert.equal(context.getContextWindowForModel('local/Org/Model[1m]'), 48_000)
  assert.equal(context.has1mContext('local/Org/Model[1m]'), false)
  assert.equal(context.getContextWindowForModel('second/Other'), 1_048_576)
  assert.equal(context.has1mContext('second/Other'), true)
  assert.deepEqual(context.getModelMaxOutputTokens('local/Small'), { default: 512, upperLimit: 512 })
  assert.equal(thinking.modelSupportsThinking('local/Org/Model[1m]'), true)
  assert.equal(thinking.modelSupportsThinking('local/Small'), false)
  assert.equal(thinking.modelSupportsAdaptiveThinking('local/Org/Model[1m]'), false)
  assert.equal(effort.modelSupportsEffort('local/Small'), false)
  assert.equal(effort.resolveAppliedEffort('local/Small', 'high'), undefined)
  assert.equal(effort.resolveAppliedEffort('local/Org/Model[1m]', 'max'), 'high')
  assert.equal(effort.modelSupportsMaxEffort('local/claude-opus-4-6'), false)
  assert.deepEqual(betas.getMergedBetas('local/Org/Model[1m]', { isAgenticQuery: true }), [])
  assert.equal(betas.modelSupportsISP('local/Org/Model[1m]'), false)
  assert.equal(betas.modelSupportsContextManagement('local/claude-opus-4-6'), false)
  assert.equal(betas.modelSupportsStructuredOutputs('local/claude-opus-4-6'), false)
  assert.equal(betas.shouldUseGlobalCacheScope('local/Small'), false)

  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 }
  assert.equal(cost.calculateCostFromTokens('claude-opus-4-6', usage), 36.75)
  assert.equal(cost.getModelPricingString('claude-opus-4-6'), '$5/$25 per Mtok')
  assert.equal(cost.calculateCostFromTokens('local/Org/Model[1m]', usage), 12.5)
  assert.equal(unknownCost, false)
  assert.equal(cost.calculateCostFromTokens('local/claude-opus-4-6', usage), 0)
  assert.equal(unknownCost, true)
  assert.equal(cost.getModelPricingString('local/Small'), undefined)
  assert.equal(cost.getModelPricingString('local/Org/Model[1m]'), '$2/$7 per Mtok')
  unknownCost = false
  assert.equal(cost.calculateCostFromTokens('second/Other', { ...usage, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }), 3)
  assert.equal(unknownCost, false)
  assert.equal(cost.calculateCostFromTokens('second/Other', usage), 3)
  assert.equal(unknownCost, true)

  assert.deepEqual(await validation.validateModel('local/Small'), { valid: true })
  assert.deepEqual(await validation.validateModel('second/Other'), { valid: true })
  assert.equal((await validation.validateModel('wrong-model')).valid, false)
  assert.equal(validationRequests, 0)
  settings.availableModels = ['local/Small']
  assert.equal((await validation.validateModel('second/Other')).valid, false)
  assert.deepEqual(options.getModelOptions().map(option => option.value), [null, 'local/Small'])
  delete settings.availableModels
  assert.deepEqual(options.getModelOptions().map(option => option.value), [null, 'local/Org/Model[1m]', 'local/Small', 'local/claude-opus-4-6', 'second/Other', 'cloud/arn:aws:bedrock:region:123:inference-profile/ExactID', 'secured/Secret'])

  teammateMode = 'auto'
  assert.equal(backends.isInProcessEnabled(), false) // Ordinary tmux auto behavior.
  assert.equal(backends.isInProcessEnabled('secured/Secret'), true)
  runtime.selectProviderProfile('secured')
  assert.equal(spawning.requiresInProcessTeammates(), true)
  assert.equal(backends.isInProcessEnabled(), true)
  assert.equal((await backends.getTeammateExecutor()).type, 'in-process')
  teammateMode = 'tmux'
  assert.equal(backends.isInProcessEnabled(), false)
  await assert.rejects(backends.getTeammateExecutor(), /--teammate-mode in-process/)
  isNonInteractiveSession = true
  await assert.rejects(backends.getTeammateExecutor(), /--teammate-mode in-process/)
  isNonInteractiveSession = false
  assert.throws(() => spawning.assertPaneTeammateCredentials(), /--teammate-mode in-process/)
  const paneExecutor = new PaneBackendExecutor({
    type: 'tmux',
    createTeammatePaneInSwarmView: async () => { paneSideEffects += 1; throw new Error('Unexpected pane creation') },
  } as unknown as import('../../src/utils/swarm/backends/types.js').PaneBackend)
  paneExecutor.setContext({} as import('../../src/Tool.js').ToolUseContext)
  const paneSpawn = await paneExecutor.spawn({
    name: 'check', teamName: 'test', prompt: 'unused', cwd: directory,
    model: 'secured/Secret', parentSessionId: 'fixture-session',
  })
  assert.equal(paneSpawn.success, false)
  assert.match(paneSpawn.error!, /--teammate-mode in-process/)
  assert.equal(paneSideEffects, 0)
  assert.equal(await paneExecutor.isActive('check@test'), false)
  teammateMode = 'in-process'
  assert.equal((await backends.getTeammateExecutor()).type, 'in-process')

  // Exercise actual helper/default resolution in concurrent query scopes.
  let resumeQueries!: () => void
  const queryGate = new Promise<void>(resolve => { resumeQueries = resolve })
  const scopedModels = (selected: string) => runWithProviderExecutionContext(
    runtime.createProviderExecutionContext(selected), async () => {
      await queryGate
      return [model.getSmallFastModel(), model.getMainLoopModel(), model.getDefaultSonnetModel()]
    },
  )
  const localQuery = scopedModels('local/Small')
  const secondQuery = scopedModels('second/Other')
  runtime.selectProviderProfile('second')
  modelOverride = 'second/Other'
  resumeQueries()
  assert.deepEqual(await Promise.all([localQuery, secondQuery]), [
    ['local/Small', 'local/Small', 'local/Org/Model[1m]'],
    ['second/Other', 'second/Other', 'second/Other'],
  ])
  modelOverride = undefined
  assert.equal(model.getDefaultMainLoopModel(), 'second/Other')
  assert.equal(model.resolveSkillModelOverride('haiku', 'local/Org/Model[1m]'), 'local/Small')
  assert.equal(teammates.resolveTeammateModelSelection(undefined, 'local/Small', 'opus'), 'local/Org/Model[1m]')
  assert.equal(agents.getAgentModel('opus', 'local/Small'), 'local/Org/Model[1m]')
  assert.equal(agents.getAgentModel(undefined, 'local/Small'), 'local/Small')
  // Requests retain their qualified model when the active provider changes.
  assert.equal(context.getContextWindowForModel('local/Small'), 8192)
  assert.equal(thinking.modelSupportsThinking('local/Org/Model[1m]'), true)
  modelOverride = 'opusplan'
  assert.equal(model.getRuntimeMainLoopModel({ permissionMode: 'plan', mainLoopModel: 'local/Small' }), 'local/Small')
  modelOverride = undefined

  runtime.selectProviderProfile('legacy')
  assert.equal(model.resolveSkillModelOverride('second/Other', 'claude-sonnet-4-6'), 'second/Other')
  assert.deepEqual(spawning.buildInheritedProviderCliFlags(), [`--providers-file '${configPath}'`, '--provider legacy'])
  assert.deepEqual(spawning.buildInheritedProviderCliFlags('second/Other'), [`--providers-file '${configPath}'`])
  const legacyTeammateContext = runtime.createProviderExecutionContext('claude-sonnet-4-6')
  const profileTeammateContext = runtime.createProviderExecutionContext('second/Other')
  assert.deepEqual(runWithProviderExecutionContext(profileTeammateContext, () => spawning.buildInheritedProviderCliFlags()), [`--providers-file '${configPath}'`])
  runtime.selectProviderProfile('second')
  assert.deepEqual(runWithProviderExecutionContext(legacyTeammateContext, () => spawning.buildInheritedProviderCliFlags()), [`--providers-file '${configPath}'`, '--provider legacy'])
  runtime.selectProviderProfile('legacy')
  betas.clearBetasCaches()
  assert.equal(model.getDefaultSonnetModel(), 'claude-sonnet-4-6')
  assert.equal(teammates.getHardcodedTeammateModelFallback(), 'claude-opus-4-6')
  assert.equal(teammates.resolveTeammateModelSelection(undefined, 'claude-sonnet-4-6', 'local/Small'), 'local/Small')
  assert.equal(teammates.resolveTeammateModelSelection(undefined, 'claude-sonnet-4-6', 'local/Removed'), 'claude-opus-4-6')
  assert.equal(teammates.resolveTeammateModelSelection(undefined, 'claude-sonnet-4-6', 'haiku'), 'claude-haiku-4-5-20251001')
  assert.equal(teammates.resolveTeammateModelSelection('inherit', 'claude-sonnet-4-6', undefined), 'claude-sonnet-4-6')
  assert.equal(teammates.resolveTeammateModelSelection('second/Other', 'claude-sonnet-4-6', undefined), 'second/Other')
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'second/Other'
  assert.equal(agents.getAgentModel(undefined, 'claude-sonnet-4-6'), 'second/Other')
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  assert.equal(agents.getAgentModel(undefined, 'claude-sonnet-4-6'), 'claude-sonnet-4-6')
  assert.equal(model.parseUserSpecifiedModel('opus'), 'claude-opus-4-6')
  assert.equal(context.getContextWindowForModel('claude-sonnet-4-6'), 200_000)
  assert.equal(context.getContextWindowForModel('sonnet[1m]'), 1_000_000)
  assert.equal(model.normalizeModelStringForAPI('claude-sonnet-4-6[1m]'), 'claude-sonnet-4-6')
  assert.ok(options.getModelOptions().some(option => option.value === 'second/Other'))
  assert.ok(options.getModelOptions().some(option => option.value === 'haiku'))
  const controller = new AbortController()
  assert.deepEqual(await validation.validateModel('unknown-legacy-model', controller.signal), { valid: true })
  assert.equal(validationRequests, 1)
  assert.equal(validationSignal, controller.signal)
  await validation.validateModel('unknown-legacy-model')
  assert.equal(validationRequests, 1)
  validation.clearModelValidationCache()
  controller.abort()
  assert.equal((await validation.validateModel('unknown-legacy-model', controller.signal)).valid, false)
  assert.equal(validationRequests, 2)
  runtime.initializeProviderRuntime({ configPath, provider: 'local', env: {} })
  assert.throws(() => agents.getAgentModel('secured/Secret', 'local/Small'), /requires environment variable TEST_PROFILE_KEY/)
  assert.throws(() => model.resolveSkillModelOverride('secured/Secret', 'local/Small'), /requires environment variable TEST_PROFILE_KEY/)
  assert.throws(() => teammates.resolveTeammateModelSelection('secured/Secret', 'local/Small', undefined), /requires environment variable TEST_PROFILE_KEY/)
  assert.throws(() => teammates.resolveTeammateModelSelection(undefined, 'local/Small', 'secured/Secret'), /requires environment variable TEST_PROFILE_KEY/)
  assert.equal(runtime.getActiveProviderProfile()?.id, 'local')
  const emptyConfigPath = join(directory, 'empty providers.json')
  writeFileSync(emptyConfigPath, JSON.stringify({ providers: {} }))
  runtime.initializeProviderRuntime({ configPath: emptyConfigPath, env: {} })
  assert.deepEqual(spawning.buildInheritedProviderCliFlags(), [`--providers-file '${emptyConfigPath}'`, '--provider legacy'])
  assert.equal(spawning.requiresInProcessTeammates(), false)
  teammateMode = 'auto'
  assert.equal(backends.isInProcessEnabled(), false)
  runtime.initializeProviderRuntime({ env: { CLAUDE_CONFIG_DIR: join(directory, 'missing') } })
  assert.deepEqual(spawning.buildInheritedProviderCliFlags(), [])
  const servicesPath = join(directory, 'independent services.json')
  writeFileSync(servicesPath, JSON.stringify({ webSearch: { provider: 'brave' } }))
  externalServices.initializeExternalServices({ configPath: servicesPath, env: { BRAVE_SEARCH_API_KEY: 'fixture-service-key' } })
  assert.deepEqual(spawning.buildInheritedProviderCliFlags(), [`--services-file '${servicesPath}'`])
  assert.equal(spawning.requiresInProcessTeammates(), true)
  assert.equal(backends.isInProcessEnabled(), true)
  assert.throws(() => spawning.assertPaneTeammateCredentials(), /search services.*in-process/)
  assert.ok(!spawning.buildInheritedCliFlags().includes('fixture-service-key'))
  console.log('provider model checks passed')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
