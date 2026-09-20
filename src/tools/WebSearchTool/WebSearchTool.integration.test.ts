import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

test('WebSearch uses configured services with original permission/output contracts and no model call', () => {
  const result = spawnSync(process.execPath, [new URL('./search-tool.fixture.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stdout + result.stderr).toBe('portable search tool checks passed\n')
})
