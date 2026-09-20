import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getExternalServices, getExternalServicesConfig, initializeExternalServices, resolveExternalServiceCredentials } from './runtime.js'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'external-services-')) })
afterEach(() => {
  initializeExternalServices({ env: { CLAUDE_CONFIG_DIR: directory } })
  rmSync(directory, { recursive: true, force: true })
})
function configuration(input: unknown): string {
  const file = join(directory, 'config.json')
  writeFileSync(file, JSON.stringify(input))
  return file
}

describe('external service session snapshots', () => {
  test('missing default file is legacy and missing explicit file is actionable', () => {
    initializeExternalServices({ env: { CLAUDE_CONFIG_DIR: directory } })
    expect(getExternalServices().configPath).toBe(join(directory, 'services.json'))
    expect(getExternalServices().configurationLoaded).toBe(false)
    expect(getExternalServicesConfig()).toEqual({})
    expect(() => initializeExternalServices({ configPath: join(directory, 'absent.json'), env: {} })).toThrow('Cannot read')
  })
  test('environment file override and explicit path precedence are supported', () => {
    const file = configuration({ webFetch: { mode: 'direct' } })
    initializeExternalServices({ env: { FREE_CODE_SERVICES_FILE: file } })
    expect(getExternalServices().configurationLoaded).toBe(true)
    initializeExternalServices({ configPath: file, env: { FREE_CODE_SERVICES_FILE: '/missing/services.json' } })
    expect(getExternalServicesConfig().webFetch?.mode).toBe('direct')
  })
  test('credential snapshots do not change with environment or reinitialization', () => {
    const file = configuration({ webSearch: { provider: 'brave', apiKeyEnv: 'SEARCH_KEY' } })
    const env = { SEARCH_KEY: 'first-secret' }
    initializeExternalServices({ configPath: file, env })
    const retained = getExternalServicesConfig().webSearch!
    expect(retained.provider).toBe('brave')
    if (retained.provider !== 'brave') throw new Error('Expected Brave')
    expect(Object.isFrozen(retained)).toBe(true)
    expect(JSON.stringify(getExternalServices())).not.toContain('first-secret')
    env.SEARCH_KEY = 'second-secret'
    expect(resolveExternalServiceCredentials(retained).apiKey).toBe('first-secret')
    initializeExternalServices({ configPath: file, env })
    expect(resolveExternalServiceCredentials(retained).apiKey).toBe('first-secret')
    const current = getExternalServicesConfig().webSearch!
    if (current.provider !== 'brave') throw new Error('Expected Brave')
    expect(resolveExternalServiceCredentials(current).apiKey).toBe('second-secret')
  })
  test('missing credentials fail when the service is used and cannot be supplied by a forged config', () => {
    initializeExternalServices({ configPath: configuration({ webSearch: { provider: 'brave' } }), env: {} })
    const service = getExternalServicesConfig().webSearch!
    if (service.provider !== 'brave') throw new Error('Expected Brave')
    expect(() => resolveExternalServiceCredentials(service)).toThrow('BRAVE_SEARCH_API_KEY')
    expect(() => resolveExternalServiceCredentials({ apiKeyEnv: 'OTHER' })).toThrow('not owned')
  })
  test('failed parsing preserves the prior session and redacts values', () => {
    const file = configuration({ webFetch: { mode: 'direct' } })
    initializeExternalServices({ configPath: file, env: {} })
    const prior = getExternalServices()
    writeFileSync(file, '{broken: PRIVATE_VALUE')
    expect(() => initializeExternalServices({ configPath: file, env: {} })).toThrow('valid JSON')
    expect(getExternalServices()).toBe(prior)
    writeFileSync(file, JSON.stringify({ webFetch: { mode: 'private-value' } }))
    expect(() => initializeExternalServices({ configPath: file, env: {} })).toThrow('webFetch.mode')
    expect(getExternalServices()).toBe(prior)
  })
})
