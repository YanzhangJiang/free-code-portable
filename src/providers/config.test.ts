import { describe, expect, test } from 'bun:test'
import { parseProviderConfiguration } from './config.js'

const profile = (overrides: Record<string, unknown> = {}) => ({
  api: 'openai-completions',
  baseURL: 'https://models.example.test/v1',
  models: [{ id: 'Vendor/Model-V2' }],
  defaultModel: 'Vendor/Model-V2',
  ...overrides,
})

describe('provider configuration boundary', () => {
  test('applies capability defaults and preserves case and model slashes', () => {
    const input = { providers: { custom: profile() } }
    const parsed = parseProviderConfiguration(input)
    expect(parsed.providers.custom.models).toEqual([{
      id: 'Vendor/Model-V2',
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      vision: false,
      reasoning: false,
    }])
    expect(input.providers.custom.models).toEqual([{ id: 'Vendor/Model-V2' }])
  })

  test('permits the same remote model under independent profiles', () => {
    const parsed = parseProviderConfiguration({ providers: { first: profile(), second: profile() } })
    expect(Object.keys(parsed.providers)).toEqual(['first', 'second'])
  })

  test.each(['legacy', 'with/slash', '', '_prefix', 'with space'])('rejects invalid or reserved profile ID %s', id => {
    expect(() => parseProviderConfiguration({ providers: { [id]: profile() } })).toThrow()
  })

  test.each([
    'http://localhost:8080/v1',
    'http://127.0.0.1:11434/v1',
    'http://127.2.3.4/v1',
    'http://[::1]:8080/v1',
    'https://remote.example.test/custom/v1',
  ])('accepts endpoint %s', baseURL => {
    expect(parseProviderConfiguration({ providers: { custom: profile({ baseURL }) } }).providers.custom.baseURL).toBe(baseURL)
  })

  test.each([
    'http://remote.example.test/v1',
    'http://localhost.example.test/v1',
    'http://192.168.1.2/v1',
    'https://user:secret@example.test/v1',
    'https://example.test/v1?api_key=secret',
    'https://example.test/v1#secret',
    'file:///tmp/model',
    'invalid-endpoint',
  ])('rejects unsafe or malformed endpoint %s', baseURL => {
    expect(() => parseProviderConfiguration({ providers: { custom: profile({ baseURL }) } })).toThrow('Use HTTPS')
  })

  test.each(['anthropic', 'openai-completions', 'openai-responses'])('requires an explicit endpoint for %s', api => {
    expect(() => parseProviderConfiguration({ providers: { custom: profile({ api, baseURL: undefined }) } })).toThrow('baseURL is required')
  })

  test.each(['codex', 'bedrock', 'vertex', 'foundry'])('keeps %s credentials and endpoint on its existing path', api => {
    expect(parseProviderConfiguration({ providers: { cloud: profile({ api, baseURL: undefined }) } }).providers.cloud.api).toBe(api)
    for (const overrides of [{ baseURL: 'https://remote.example.test' }, { apiKeyEnv: 'SOME_KEY' }, { headers: { 'X-Label': 'label' } }]) {
      expect(() => parseProviderConfiguration({ providers: { cloud: profile({ api, baseURL: undefined, ...overrides }) } })).toThrow('existing OAuth or cloud credentials')
    }
  })

  test.each(['Authorization', 'authorization', 'X-API-KEY', 'Proxy-Authorization', 'Cookie'])('rejects embedded credential header %s', name => {
    expect(() => parseProviderConfiguration({ providers: { custom: profile({ headers: { [name]: 'super-secret' } }) } })).toThrow('apiKeyEnv')
  })

  test('allows ordinary headers and rejects HTTP line injection', () => {
    expect(parseProviderConfiguration({ providers: { custom: profile({ headers: { 'X-Title': 'Free Code' } }) } }).providers.custom.headers).toEqual({ 'X-Title': 'Free Code' })
    expect(() => parseProviderConfiguration({ providers: { custom: profile({ headers: { 'X-Title': 'value\r\nAuthorization: secret' } }) } })).toThrow()
  })

  test('checks provider/model references and duplicate model declarations', () => {
    expect(() => parseProviderConfiguration({ defaultProvider: 'missing', providers: { custom: profile() } })).toThrow('declared in providers')
    expect(() => parseProviderConfiguration({ providers: { custom: profile({ defaultModel: 'missing' }) } })).toThrow('declared in this provider')
    expect(() => parseProviderConfiguration({ providers: { custom: profile({ smallModel: 'missing' }) } })).toThrow('declared in this provider')
    expect(() => parseProviderConfiguration({ providers: { custom: profile({ models: [{ id: 'same' }, { id: 'same' }], defaultModel: 'same' }) } })).toThrow('unique')
  })

  test('checks token and price boundaries', () => {
    for (const model of [
      { contextWindow: 0 },
      { contextWindow: -1 },
      { contextWindow: 0.5 },
      { contextWindow: 4096, maxOutputTokens: 8192 },
      { maxOutputTokens: Number.POSITIVE_INFINITY },
      { cost: { input: -1, output: 0 } },
    ]) {
      expect(() => parseProviderConfiguration({ providers: { custom: profile({ models: [{ id: 'Vendor/Model-V2', ...model }] }) } })).toThrow()
    }
  })

  test('only Messages-protocol models opt into explicit prompt caching', () => {
    for (const api of ['anthropic', 'bedrock', 'vertex', 'foundry']) {
      const parsed = parseProviderConfiguration({ providers: { cached: profile({
        api,
        baseURL: api === 'anthropic' ? 'https://messages.example.test' : undefined,
        models: [{ id: 'Vendor/Model-V2', promptCaching: 'ephemeral' }],
      }) } })
      expect(parsed.providers.cached.models[0].promptCaching).toBe('ephemeral')
    }
    for (const api of ['openai-completions', 'openai-responses', 'codex']) {
      expect(() => parseProviderConfiguration({ providers: { cached: profile({
        api, baseURL: api === 'codex' ? undefined : 'https://models.example.test/v1',
        models: [{ id: 'Vendor/Model-V2', promptCaching: 'ephemeral' }],
      }) } })).toThrow('Messages-protocol')
    }
  })

  test('rejects misspelled fields and never includes secret values in errors', () => {
    for (const overrides of [
      { apiKey: 'DO_NOT_PRINT_THIS_SECRET' },
      { apiKeyEnv: 'DO_NOT_PRINT_THIS_SECRET?invalid' },
      { baseURL: 'https://user:DO_NOT_PRINT_THIS_SECRET@example.test' },
      { headers: { Authorization: 'DO_NOT_PRINT_THIS_SECRET' } },
    ]) {
      let message = ''
      try { parseProviderConfiguration({ providers: { custom: profile(overrides) } }) } catch (error) { message = (error as Error).message }
      expect(message).toContain('Invalid provider configuration')
      expect(message).not.toContain('DO_NOT_PRINT_THIS_SECRET')
    }
  })
})
