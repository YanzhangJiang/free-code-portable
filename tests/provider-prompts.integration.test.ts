import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

test('main and subagent prompts describe the selected provider and actual tools', () => {
  const result = spawnSync(process.execPath, [new URL('./fixtures/provider-prompt-checks.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, USER_TYPE: 'external' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).toBe('provider prompt checks passed\n')
  expect(result.status).toBe(0)
})
