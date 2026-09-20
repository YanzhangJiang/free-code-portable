import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

test('voice service routes independently of Anthropic and owns microphone cancellation', () => {
  // Isolate auth/audio/process mocks from other tests; never access real audio
  // hardware or inherit the developer's provider/service credentials.
  const result = spawnSync(process.execPath, [new URL('./fixtures/portable-voice-checks.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, USER_TYPE: 'external' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).toBe('portable voice checks passed\n')
  expect(result.status).toBe(0)
})
