import { expect, test } from 'bun:test'
import { createCodexTokenSource } from './codex-token-refresh.js'

const expired = { accessToken: 'old', refreshToken: 'refresh-one', expiresAt: 100, accountId: 'one' }
const fresh = { ...expired, accessToken: 'new', refreshToken: 'refresh-new', expiresAt: 100_000 }

test('fresh credentials do not refresh; missing credentials fail before transport', async () => {
  let refreshes = 0
  const refresh = async () => { refreshes++; return fresh }
  const getFresh = createCodexTokenSource({ read: () => fresh, write: () => {}, refresh, now: () => 1000 })
  expect(await getFresh()).toBe(fresh)
  const missing = createCodexTokenSource({ read: () => null, write: () => {}, refresh, now: () => 1000 })
  await expect(missing()).rejects.toThrow('OAuth login')
  expect(refreshes).toBe(0)
})

test('concurrent expired requests join one refresh and failures can retry', async () => {
  let stored = expired
  let calls = 0
  const writes: string[] = []
  const source = createCodexTokenSource({
    read: () => stored,
    write: tokens => { stored = tokens; writes.push(tokens.accessToken) },
    refresh: async () => { calls++; await Promise.resolve(); if (calls === 1) throw new Error('temporary'); return fresh },
    now: () => 1000,
  })
  const failed = await Promise.allSettled([source(), source()])
  expect(failed.every(result => result.status === 'rejected')).toBe(true)
  expect(calls).toBe(1)
  expect(writes).toEqual([])
  expect(await Promise.all([source(), source()])).toEqual([fresh, fresh])
  expect(calls).toBe(2)
  expect(writes).toEqual(['new'])
})

test('account changes never join or overwrite another account refresh', async () => {
  let stored = expired
  const resolvers = new Map<string, (value: typeof fresh) => void>()
  const source = createCodexTokenSource({
    read: () => stored,
    write: tokens => { stored = tokens },
    refresh: token => new Promise(resolve => resolvers.set(token, resolve)),
    now: () => 1000,
  })
  const first = source()
  stored = { ...expired, accountId: 'two', refreshToken: 'refresh-two' }
  const second = source()
  resolvers.get('refresh-one')!(fresh)
  expect((await first).accountId).toBe('one')
  expect(stored.accountId).toBe('two')
  const freshTwo = { ...fresh, accountId: 'two', accessToken: 'two-access' }
  resolvers.get('refresh-two')!(freshTwo)
  expect(await second).toBe(freshTwo)
  expect(stored).toBe(freshTwo)
})
