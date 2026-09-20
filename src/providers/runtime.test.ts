import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findQualifiedProviderModel,
  getActiveProviderProfile,
  getProviderConfigPath,
  getProviderProfiles,
  getQualifiedModelId,
  hasLoadedProviderConfiguration,
  initializeProviderRuntime,
  resolveModelInProviderProfile,
  resolveProviderCredentials,
  resolveProviderModel,
  selectProviderForModel,
  selectProviderProfile,
} from './runtime.js'

const directory = mkdtempSync(join(tmpdir(), 'free-code-providers-'))
let fileNumber = 0

function writeConfiguration(configuration: unknown): string {
  const path = join(directory, `providers-${fileNumber++}.json`)
  writeFileSync(path, JSON.stringify(configuration))
  return path
}

const customProfile = (overrides: Record<string, unknown> = {}) => ({
  api: 'openai-completions',
  baseURL: 'https://models.example.test/v1',
  models: [{ id: 'Vendor/Model-V2' }, { id: 'small' }],
  defaultModel: 'Vendor/Model-V2',
  smallModel: 'small',
  ...overrides,
})

beforeEach(() => initializeProviderRuntime({ configPath: writeConfiguration({ providers: {} }), env: {} }))
afterAll(() => {
  initializeProviderRuntime({ env: { CLAUDE_CONFIG_DIR: join(directory, 'absent') } })
  rmSync(directory, { recursive: true, force: true })
})

describe('provider runtime selection', () => {
  test('keeps legacy behavior when the user configuration is absent', () => {
    initializeProviderRuntime({ env: { CLAUDE_CONFIG_DIR: directory } })
    expect(getProviderConfigPath()).toBe(join(directory, 'providers.json'))
    expect(getProviderProfiles()).toEqual([])
    expect(hasLoadedProviderConfiguration()).toBe(false)
    expect(getActiveProviderProfile()).toBeUndefined()
    expect(resolveProviderModel('legacy-cloud/model')).toBeUndefined()
  })

  test('tracks intentionally empty configuration files and preserves that state on failure', () => {
    const explicitPath = writeConfiguration({ providers: {} })
    initializeProviderRuntime({ configPath: explicitPath, env: {} })
    expect(hasLoadedProviderConfiguration()).toBe(true)
    expect(getProviderProfiles()).toEqual([])
    expect(() => initializeProviderRuntime({ configPath: join(directory, 'missing-loaded.json'), env: {} })).toThrow('Cannot read provider configuration')
    expect(hasLoadedProviderConfiguration()).toBe(true)
    expect(getProviderConfigPath()).toBe(explicitPath)
    const defaultDirectory = join(directory, 'empty-default-config')
    mkdirSync(defaultDirectory)
    writeFileSync(join(defaultDirectory, 'providers.json'), '{"providers":{}}')
    initializeProviderRuntime({ env: { CLAUDE_CONFIG_DIR: defaultDirectory } })
    expect(hasLoadedProviderConfiguration()).toBe(true)
    expect(getProviderProfiles()).toEqual([])
    initializeProviderRuntime({ env: { CLAUDE_CONFIG_DIR: join(directory, 'absent') } })
    expect(hasLoadedProviderConfiguration()).toBe(false)
  })

  test('an explicitly requested file must exist and JSON errors do not echo file contents', () => {
    expect(() => initializeProviderRuntime({ configPath: join(directory, 'missing.json'), env: {} })).toThrow('Cannot read provider configuration')
    expect(() => initializeProviderRuntime({ env: { FREE_CODE_PROVIDERS_FILE: join(directory, 'missing-env.json') } })).toThrow('Cannot read provider configuration')
    const invalidPath = join(directory, 'invalid.json')
    writeFileSync(invalidPath, '{"secret": "DO_NOT_PRINT_THIS_SECRET"')
    expect(() => initializeProviderRuntime({ configPath: invalidPath, env: {} })).toThrow('must contain valid JSON')
  })

  test('supports explicit path override without changing environment', () => {
    const configPath = writeConfiguration({ providers: { custom: customProfile() }, defaultProvider: 'custom' })
    const env = { FREE_CODE_PROVIDERS_FILE: configPath, CLAUDE_CONFIG_DIR: 'ignored' }
    const original = { ...env }
    initializeProviderRuntime({ env })
    expect(getProviderConfigPath()).toBe(configPath)
    expect(getActiveProviderProfile()?.id).toBe('custom')
    expect(env).toEqual(original)
  })

  test('qualified model takes precedence over explicit, environment, and configured provider', () => {
    const configPath = writeConfiguration({ defaultProvider: 'first', providers: { first: customProfile(), second: customProfile() } })
    initializeProviderRuntime({ configPath, provider: 'first', model: 'second/Vendor/Model-V2', env: { FREE_CODE_PROVIDER: 'first' } })
    expect(getActiveProviderProfile()?.id).toBe('second')
    expect(resolveProviderModel()?.qualifiedModel).toBe('second/Vendor/Model-V2')
    initializeProviderRuntime({ configPath, provider: 'legacy', env: { FREE_CODE_PROVIDER: 'first' } })
    expect(getActiveProviderProfile()).toBeUndefined()
  })

  test('keeps identical remote IDs distinct across providers and changes session only', () => {
    const configPath = writeConfiguration({ providers: { first: customProfile(), second: customProfile() } })
    initializeProviderRuntime({ configPath, provider: 'first', env: {} })
    expect(getQualifiedModelId('first', 'Vendor/Model-V2')).toBe('first/Vendor/Model-V2')
    expect(resolveProviderModel('Vendor/Model-V2')?.profile.id).toBe('first')
    expect(resolveProviderModel('second/Vendor/Model-V2')?.profile.id).toBe('second')
    expect(getActiveProviderProfile()?.id).toBe('first')
    selectProviderForModel('second/Vendor/Model-V2')
    expect(getActiveProviderProfile()?.id).toBe('second')
    selectProviderProfile(undefined)
    expect(getActiveProviderProfile()).toBeUndefined()
    expect(resolveProviderModel('first/Vendor/Model-V2')?.profile.id).toBe('first')
  })

  test('resolves legacy aliases and gives exact configured IDs precedence', () => {
    const configPath = writeConfiguration({ providers: { custom: customProfile() } })
    initializeProviderRuntime({ configPath, provider: 'custom', env: {} })
    for (const alias of ['default', 'sonnet', 'opus', 'best', 'opusplan', 'SONNET']) {
      expect(resolveProviderModel(alias)?.model.id).toBe('Vendor/Model-V2')
    }
    expect(resolveProviderModel('haiku')?.model.id).toBe('small')
    expect(resolveProviderModel(null)?.model.id).toBe('Vendor/Model-V2')
    const exactPath = writeConfiguration({ providers: { exact: customProfile({ models: [{ id: 'sonnet' }, { id: 'Vendor/Model-V2' }], smallModel: undefined }) } })
    initializeProviderRuntime({ configPath: exactPath, provider: 'exact', env: {} })
    expect(resolveProviderModel('sonnet')?.model.id).toBe('sonnet')
    expect(resolveProviderModel('haiku')?.model.id).toBe('Vendor/Model-V2')
    expect(resolveProviderModel('exact/sonnet')?.model.id).toBe('sonnet')
  })

  test('does not remap unknown models, case variants, or qualified aliases', () => {
    initializeProviderRuntime({ configPath: writeConfiguration({ providers: { custom: customProfile() } }), provider: 'custom', env: {} })
    for (const model of ['missing', 'vendor/model-v2', 'custom/missing', 'custom/sonnet', 'custom/']) {
      expect(() => resolveProviderModel(model)).toThrow('Model is not configured')
    }
    expect(getActiveProviderProfile()?.id).toBe('custom')
  })

  test('historical lookup finds exact qualified models without remapping legacy IDs', () => {
    initializeProviderRuntime({ configPath: writeConfiguration({ providers: { custom: customProfile() } }), provider: 'custom', env: {} })
    expect(findQualifiedProviderModel('custom/Vendor/Model-V2')?.model.id).toBe('Vendor/Model-V2')
    for (const historicalId of ['claude-sonnet-4-6', 'Vendor/Model-V2', 'haiku', 'custom/haiku', 'custom/missing', 'old/model', 'custom/']) {
      expect(findQualifiedProviderModel(historicalId)).toBeUndefined()
    }
    selectProviderProfile(undefined)
    expect(findQualifiedProviderModel('custom/small')?.qualifiedModel).toBe('custom/small')
  })

  test('resolves child models within their retained parent profile after a session switch', () => {
    initializeProviderRuntime({
      configPath: writeConfiguration({ providers: {
        first: customProfile(),
        second: customProfile({ models: [{ id: 'other' }], defaultModel: 'other', smallModel: undefined }),
      } }),
      provider: 'first',
      env: {},
    })
    const parent = resolveProviderModel()!
    selectProviderProfile('second')
    expect(resolveModelInProviderProfile(parent.profile, 'SONNET').qualifiedModel).toBe('first/Vendor/Model-V2')
    expect(resolveModelInProviderProfile(parent.profile, 'haiku').qualifiedModel).toBe('first/small')
    expect(resolveModelInProviderProfile(parent.profile, 'Vendor/Model-V2').qualifiedModel).toBe('first/Vendor/Model-V2')
    expect(resolveModelInProviderProfile(parent.profile, 'first/small').qualifiedModel).toBe('first/small')
    expect(() => resolveModelInProviderProfile(parent.profile, 'second/other')).toThrow('provider "first"')
    expect(() => resolveModelInProviderProfile(parent.profile, 'first/sonnet')).toThrow('Model is not configured')
    expect(getActiveProviderProfile()?.id).toBe('second')
    initializeProviderRuntime({ env: { CLAUDE_CONFIG_DIR: join(directory, 'absent') } })
    expect(resolveModelInProviderProfile(parent.profile).qualifiedModel).toBe('first/Vendor/Model-V2')
  })

  test('failed model or missing key selection leaves the old active provider intact', () => {
    const configPath = writeConfiguration({ providers: { first: customProfile(), second: customProfile({ apiKeyEnv: 'SECOND_KEY' }) } })
    initializeProviderRuntime({ configPath, provider: 'first', env: {} })
    expect(() => selectProviderForModel('second/missing')).toThrow('Model is not configured')
    expect(getActiveProviderProfile()?.id).toBe('first')
    expect(() => selectProviderForModel('second/Vendor/Model-V2')).toThrow('SECOND_KEY')
    expect(getActiveProviderProfile()?.id).toBe('first')
    expect(() => selectProviderProfile('second')).toThrow('SECOND_KEY')
    expect(getActiveProviderProfile()?.id).toBe('first')
    expect(() => selectProviderProfile('unknown')).toThrow('Unknown provider')
    expect(getActiveProviderProfile()?.id).toBe('first')
  })

  test('failed initialization preserves prior profiles and selection', () => {
    initializeProviderRuntime({ configPath: writeConfiguration({ providers: { first: customProfile() } }), provider: 'first', env: {} })
    const original = getActiveProviderProfile()
    expect(() => initializeProviderRuntime({ configPath: writeConfiguration({ providers: { second: customProfile({ apiKeyEnv: 'MISSING_KEY' }) } }), provider: 'second', env: {} })).toThrow('MISSING_KEY')
    expect(getActiveProviderProfile()).toBe(original)
    expect(() => initializeProviderRuntime({ configPath: writeConfiguration({ providers: { second: customProfile() } }), provider: 'second', model: 'wrong-model', env: {} })).toThrow('Model is not configured')
    expect(getActiveProviderProfile()).toBe(original)
  })

  test('retained request profiles keep immutable metadata and their own credential snapshot', () => {
    const configPath = writeConfiguration({ providers: { custom: customProfile({ apiKeyEnv: 'CUSTOM_KEY', headers: { 'X-Title': 'first' } }) } })
    const firstEnv = { CUSTOM_KEY: 'first-secret' }
    initializeProviderRuntime({ configPath, provider: 'custom', env: firstEnv })
    const first = resolveProviderModel()!
    expect(Object.isFrozen(first.profile)).toBe(true)
    expect(Object.isFrozen(first.profile.models)).toBe(true)
    expect(Object.isFrozen(first.model)).toBe(true)
    firstEnv.CUSTOM_KEY = 'later-mutation'
    const credentials = resolveProviderCredentials(first.profile)
    expect(credentials.apiKey).toBe('first-secret')
    credentials.headers!['X-Title'] = 'changed-copy'
    expect(resolveProviderCredentials(first.profile).headers!['X-Title']).toBe('first')
    initializeProviderRuntime({ configPath, provider: 'custom', env: { CUSTOM_KEY: 'second-secret' } })
    expect(resolveProviderCredentials(getActiveProviderProfile()!).apiKey).toBe('second-secret')
    expect(resolveProviderCredentials(first.profile).apiKey).toBe('first-secret')
    expect(() => resolveProviderCredentials({ ...first.profile })).toThrow('initialized provider runtime')
  })

  test('keyless local profiles can be selected without inheriting other environment credentials', () => {
    initializeProviderRuntime({ configPath: writeConfiguration({ providers: { local: customProfile({ baseURL: 'http://localhost:11434/v1' }) } }), provider: 'local', env: { OPENAI_API_KEY: 'unrelated-secret', ANTHROPIC_API_KEY: 'another-secret' } })
    expect(resolveProviderCredentials(getActiveProviderProfile()!).apiKey).toBeUndefined()
  })
})
