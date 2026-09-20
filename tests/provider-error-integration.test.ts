import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

test('provider failures drive bounded retries and reactive-compaction messages', () => {
  const result = spawnSync(process.execPath, [new URL('./fixtures/provider-error-checks.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, USER_TYPE: 'external' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).toBe('provider error checks passed\n')
  expect(result.status).toBe(0)
})
