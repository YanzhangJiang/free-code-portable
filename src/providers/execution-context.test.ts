import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindProviderExecutionContext,
  getProviderExecutionContext,
  runWithProviderExecutionContext,
} from './execution-context.js'
import {
  createProviderExecutionContext,
  getActiveProviderProfile,
  getExecutionProviderProfile,
  initializeProviderRuntime,
  resolveExplicitProviderModel,
  resolveProviderCredentials,
  resolveProviderModel,
  resolveSessionProviderModel,
  selectProviderProfile,
} from './runtime.js'

const directory = mkdtempSync(join(tmpdir(), 'free-code-execution-context-'))
const configPath = join(directory, 'providers.json')
writeFileSync(configPath, JSON.stringify({
  providers: Object.fromEntries(['alpha', 'beta', 'unavailable'].map(id => [id, {
    api: 'openai-completions', baseURL: `https://${id}.example/v1`,
    apiKeyEnv: `${id.toUpperCase()}_KEY`, defaultModel: 'Main', smallModel: 'Small',
    models: [{ id: 'Main' }, { id: 'Small' }],
  }])),
}))

beforeEach(() => initializeProviderRuntime({
  configPath, provider: 'alpha', env: { ALPHA_KEY: 'alpha-key', BETA_KEY: 'beta-key' },
}))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('owned provider execution contexts', () => {
  test('concurrent agents and their helper models retain independent profiles after UI switches', async () => {
    const continueQueries = deferred()
    const agent = (model: string) => runWithProviderExecutionContext(
      createProviderExecutionContext(model), async () => {
        const before = resolveProviderModel('haiku')!
        await continueQueries.promise
        const after = resolveProviderModel('haiku')!
        expect(after.profile).toBe(before.profile)
        return {
          helper: after.qualifiedModel,
          profile: getExecutionProviderProfile()?.id,
          key: resolveProviderCredentials(after.profile).apiKey,
        }
      },
    )
    const alpha = agent('alpha/Main')
    const beta = agent('beta/Main')
    selectProviderProfile(undefined)
    continueQueries.resolve()
    expect(await Promise.all([alpha, beta])).toEqual([
      { helper: 'alpha/Small', profile: 'alpha', key: 'alpha-key' },
      { helper: 'beta/Small', profile: 'beta', key: 'beta-key' },
    ])
    expect(getProviderExecutionContext()).toBeUndefined()
    expect(getActiveProviderProfile()).toBeUndefined()
  })

  test('generator creation, advancement, errors, and early completion all enter the retained scope', async () => {
    const events: string[] = []
    const context = createProviderExecutionContext('alpha/Main')
    const iterator = bindProviderExecutionContext(context, () => {
      events.push(`create:${getExecutionProviderProfile()?.id}`)
      return (async function* () {
        try {
          events.push(`next:${getExecutionProviderProfile()?.id}`)
          yield resolveProviderModel('haiku')!.qualifiedModel
          await Promise.resolve()
          yield resolveProviderModel()!.qualifiedModel
        } catch (error) {
          events.push(`throw:${getExecutionProviderProfile()?.id}`)
          throw error
        } finally {
          events.push(`close:${getExecutionProviderProfile()?.id}`)
        }
      })()
    })
    selectProviderProfile('beta')
    expect(await iterator.next()).toEqual({ done: false, value: 'alpha/Small' })
    await iterator.return()
    expect(events).toEqual(['create:alpha', 'next:alpha', 'close:alpha'])
    expect(getProviderExecutionContext()).toBeUndefined()

    const failed = bindProviderExecutionContext(context, async function* () {
      try { yield 'first' } finally { events.push(`error-close:${getExecutionProviderProfile()?.id}`) }
    })
    await failed.next()
    await expect(failed.throw(new Error('consumer failure'))).rejects.toThrow('consumer failure')
    expect(events.at(-1)).toBe('error-close:alpha')
    expect(getExecutionProviderProfile()?.id).toBe('beta')
  })

  test('aborting an awaited request runs cleanup in its context without cancelling a sibling', async () => {
    const controller = new AbortController()
    const reachedWait = deferred()
    const events: string[] = []
    const alpha = bindProviderExecutionContext(createProviderExecutionContext('alpha/Main'), async function* () {
      try {
        yield 'started'
        reachedWait.resolve()
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(controller.signal.reason)
          controller.signal.addEventListener('abort', abort, { once: true })
        })
      } finally { events.push(`closed:${getExecutionProviderProfile()?.id}`) }
    })
    const beta = bindProviderExecutionContext(createProviderExecutionContext('beta/Main'), async function* () {
      yield resolveProviderModel('haiku')!.qualifiedModel
      return 'complete'
    })
    await alpha.next()
    const pending = alpha.next()
    await reachedWait.promise
    controller.abort(new Error('owned request aborted'))
    await expect(pending).rejects.toThrow('owned request aborted')
    expect(events).toEqual(['closed:alpha'])
    expect(await beta.next()).toEqual({ done: false, value: 'beta/Small' })
    expect(await beta.next()).toEqual({ done: true, value: 'complete' })
  })

  test('legacy scopes stay legacy while explicit qualified child models enter separate scopes', async () => {
    selectProviderProfile(undefined)
    const legacy = createProviderExecutionContext('claude-sonnet-4-6')
    selectProviderProfile('beta')
    await runWithProviderExecutionContext(legacy, async () => {
      await Promise.resolve()
      expect(getExecutionProviderProfile()).toBeUndefined()
      expect(resolveProviderModel('haiku')).toBeUndefined()
      expect(resolveSessionProviderModel('haiku')?.qualifiedModel).toBe('beta/Small')
      expect(createProviderExecutionContext()).toBe(legacy)
      const child = createProviderExecutionContext('alpha/Main')
      runWithProviderExecutionContext(child, () => {
        expect(resolveProviderModel('haiku')?.qualifiedModel).toBe('alpha/Small')
      })
      expect(getProviderExecutionContext()).toBe(legacy)
    })
    expect(getExecutionProviderProfile()?.id).toBe('beta')
  })

  test('captured profiles and credentials survive registry replacement, while invalid children fail atomically', async () => {
    const context = createProviderExecutionContext('alpha/Main')
    expect(Object.isFrozen(context)).toBe(true)
    expect(() => createProviderExecutionContext('unavailable/Main')).toThrow('UNAVAILABLE_KEY')
    expect(() => createProviderExecutionContext('beta/missing')).toThrow('not configured')
    expect(() => resolveExplicitProviderModel('beta/missing')).toThrow('not configured')
    expect(getActiveProviderProfile()?.id).toBe('alpha')
    initializeProviderRuntime({ configPath, provider: 'beta', env: { ALPHA_KEY: 'replacement', BETA_KEY: 'other' } })
    runWithProviderExecutionContext(context, () => {
      const resolved = resolveProviderModel('alpha/Main')!
      expect(resolveProviderCredentials(resolved.profile).apiKey).toBe('alpha-key')
      expect(resolveExplicitProviderModel('alpha/Small')?.profile).toBe(resolved.profile)
    })
  })
})
