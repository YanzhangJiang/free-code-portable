import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_MODEL_CONFIGS } from '../../src/utils/model/configs.js'
import type { ModelStrings } from '../../src/utils/model/modelStrings.js'

// The child process owns these mocks; no test accesses developer settings or AWS.
let cache: ModelStrings | null = null
let cacheReads = 0
let cacheWrites = 0
let profileRequests = 0
let releaseProfiles: (profiles: string[]) => void = () => {}
const pendingProfiles = new Promise<string[]>(resolve => { releaseProfiles = resolve })
const settings: { modelOverrides?: Record<string, string> } = {
  modelOverrides: { 'claude-opus-4-6': 'legacy-custom-opus' },
}
const stub = (path: string, exports: Record<string, unknown>) => {
  mock.module(new URL(`../../src/${path}`, import.meta.url).pathname, () => exports)
}
stub('bootstrap/state.ts', {
  getModelStrings: () => { cacheReads += 1; return cache },
  setModelStrings: (value: ModelStrings) => { cacheWrites += 1; cache = value },
})
stub('utils/log.ts', { logError: (error: Error) => { throw error } })
stub('utils/settings/settings.ts', { getInitialSettings: () => settings })
stub('utils/envUtils.ts', { isEnvTruthy: (value?: string) => value === '1' || value === 'true' })
stub('utils/model/bedrock.ts', {
  getBedrockInferenceProfiles: () => { profileRequests += 1; return pendingProfiles },
  findFirstMatch: (profiles: string[], needle: string) => profiles.find(profile => profile.includes(needle)),
})

const runtime = await import('../../src/providers/runtime.js')
const { runWithProviderExecutionContext } = await import('../../src/providers/execution-context.js')
const strings = await import('../../src/utils/model/modelStrings.js')
const directory = mkdtempSync(join(tmpdir(), 'free-code-model-strings-'))
try {
  const configPath = join(directory, 'providers.json')
  writeFileSync(configPath, JSON.stringify({ providers: {
    local: { api: 'openai-completions', baseURL: 'http://localhost:11434/v1', defaultModel: 'Local', models: [{ id: 'Local' }] },
    cloud: { api: 'bedrock', defaultModel: 'ExactArn', models: [{ id: 'ExactArn' }] },
  } }))
  runtime.initializeProviderRuntime({ configPath, provider: 'legacy', env: {} })
  const legacy = runtime.createProviderExecutionContext('claude-sonnet-4-6')
  const local = runtime.createProviderExecutionContext('local/Local')
  const cloud = runtime.createProviderExecutionContext('cloud/ExactArn')
  const opusKey = Object.keys(ALL_MODEL_CONFIGS).find(key => ALL_MODEL_CONFIGS[key as keyof typeof ALL_MODEL_CONFIGS].firstParty === 'claude-opus-4-6')! as keyof ModelStrings
  assert.equal(strings.getModelStrings()[opusKey], 'legacy-custom-opus')
  const readsBeforeProfiles = cacheReads
  const writesBeforeProfiles = cacheWrites
  for (const [context, apiProvider] of [[local, 'openai'], [cloud, 'bedrock']] as const) {
    await runWithProviderExecutionContext(context, async () => {
      assert.equal(strings.getModelStrings()[opusKey], ALL_MODEL_CONFIGS[opusKey][apiProvider])
      await strings.ensureModelStringsInitialized()
    })
  }
  assert.equal(cacheReads, readsBeforeProfiles)
  assert.equal(cacheWrites, writesBeforeProfiles)
  assert.equal(profileRequests, 0)
  runtime.selectProviderProfile('cloud')
  assert.equal(runWithProviderExecutionContext(legacy, () => strings.getModelStrings()[opusKey]), 'legacy-custom-opus')
  assert.equal(strings.getModelStrings()[opusKey], ALL_MODEL_CONFIGS[opusKey].bedrock)

  // A pending legacy discovery may finish while configured agents execute. Its
  // result stays in the legacy cache and cannot become a profile's model ID.
  cache = null
  delete settings.modelOverrides
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  const legacyDiscovery = runWithProviderExecutionContext(legacy, () => strings.ensureModelStringsInitialized())
  assert.equal(profileRequests, 1)
  const writesDuringDiscovery = cacheWrites
  await runWithProviderExecutionContext(cloud, () => strings.ensureModelStringsInitialized())
  assert.equal(cacheWrites, writesDuringDiscovery)
  assert.equal(profileRequests, 1)
  const inferenceProfile = `eu.anthropic.${ALL_MODEL_CONFIGS[opusKey].firstParty}-fixture`
  releaseProfiles([inferenceProfile])
  await legacyDiscovery
  assert.equal(runWithProviderExecutionContext(legacy, () => strings.getModelStrings()[opusKey]), inferenceProfile)
  assert.equal(runWithProviderExecutionContext(cloud, () => strings.getModelStrings()[opusKey]), ALL_MODEL_CONFIGS[opusKey].bedrock)
  assert.equal(runWithProviderExecutionContext(local, () => strings.getModelStrings()[opusKey]), ALL_MODEL_CONFIGS[opusKey].openai)
  assert.equal(profileRequests, 1)
  console.log('provider model string checks passed')
} finally {
  releaseProfiles([])
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  rmSync(directory, { recursive: true, force: true })
}
