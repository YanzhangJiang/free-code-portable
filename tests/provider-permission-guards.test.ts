import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

test('provider permission guards preserve manual approval with classifier feature enabled', () => {
  // Run the real permission modules with the compile-time classifier feature on;
  // keep their peripheral mocks and user configuration out of other test suites.
  const result = spawnSync(process.execPath, [
    '--feature=TRANSCRIPT_CLASSIFIER',
    new URL('./fixtures/provider-permission-guards-checks.ts', import.meta.url).pathname,
  ], {
    env: { PATH: process.env.PATH, USER_TYPE: 'external' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).toBe('provider permission guards passed\n')
  expect(result.status).toBe(0)
})
