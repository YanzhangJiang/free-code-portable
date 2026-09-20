import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(`../../src/${path}`, import.meta.url).pathname, () => exports)
let experimentReads = 0
let settingsReads = 0
let settingsWrites = 0
let validationAllowed = true
let abortDuringValidation = false
stub('services/analytics/growthbook.ts', { getFeatureValue_CACHED_MAY_BE_STALE: () => {
  experimentReads++
  return { enabled: true, canUserConfigure: false, baseModel: 'claude-sonnet-4-6', advisorModel: 'claude-opus-4-6' }
} })
stub('utils/betas.ts', { shouldIncludeFirstPartyOnlyBetas: () => true })
stub('utils/settings/settings.ts', {
  getInitialSettings: () => { settingsReads++; return { advisorModel: 'claude-opus-4-6' } },
  updateSettingsForSource: () => { settingsWrites++ },
})
stub('utils/model/model.ts', {
  parseUserSpecifiedModel: (model: string) => model,
  normalizeModelStringForAPI: (model: string) => model,
  getDefaultMainLoopModelSetting: () => 'local/claude-opus-4-6',
})
let controller = new AbortController()
stub('utils/model/validateModel.ts', {
  validateModel: async (_model: string, signal: AbortSignal) => {
    assert.equal(signal, controller.signal)
    if (abortDuringValidation) controller.abort()
    return { valid: validationAllowed, error: validationAllowed ? undefined : 'Blocked by model policy' }
  },
})
const runtime = await import('../../src/providers/runtime.js')
const advisor = await import('../../src/utils/advisor.js')
const command = (await import('../../src/commands/advisor.js')).default
const { call } = await command.load()
let state: { mainLoopModel: string; advisorModel?: string } = { mainLoopModel: 'local/claude-opus-4-6' }
const tools = [{ name: 'Agent' }]
const context = {
  getAppState: () => state,
  setAppState: (update: (value: typeof state) => typeof state) => { state = update(state) },
  options: { tools },
  get abortController() { return controller },
} as unknown as Parameters<typeof call>[1]
const directory = mkdtempSync(join(tmpdir(), 'free-code-advisor-checks-'))
try {
  const configPath = join(directory, 'providers.json')
  writeFileSync(configPath, JSON.stringify({ providers: {
    local: { api: 'openai-completions', baseURL: 'http://localhost:11434/v1', defaultModel: 'claude-opus-4-6', models: [{ id: 'claude-opus-4-6' }] },
    review: { api: 'anthropic', baseURL: 'https://example.invalid', defaultModel: 'Case/SensitiveModel', models: [{ id: 'Case/SensitiveModel' }] },
  } }))
  runtime.initializeProviderRuntime({ configPath, provider: 'local', env: {} })
  assert.equal(advisor.isAdvisorEnabled(), false)
  assert.equal(advisor.isAdvisorEnabled('local/claude-opus-4-6'), false)
  assert.equal(advisor.getExperimentAdvisorModels('local/claude-opus-4-6'), undefined)
  assert.equal(advisor.modelSupportsAdvisor('local/claude-opus-4-6'), false)
  assert.equal(advisor.isValidAdvisorModel('local/claude-opus-4-6'), false)
  assert.equal(advisor.getInitialAdvisorSetting(), undefined)
  assert.equal(experimentReads, 0)
  assert.equal(settingsReads, 0)
  assert.equal(command.isEnabled(), true)
  assert.equal(command.isHidden, false)
  assert.match(JSON.stringify(await call('', context)), /Agent tool/)
  await call('review/Case/SensitiveModel', context)
  assert.equal(state.advisorModel, 'review/Case/SensitiveModel')
  const instruction = advisor.getLocalAdvisorInstructions(state.mainLoopModel, state.advisorModel, tools)!
  assert.match(instruction, /Agent tool/)
  assert.match(instruction, /review\/Case\/SensitiveModel/)
  assert.match(instruction, /Normal tool permissions/)
  assert.match(instruction, /does not automatically receive/)
  assert.equal(advisor.getLocalAdvisorInstructions(state.mainLoopModel, 'opus', tools), undefined)
  assert.equal(advisor.getLocalAdvisorInstructions(state.mainLoopModel, 'review/Missing', tools), undefined)
  assert.equal(advisor.getLocalAdvisorInstructions(state.mainLoopModel, state.advisorModel, []), undefined)
  await call('review/Missing', context)
  assert.equal(state.advisorModel, 'review/Case/SensitiveModel')
  validationAllowed = false
  assert.match(JSON.stringify(await call('local/claude-opus-4-6', context)), /Blocked by model policy/)
  assert.equal(state.advisorModel, 'review/Case/SensitiveModel')
  validationAllowed = true
  abortDuringValidation = true
  assert.equal((await call('local/claude-opus-4-6', context)).type, 'skip')
  assert.equal(state.advisorModel, 'review/Case/SensitiveModel')
  abortDuringValidation = false
  controller = new AbortController()
  tools.length = 0
  assert.match(JSON.stringify(await call('local/claude-opus-4-6', context)), /requires the Agent tool/)
  await call('OFF', context)
  assert.equal(state.advisorModel, undefined)
  assert.equal(settingsWrites, 0)
  assert.equal(experimentReads, 0)
  runtime.selectProviderProfile('legacy')
  // An explicitly qualified child model must not inherit the legacy UI state.
  assert.equal(advisor.isAdvisorEnabled('local/claude-opus-4-6'), false)
  assert.equal(advisor.isAdvisorEnabled('claude-sonnet-4-6'), true)
  assert.deepEqual(advisor.getExperimentAdvisorModels('claude-sonnet-4-6'), { baseModel: 'claude-sonnet-4-6', advisorModel: 'claude-opus-4-6' })
  console.log('provider advisor checks passed')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
