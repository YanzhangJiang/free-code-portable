import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

test('configured providers use the normal Agent reviewer without server advisor or settings writes', () => {
  const result = spawnSync(process.execPath, [new URL('./fixtures/provider-advisor-checks.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, USER_TYPE: 'external' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).toBe('provider advisor checks passed\n')
  expect(result.status).toBe(0)
})
