import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppState } from '../state/AppStateStore.js'
import type { LocalJSXCommandCall } from '../types/command.js'

const directory = mkdtempSync(join(tmpdir(), 'free-code-local-plan-'))
let harness: typeof import('./localUltraplan.js') & {
  launchUltraplan: typeof import('./ultraplan.js').launchUltraplan
  setProfile: (value: boolean) => void
  effects: { transitions: string[][]; queued: unknown[]; cloudCalls: number }
  resetEffects: () => void
}

beforeAll(async () => {
  const localPath = resolve(import.meta.dir, 'localUltraplan.ts')
  const cloudPath = resolve(import.meta.dir, 'ultraplan.tsx')
  const output = await Bun.build({
    entrypoints: ['local-plan-test'], target: 'bun',
    plugins: [{ name: 'local-plan-adapters', setup(build) {
      build.onResolve({ filter: /^local-plan-test$/ }, () => ({ path: 'entry', namespace: 'local-plan' }))
      build.onResolve({ filter: /^local-plan-effects$/ }, () => ({ path: 'effects', namespace: 'local-plan' }))
      build.onResolve({ filter: /^\.\./ }, args => {
        if (args.importer === localPath || args.importer === cloudPath) return { path: args.path.endsWith('.txt') ? 'prompt' : 'effects', namespace: 'local-plan' }
      })
      build.onLoad({ filter: /.*/, namespace: 'local-plan' }, args => ({ loader: 'ts', contents: args.path === 'entry'
        ? `export * from ${JSON.stringify(localPath)}; export {launchUltraplan} from ${JSON.stringify(cloudPath)}; export * from 'local-plan-effects';`
        : args.path === 'prompt' ? `export default 'Hosted planning instructions';` : `
          let active = true;
          export function setProfile(value) { active = value; }
          export function getActiveProviderProfile() { return active ? {id:'test'} : undefined; }
          export const effects = {transitions:[],queued:[],cloudCalls:0};
          export function resetEffects() { effects.transitions=[];effects.queued=[];effects.cloudCalls=0;active=true; }
          export function handlePlanModeTransition(from,to) { effects.transitions.push([from,to]); }
          export function prepareContextForPlanMode(value) { return {...value,prePlanMode:value.mode}; }
          export function applyPermissionUpdate(value,update) { return {...value,mode:update.mode}; }
          export function enqueuePendingNotification(value) { effects.queued.push(value); }
          export const REMOTE_CONTROL_DISCONNECTED_MSG = 'disconnected';
          export const DIAMOND_OPEN = 'diamond';
          export function getRemoteSessionUrl() { throw Error('Unexpected cloud URL'); }
          export function getFeatureValue_CACHED_MAY_BE_STALE(_,fallback) { return fallback; }
          export function logEvent() {}
          export function checkRemoteAgentEligibility() { effects.cloudCalls++; throw Error('Unexpected cloud eligibility'); }
          export function formatPreconditionError(value) { return String(value); }
          export const RemoteAgentTask = {};
          export function registerRemoteAgentTask() { throw Error('Unexpected cloud task'); }
          export function logForDebugging() {}
          export function errorMessage(value) { return String(value); }
          export function logError() {}
          export const ALL_MODEL_CONFIGS = {opus46:{firstParty:'claude-test'}};
          export function updateTaskState() { throw Error('Unexpected cloud task mutation'); }
          export function archiveRemoteSession() { throw Error('Unexpected cloud archive'); }
          export function teleportToRemote() { effects.cloudCalls++; throw Error('Unexpected teleport'); }
          export function pollForApprovedExitPlanMode() { effects.cloudCalls++; throw Error('Unexpected cloud poll'); }
          export class UltraplanPollError extends Error {}
        ` }))
    } }],
  })
  if (!output.success) throw new Error(output.logs.map(log => log.message).join('\n'))
  const path = join(directory, 'harness.mjs')
  await Bun.write(path, output.outputs[0]!)
  harness = await import(pathToFileURL(path).href)
})
beforeEach(() => harness.resetEffects())
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function context(mode = 'default') {
  let state = { toolPermissionContext: { mode, alwaysAllowRules: { userSettings: ['Read'] } }, tasks: {} } as unknown as AppState
  return {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: (state: AppState) => AppState) => { state = update(state) },
  }
}

test('local command enters plan mode and supplies an executable planning prompt', async () => {
  const ctx = context('acceptEdits')
  const results: unknown[][] = []
  await harness.call((...args) => results.push(args), ctx as Parameters<LocalJSXCommandCall>[1], 'Improve caching')
  expect(ctx.getAppState().toolPermissionContext.mode).toBe('plan')
  expect(ctx.getAppState().toolPermissionContext.prePlanMode).toBe('acceptEdits')
  expect(ctx.getAppState().toolPermissionContext.alwaysAllowRules).toEqual({ userSettings: ['Read'] })
  expect(harness.effects.transitions).toEqual([['acceptEdits', 'plan']])
  const [message, options] = results[0] as [string, { shouldQuery: boolean; metaMessages: string[] }]
  expect(message).toContain('this machine')
  expect(options.shouldQuery).toBe(true)
  expect(options.metaMessages[0]).toContain('Improve caching')
  expect(options.metaMessages[0]).toContain('Explore and Plan subagents')
  expect(options.metaMessages[0]).toContain('ExitPlanMode')
  expect(harness.effects.cloudCalls).toBe(0)
})

test('usage and cancelled commands do not mutate permission state or query', async () => {
  for (const cancelled of [false, true]) {
    const ctx = context()
    if (cancelled) ctx.abortController.abort()
    let options: { shouldQuery?: boolean } | undefined
    await harness.call((_message, value) => { options = value }, ctx as Parameters<LocalJSXCommandCall>[1], cancelled ? 'Explore' : '  ')
    expect(options?.shouldQuery).toBe(false)
    expect(ctx.getAppState().toolPermissionContext.mode).toBe('default')
  }
  expect(harness.effects.transitions).toEqual([])
})

test('refinement preserves an existing plan permission context and includes the draft', () => {
  const ctx = context('plan')
  const previous = ctx.getAppState().toolPermissionContext
  const result = harness.prepareLocalUltraplan({ ...ctx, blurb: 'Compare alternatives', seedPlan: 'Existing draft', signal: ctx.abortController.signal })
  expect(ctx.getAppState().toolPermissionContext).toBe(previous)
  expect(result.prompt).toContain('Existing draft')
  expect(result.prompt).toContain('Compare alternatives')
  expect(harness.effects.transitions).toEqual([])
})

test('memoized command resolves routing and description after every provider switch', async () => {
  const cloudCall: LocalJSXCommandCall = async () => null
  const command = harness.createUltraplanCommand({ description: 'Cloud planning', load: async () => ({ call: cloudCall }) })
  if (command.type !== 'local-jsx') throw Error('Unexpected command type')
  expect(command.description).toContain('this machine')
  expect((await command.load()).call).toBe(harness.call)
  harness.setProfile(false)
  expect(command.description).toBe('Cloud planning')
  expect((await command.load()).call).toBe(cloudCall)
  const withoutCloud = harness.createUltraplanCommand(null)
  expect(withoutCloud.isEnabled?.()).toBe(false)
  harness.setProfile(true)
  expect(withoutCloud.isEnabled?.()).toBe(true)
})

test('shared launch entry routes a seeded profile plan locally before all cloud work', async () => {
  const ctx = context()
  const message = await harness.launchUltraplan({ ...ctx, blurb: '', seedPlan: 'Refine draft', signal: ctx.abortController.signal })
  expect(message).toContain('this machine')
  expect(ctx.getAppState().toolPermissionContext.mode).toBe('plan')
  expect(harness.effects.cloudCalls).toBe(0)
  expect(harness.effects.queued).toHaveLength(1)
  expect(harness.effects.queued[0]).toMatchObject({ mode: 'prompt', isMeta: true, priority: 'next', skipSlashCommands: true })
  expect(JSON.stringify(harness.effects.queued[0])).toContain('Refine draft')
  expect(ctx.getAppState().ultraplanLaunching).toBeUndefined()
  expect(ctx.getAppState().ultraplanSessionUrl).toBeUndefined()
})
