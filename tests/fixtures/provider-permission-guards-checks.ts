import { feature } from 'bun:bundle'
import { mock } from 'bun:test'
import { plugin } from 'bun'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../src/Tool.js'
import type { AssistantMessage } from '../../src/types/message.js'
import type { PermissionDecision } from '../../src/utils/permissions/PermissionResult.js'

if (!feature('TRANSCRIPT_CLASSIFIER')) throw new Error('Classifier feature must be enabled for this fixture')
const stub = (path: string, exports: Record<string, unknown>) => {
  mock.module(new URL(`../../src/${path}`, import.meta.url).pathname, () => exports)
}
const noop = () => {}
let mainModel = 'local/claude-opus-4-6'
let classifierModel: string | undefined
let settings: { permissions?: { defaultMode?: string } } = {}
let networkCalls = 0
let hookCalls = 0
let hookDecision: PermissionDecision | undefined
let safeAllowChecks = 0
let classifierChecks = 0
let projectionCalls = 0
let autoConfigurationReads = 0
const forbiddenNetwork = async () => {
  networkCalls++
  throw new Error('The isolated permission checks must not make network requests')
}
const originalFetch = globalThis.fetch
globalThis.fetch = forbiddenNetwork as typeof fetch

// Keep permission logic, feature gates, profile resolution, and model eligibility
// real. Inject only application services, UI bookkeeping, and tool capabilities.
stub('bootstrap/state.ts', {
  getOriginalCwd: () => '/fixture', handleAutoModeTransition: noop,
  handlePlanModeTransition: noop, setHasExitedPlanMode: noop,
  setNeedsAutoModeExitAttachment: noop, addToTurnClassifierDuration: noop,
  getTotalCacheCreationInputTokens: () => 0, getTotalCacheReadInputTokens: () => 0,
  getTotalInputTokens: () => 0, getTotalOutputTokens: () => 0,
  getCachedClaudeMdContent: () => null, getLastClassifierRequests: () => [],
  getSessionId: () => 'permission-fixture', setLastClassifierRequests: noop,
  getIsNonInteractiveSession: () => false, getSdkBetas: () => [],
  getAllowedSettingSources: () => [],
})
stub('services/analytics/growthbook.ts', {
  getFeatureValue_CACHED_MAY_BE_STALE: (name: string, fallback: unknown) => {
    if (name !== 'tengu_auto_mode_config') return fallback
    autoConfigurationReads++
    return { enabled: 'enabled', model: classifierModel }
  },
  getFeatureValue_CACHED_WITH_REFRESH: (_name: string, fallback: unknown) => fallback,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  checkSecurityRestrictionGate: () => false,
  getDynamicConfig_BLOCKS_ON_INIT: async (_name: string, fallback: unknown) => fallback,
})
stub('services/analytics/index.ts', { logEvent: noop })
stub('services/analytics/metadata.ts', { sanitizeToolNameForAnalytics: (name: string) => name })
stub('utils/model/model.ts', {
  getMainLoopModel: () => mainModel,
  getCanonicalName: (name: string) => name.toLowerCase(),
})
stub('utils/settings/settings.ts', {
  getSettings_DEPRECATED: () => settings, getInitialSettings: () => ({}),
  getSettingsFilePathForSource: () => '/fixture/settings.json',
  getUseAutoModeDuringPlan: () => true, hasAutoModeOptIn: () => true,
  getAutoModeConfig: () => ({}),
})
stub('utils/auth.ts', { isClaudeAISubscriber: () => false })
stub('utils/context.ts', { has1mContext: () => false })
stub('utils/model/modelSupportOverrides.ts', { get3PModelCapabilityOverride: () => undefined })
stub('utils/model/antModels.ts', { resolveAntModel: (name: string) => name })
stub('utils/debug.ts', { logForDebugging: noop, isDebugMode: () => false })
stub('utils/log.ts', { logError: noop })
stub('utils/slowOperations.ts', { jsonStringify: JSON.stringify })
stub('utils/cwd.ts', { getCwd: () => '/fixture' })
stub('utils/gracefulShutdown.ts', { gracefulShutdown: noop })
stub('utils/fsOperations.ts', { getFsImplementation: () => ({}), safeResolvePath: (path: string) => path })
stub('commands/add-dir/validation.ts', { addDirHelpMessage: () => '', validateDirectoryForWorkspace: noop })
stub('tools.ts', { getToolsForDefaultPreset: () => [], parseToolPreset: () => [] })
stub('constants/figures.ts', { PAUSE_ICON: 'pause' })
stub('tools/BashTool/shouldUseSandbox.ts', { shouldUseSandbox: () => false })
stub('utils/bash/commands.ts', { extractOutputRedirections: (command: string) => ({ commandWithoutRedirections: command, redirections: [] }) })
stub('utils/sandbox/sandbox-adapter.ts', {
  SandboxManager: { isSandboxingEnabled: () => false, isAutoAllowBashIfSandboxedEnabled: () => false },
})
stub('utils/classifierApprovals.ts', {
  clearClassifierChecking: noop,
  setClassifierChecking: () => { classifierChecks++ },
})
stub('utils/hooks.ts', {
  executePermissionRequestHooks: async function* () {
    hookCalls++
    if (hookDecision) yield { permissionRequestResult: hookDecision }
  },
})
stub('utils/messages.ts', {
  AUTO_REJECT_MESSAGE: () => 'Interactive approval is unavailable',
  buildClassifierUnavailableMessage: () => 'Classifier unavailable',
  buildYoloRejectionMessage: () => 'Classifier rejected',
  DONT_ASK_REJECT_MESSAGE: () => 'Permission denied', extractTextContent: () => '',
})
stub('utils/modelCost.ts', { calculateCostFromTokens: () => 0 })
stub('utils/permissions/PermissionUpdate.ts', {
  applyPermissionUpdate: noop, applyPermissionUpdates: noop, persistPermissionUpdates: noop,
})
stub('utils/permissions/permissionsLoader.ts', {
  deletePermissionRuleFromSettings: noop, shouldAllowManagedPermissionRulesOnly: () => false,
  loadAllPermissionRulesFromDisk: () => [],
})
stub('utils/permissions/classifierDecision.ts', {
  isAutoModeAllowlistedTool: () => { safeAllowChecks++; return true },
})
stub('utils/permissions/bashClassifier.ts', {
  getBashPromptAllowDescriptions: () => [], getBashPromptDenyDescriptions: () => [],
})
// Internal prompt assets are absent from the reconstructed snapshot. The tested
// guards run before prompt construction; no classifier text or response is used.
const directory = mkdtempSync(join(tmpdir(), 'free-code-permission-guards-'))
try {
  const promptAsset = join(directory, 'empty-prompt.cjs')
  writeFileSync(promptAsset, 'module.exports = ""\n')
  plugin({
    name: 'permission-fixture-prompt-assets',
    setup(builder) {
      builder.onResolve({ filter: /yolo-classifier-prompts\/.*\.txt$/ }, () => ({ path: promptAsset }))
    },
  })
  stub('utils/permissions/filesystem.ts', { getClaudeTempDir: () => '/fixture' })
  stub('utils/sideQuery.ts', { sideQuery: forbiddenNetwork })
  stub('services/api/claude.ts', { getCacheControl: () => undefined })
  stub('services/api/errors.ts', { parsePromptTooLongTokenCounts: () => undefined })
  stub('services/api/withRetry.ts', { getDefaultMaxRetries: () => 0 })
  stub('utils/tokens.ts', { tokenCountWithEstimation: () => 0 })

  const runtime = await import('../../src/providers/runtime.js')
  const { runWithProviderExecutionContext } = await import('../../src/providers/execution-context.js')
  const { modelSupportsAutoMode } = await import('../../src/utils/betas.js')
  const { hasPermissionsToUseTool } = await import('../../src/utils/permissions/permissions.js')
  const { initialPermissionModeFromCLI } = await import('../../src/utils/permissions/permissionSetup.js')
  const { classifyYoloAction } = await import('../../src/utils/permissions/yoloClassifier.js')
  const autoModeState = await import('../../src/utils/permissions/autoModeState.js')

  const configPath = join(directory, 'providers.json')
  writeFileSync(configPath, JSON.stringify({ providers: { local: {
    api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1',
    defaultModel: 'claude-opus-4-6', models: [{ id: 'claude-opus-4-6' }],
  } } }))
  runtime.initializeProviderRuntime({ configPath, provider: 'local', env: {} })
  assert.equal(modelSupportsAutoMode(mainModel), false)
  const permissionContext = (mode: 'auto' | 'plan' | 'default', headless = false): ToolPermissionContext => ({
    mode, shouldAvoidPermissionPrompts: headless,
    alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
  } as ToolPermissionContext)
  let acceptEditsChecks = 0
  const tool = {
    name: 'FixtureTool', inputSchema: { parse: (input: unknown) => input },
    checkPermissions: async (_input: unknown, context: ToolUseContext) => {
      if (context.getAppState().toolPermissionContext.mode === 'acceptEdits') {
        acceptEditsChecks++
        return { behavior: 'allow' }
      }
      return { behavior: 'ask', message: 'Fixture requires approval' }
    },
    toAutoClassifierInput: () => { projectionCalls++; return '' },
  } as unknown as Tool
  const assistant = { type: 'assistant', message: { id: 'fixture-message', content: [] } } as unknown as AssistantMessage
  const controller = new AbortController()
  const check = (mode: 'auto' | 'plan' | 'default', headless = false, model = mainModel) => {
    const appState = { toolPermissionContext: permissionContext(mode, headless) }
    const context = {
      options: { mainLoopModel: model, tools: [tool] }, messages: [],
      getAppState: () => appState, setAppState: noop, abortController: controller,
    } as unknown as ToolUseContext
    return hasPermissionsToUseTool(tool, {}, context, assistant, 'fixture-tool')
  }

  // Residual auto state must not grant either auto-mode shortcut. Normal headless
  // hooks still run and retain their existing authority; absent hooks deny.
  autoModeState.setAutoModeActive(true)
  for (const mode of ['auto', 'plan'] as const) {
    assert.equal((await check(mode)).behavior, 'ask')
    assert.equal((await check(mode, true)).behavior, 'deny')
  }
  assert.equal(hookCalls, 2)
  hookDecision = { behavior: 'allow', updatedInput: { approved: true } }
  const hookAllowed = await check('auto', true)
  assert.equal(hookAllowed.behavior, 'allow')
  assert.equal(hookAllowed.decisionReason?.type, 'hook')
  hookDecision = { behavior: 'deny', message: 'Fixture hook denied' }
  const hookDenied = await check('auto', true)
  assert.equal(hookDenied.behavior, 'deny')
  assert.equal(hookDenied.decisionReason?.type, 'hook')
  hookDecision = undefined
  assert.equal(acceptEditsChecks, 0)
  assert.equal(safeAllowChecks, 0)
  assert.equal(classifierChecks, 0)

  autoModeState._resetForTesting()
  settings = {}
  const fromCLI = initialPermissionModeFromCLI({ permissionModeCli: 'auto', dangerouslySkipPermissions: false })
  assert.equal(fromCLI.mode, 'default')
  assert.ok(fromCLI.notification)
  assert.equal(autoModeState.isAutoModeActive(), false)
  settings = { permissions: { defaultMode: 'auto' } }
  assert.equal(initialPermissionModeFromCLI({ permissionModeCli: undefined, dangerouslySkipPermissions: false }).mode, 'default')
  assert.equal(autoModeState.isAutoModeActive(), false)
  settings = {}

  const action = { role: 'assistant' as const, content: [{ type: 'tool_use' as const, name: tool.name, input: {} }] }
  const classify = (executionModel?: string) => classifyYoloAction([], action, [tool], permissionContext('auto'), controller.signal, executionModel)
  const configurationReadsBeforeUnsupportedExecution = autoConfigurationReads
  const blocked = await classify()
  assert.equal(blocked.shouldBlock, true)
  assert.equal(blocked.unavailable, true)
  assert.equal(projectionCalls, 0, 'unsupported execution model must be rejected before empty-action projection')
  assert.equal(autoConfigurationReads, configurationReadsBeforeUnsupportedExecution)

  // Legacy main selection cannot authorize a concurrently running profile agent.
  runtime.selectProviderProfile(undefined)
  mainModel = 'claude-opus-4-6'
  assert.equal(modelSupportsAutoMode(mainModel), true)
  assert.equal((await check('auto', false, 'local/claude-opus-4-6')).behavior, 'ask')
  const configurationReadsBeforeExplicitExecution = autoConfigurationReads
  const explicitBlocked = await classify('local/claude-opus-4-6')
  assert.equal(explicitBlocked.unavailable, true)
  assert.equal(explicitBlocked.shouldBlock, true)
  assert.equal(projectionCalls, 0)
  assert.equal(autoConfigurationReads, configurationReadsBeforeExplicitExecution)

  classifierModel = 'local/claude-opus-4-6'
  const classifierBlocked = await classify(mainModel)
  assert.equal(classifierBlocked.unavailable, true)
  assert.equal(classifierBlocked.shouldBlock, true)
  assert.equal(projectionCalls, 0, 'unsupported configured classifier must be rejected before projection')
  classifierModel = undefined

  const execution = runtime.createProviderExecutionContext('local/claude-opus-4-6')
  await runWithProviderExecutionContext(execution, async () => {
    assert.equal((await classify()).unavailable, true)
  })
  assert.equal(projectionCalls, 0)
  assert.equal(networkCalls, 0)
  assert.equal(classifierChecks, 0)

  // Positive controls prove the feature and original legacy paths are active.
  const legacyEmpty = await classify(mainModel)
  assert.equal(legacyEmpty.shouldBlock, false)
  assert.equal(projectionCalls, 1)
  assert.equal(initialPermissionModeFromCLI({ permissionModeCli: 'auto', dangerouslySkipPermissions: false }).mode, 'auto')
  assert.equal((await check('auto')).behavior, 'allow')
  assert.equal(acceptEditsChecks, 1)
  assert.equal(networkCalls, 0)
  controller.abort()
  await assert.rejects(check('auto'), /abort/i)
  console.log('provider permission guards passed')
} finally {
  plugin.clearAll()
  globalThis.fetch = originalFetch
  rmSync(directory, { recursive: true, force: true })
}
