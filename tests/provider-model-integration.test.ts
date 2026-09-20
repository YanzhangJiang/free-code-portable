import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

test('configured models integrate with selection, budgets, capabilities, and pricing', () => {
  // Isolate module mocks from other provider tests, and exclude user credentials
  // and configuration from this integration process.
  const result = spawnSync(process.execPath, [new URL('./fixtures/provider-model-checks.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, USER_TYPE: 'external' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).toBe('provider model checks passed\n')
  expect(result.status).toBe(0)
})
