import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('real message normalization preserves provider-native reasoning and keeps Claude orphan rules', () => {
  const directory = mkdtempSync(join(tmpdir(), 'free-code-native-history-'))
  try {
    const result = spawnSync(process.execPath, [new URL('./fixtures/provider-native-history-checks.ts', import.meta.url).pathname], {
      env: { PATH: process.env.PATH, USER_TYPE: 'external', CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      encoding: 'utf8', timeout: 30_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.stdout + result.stderr).toBe('native history checks passed\n')
    expect(result.status).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
