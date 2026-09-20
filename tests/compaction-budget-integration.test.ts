import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

test('compaction decisions and warning UI consume the model budget', () => {
  // Isolate app-boundary mocks and environment overrides from other suites.
  const result = spawnSync(process.execPath, [new URL('./fixtures/compaction-budget-checks.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).toBe('compaction budget checks passed\n')
  expect(result.status).toBe(0)
})
