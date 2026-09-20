import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

test('profile model strings stay isolated from legacy aliases and Bedrock discovery', () => {
  const result = spawnSync(process.execPath, [new URL('./fixtures/provider-model-strings-checks.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, USER_TYPE: 'external' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).toBe('provider model string checks passed\n')
  expect(result.status).toBe(0)
})
