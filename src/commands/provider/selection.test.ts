import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const directory = mkdtempSync(join(tmpdir(), 'free-code-provider-selection-'))
const configPath = join(directory, 'providers.json')
let harness: {
  initializeProviderRuntime: typeof import('../../providers/runtime.js').initializeProviderRuntime
  getActiveProviderProfile: typeof import('../../providers/runtime.js').getActiveProviderProfile
  selectSessionProvider: typeof import('./selection.js').selectSessionProvider
  selectSessionModel: typeof import('./selection.js').selectSessionModel
  handleServerControlRequest: typeof import('../../bridge/bridgeMessaging.js').handleServerControlRequest
  effects: { modelOverride: string | null; modelStrings: unknown; betas: number; schemas: number; validation: number }
  resetEffects: () => void
  setAllowedModels: (models: string[] | undefined) => void
}

beforeAll(async () => {
  // Bundle just this boundary with observable cache adapters. Module mocks would
  // otherwise leak into the real runtime tests in the same Bun test process.
  const selectionPath = resolve(import.meta.dir, 'selection.ts')
  const runtimePath = resolve(import.meta.dir, '../../providers/runtime.ts')
  const bridgeMessagingPath = resolve(import.meta.dir, '../../bridge/bridgeMessaging.ts')
  const output = await Bun.build({
    entrypoints: ['provider-selection-test'],
    target: 'bun',
    plugins: [{
      name: 'selection-test-adapters',
      setup(build) {
        build.onResolve({ filter: /^provider-selection-test$/ }, () => ({ path: 'entry', namespace: 'selection-test' }))
        build.onResolve({ filter: /^selection-test-effects$/ }, () => ({ path: 'effects', namespace: 'selection-test' }))
        build.onResolve({ filter: /(?:bootstrap\/state|utils\/betas|utils\/model\/(?:validateModel|modelAllowlist)|utils\/toolSchemaCache)\.js$/ }, args => {
          if (args.importer === selectionPath) return { path: 'effects', namespace: 'selection-test' }
        })
        build.onResolve({ filter: /^\.\.\// }, args => {
          if (args.importer === bridgeMessagingPath) return { path: 'effects', namespace: 'selection-test' }
        })
        build.onLoad({ filter: /.*/, namespace: 'selection-test' }, args => ({
          contents: args.path === 'entry'
            ? `export * from ${JSON.stringify(selectionPath)}; export * from ${JSON.stringify(runtimePath)}; export { handleServerControlRequest } from ${JSON.stringify(bridgeMessagingPath)}; export * from 'selection-test-effects';`
            : `
              export const effects = {};
              export function resetEffects() { Object.assign(effects, { modelOverride: null, modelStrings: 'cached', betas: 0, schemas: 0, validation: 0 }); }
              export function setMainLoopModelOverride(value) { effects.modelOverride = value; }
              export function setModelStrings(value) { effects.modelStrings = value; }
              export function clearBetasCaches() { effects.betas++; }
              export function clearToolSchemaCache() { effects.schemas++; }
              export function clearModelValidationCache() { effects.validation++; }
              let allowedModels;
              export function setAllowedModels(models) { allowedModels = models; }
              export function isModelAllowed(model) { return allowedModels === undefined || allowedModels.includes(model); }
              export function logEvent() {}
              export const EMPTY_USAGE = {};
              export function normalizeControlMessageKeys(value) { return value; }
              export function logForDebugging() {}
              export function stripDisplayTagsAllowEmpty(value) { return value; }
              export function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
              export const jsonParse = JSON.parse;
            `,
          loader: 'ts',
        }))
      },
    }],
  })
  if (!output.success) throw new Error(output.logs.map(log => log.message).join('\n'))
  const bundlePath = join(directory, 'selection.mjs')
  await Bun.write(bundlePath, output.outputs[0]!)
  harness = await import(pathToFileURL(bundlePath).href)
  writeFileSync(configPath, JSON.stringify({
    providers: {
      alpha: { api: 'openai-completions', baseURL: 'https://alpha.example/v1', apiKeyEnv: 'ALPHA_KEY', defaultModel: 'SameModel', models: [{ id: 'SameModel' }] },
      beta: { api: 'openai-responses', baseURL: 'https://beta.example/v1', apiKeyEnv: 'BETA_KEY', defaultModel: 'SameModel', models: [{ id: 'SameModel' }, { id: 'Org/CaseSensitive' }] },
      unavailable: { api: 'anthropic', baseURL: 'https://unavailable.example', apiKeyEnv: 'UNSET_KEY', defaultModel: 'SameModel', models: [{ id: 'SameModel' }] },
    },
  }))
})

beforeEach(() => {
  harness.initializeProviderRuntime({ configPath, env: { ALPHA_KEY: 'alpha-test', BETA_KEY: 'beta-test' } })
  harness.resetEffects()
  harness.setAllowedModels(undefined)
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('session provider selection', () => {
  test('selects the default model and clears provider-sensitive caches', () => {
    expect(harness.selectSessionProvider('alpha')).toEqual({ model: 'alpha/SameModel', label: 'alpha' })
    expect(harness.getActiveProviderProfile()?.id).toBe('alpha')
    expect(harness.effects).toEqual({ modelOverride: 'alpha/SameModel', modelStrings: null, betas: 1, schemas: 1, validation: 1 })
  })

  test('missing credentials preserve the provider, override, and caches', () => {
    harness.selectSessionProvider('alpha')
    const previousEffects = { ...harness.effects }
    expect(() => harness.selectSessionProvider('unavailable')).toThrow('UNSET_KEY')
    expect(harness.getActiveProviderProfile()?.id).toBe('alpha')
    expect(harness.effects).toEqual(previousEffects)
  })

  test('unknown providers and models preserve the selection', () => {
    harness.selectSessionProvider('alpha')
    expect(() => harness.selectSessionProvider('missing')).toThrow('Unknown provider')
    expect(() => harness.selectSessionModel('beta/missing')).toThrow('not configured')
    expect(harness.getActiveProviderProfile()?.id).toBe('alpha')
    expect(harness.effects.modelOverride).toBe('alpha/SameModel')
  })

  test('qualified models switch providers and retain case-sensitive remote IDs', () => {
    harness.selectSessionProvider('alpha')
    expect(harness.selectSessionModel('beta/Org/CaseSensitive')).toBe('beta/Org/CaseSensitive')
    expect(harness.getActiveProviderProfile()?.id).toBe('beta')
    expect(harness.effects.betas).toBe(2)
  })

  test('default remains on the current provider and legacy clears its override', () => {
    harness.selectSessionProvider('beta')
    expect(harness.selectSessionModel(null)).toBeNull()
    expect(harness.getActiveProviderProfile()?.id).toBe('beta')
    expect(harness.effects.betas).toBe(1)
    expect(harness.selectSessionProvider(undefined).model).toBeNull()
    expect(harness.getActiveProviderProfile()).toBeUndefined()
    expect(harness.effects.modelOverride).toBeNull()
    expect(harness.selectSessionModel('sonnet')).toBe('sonnet')
  })

  test('running and pending agents retain owned scopes and do not block UI selection', () => {
    harness.selectSessionProvider('alpha')
    const tasks = {
      worker: { type: 'local_agent', status: 'running' },
      remote: { type: 'remote_agent', status: 'pending' },
      shell: { type: 'local_bash', status: 'running' },
    } as const
    expect(harness.selectSessionProvider('beta', tasks).model).toBe('beta/SameModel')
    expect(harness.selectSessionProvider(undefined, tasks).model).toBeNull()
    expect(harness.selectSessionModel('alpha/SameModel', tasks)).toBe('alpha/SameModel')
    expect(harness.getActiveProviderProfile()?.id).toBe('alpha')
  })

  test('provider and model commands cannot select a policy-blocked model', () => {
    harness.selectSessionProvider('alpha')
    harness.setAllowedModels(['alpha/SameModel'])
    const previousEffects = { ...harness.effects }
    expect(() => harness.selectSessionProvider('beta')).toThrow('organization restricts model selection')
    expect(() => harness.selectSessionModel('beta/SameModel')).toThrow('organization restricts model selection')
    expect(harness.getActiveProviderProfile()?.id).toBe('alpha')
    expect(harness.effects).toEqual(previousEffects)
    expect(harness.selectSessionModel('SameModel')).toBe('alpha/SameModel')
  })

  test('defaults and aliases obey the resolved qualified-model policy', () => {
    harness.selectSessionProvider('beta')
    harness.setAllowedModels(['beta/Org/CaseSensitive'])
    const previousEffects = { ...harness.effects }
    expect(() => harness.selectSessionModel(null)).toThrow('beta/SameModel')
    expect(() => harness.selectSessionModel('sonnet')).toThrow('beta/SameModel')
    expect(() => harness.selectSessionModel('SameModel')).toThrow('beta/SameModel')
    expect(harness.effects).toEqual(previousEffects)
    expect(harness.selectSessionModel('Org/CaseSensitive')).toBe('beta/Org/CaseSensitive')
  })

  test('an empty model allowlist denies all explicit selections', () => {
    harness.setAllowedModels([])
    expect(() => harness.selectSessionProvider('alpha')).toThrow('organization restricts model selection')
    expect(() => harness.selectSessionModel('alpha/SameModel')).toThrow('organization restricts model selection')
    expect(() => harness.selectSessionModel('sonnet')).toThrow('organization restricts model selection')
    expect(harness.getActiveProviderProfile()).toBeUndefined()
    expect(harness.effects.betas).toBe(0)
  })

  test('remote model rejection sends an error response and leaves provider and UI unchanged', () => {
    harness.selectSessionProvider('alpha')
    const previousEffects = { ...harness.effects }
    const replies: unknown[] = []
    let currentModel = 'alpha/SameModel'
    const transport = { write: async (reply: unknown) => { replies.push(reply) } }
    harness.handleServerControlRequest({
      type: 'control_request', request_id: 'remote-change',
      request: { subtype: 'set_model', model: 'unavailable/SameModel' },
    }, {
      transport: transport as Parameters<typeof harness.handleServerControlRequest>[1]['transport'],
      sessionId: 'session-test',
      onSetModel: model => { currentModel = harness.selectSessionModel(model ?? null)! },
    })
    expect(replies).toEqual([{
      type: 'control_response', session_id: 'session-test',
      response: {
        subtype: 'error', request_id: 'remote-change',
        error: 'Provider "unavailable" requires environment variable UNSET_KEY. Set it before starting Free Code.',
      },
    }])
    expect(currentModel).toBe('alpha/SameModel')
    expect(harness.getActiveProviderProfile()?.id).toBe('alpha')
    expect(harness.effects).toEqual(previousEffects)
  })

  test('remote model success is acknowledged and a missing callback is rejected', () => {
    const replies: Array<{ response: { subtype: string; request_id: string; error?: string } }> = []
    const transport = { write: async (reply: typeof replies[number]) => { replies.push(reply) } }
    const request = {
      type: 'control_request', request_id: 'remote-change',
      request: { subtype: 'set_model', model: 'beta/SameModel' },
    } as const
    const handlers = {
      transport: transport as Parameters<typeof harness.handleServerControlRequest>[1]['transport'],
      sessionId: 'session-test',
    }
    harness.handleServerControlRequest(request, {
      ...handlers,
      onSetModel: model => { harness.selectSessionModel(model ?? null) },
    })
    expect(replies[0]?.response).toEqual({ subtype: 'success', request_id: 'remote-change' })
    expect(harness.getActiveProviderProfile()?.id).toBe('beta')
    harness.handleServerControlRequest(request, handlers)
    expect(replies[1]?.response.subtype).toBe('error')
    expect(replies[1]?.response.error).toContain('callback not registered')
  })
})
