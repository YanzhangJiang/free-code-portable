import { describe, expect, test } from 'bun:test'
import { parseExternalServicesConfiguration } from './config.js'

describe('external services configuration', () => {
  test('empty configuration preserves legacy behavior', () => {
    expect(parseExternalServicesConfiguration({})).toEqual({})
  })
  test('search defaults and direct fetch parse independently of model providers', () => {
    expect(parseExternalServicesConfiguration({ webSearch: { provider: 'brave' }, webFetch: { mode: 'direct' } })).toEqual({
      webSearch: { provider: 'brave', baseURL: 'https://api.search.brave.com', apiKeyEnv: 'BRAVE_SEARCH_API_KEY', timeoutMs: 20_000, maxResults: 10 },
      webFetch: { mode: 'direct' },
    })
    expect(parseExternalServicesConfiguration({ webSearch: { provider: 'searxng', baseURL: 'http://127.0.0.1:8888' } }).webSearch?.provider).toBe('searxng')
  })
  test('invalid endpoints, credentials, ranges and unrecognized fields fail at configuration boundary', () => {
    for (const input of [
      { webSearch: { provider: 'other' } },
      { webSearch: { provider: 'searxng' } },
      { webSearch: { provider: 'brave', baseURL: 'http://search.example.com' } },
      { webSearch: { provider: 'brave', baseURL: 'https://user:secret@search.example.com' } },
      { webSearch: { provider: 'brave', baseURL: 'https://search.example.com?key=secret' } },
      { webSearch: { provider: 'brave', baseURL: 'https://search.example.com#' } },
      { webSearch: { provider: 'brave', baseURL: 'https://search.example.com?' } },
      { webSearch: { provider: 'brave', apiKey: 'secret' } },
      { webSearch: { provider: 'brave', apiKeyEnv: 'secret value' } },
      { webSearch: { provider: 'brave', maxResults: 0 } },
      { webSearch: { provider: 'brave', maxResults: 21 } },
      { webSearch: { provider: 'brave', timeoutMs: 0 } },
      { webFetch: { mode: 'anything' } },
      { providers: {} },
    ]) expect(() => parseExternalServicesConfiguration(input)).toThrow('Invalid external services configuration')
  })
  test('validation errors never print pasted key values', () => {
    try {
      parseExternalServicesConfiguration({ webSearch: { provider: 'brave', apiKey: 'PRIVATE-SECRET-VALUE' } })
      throw new Error('Expected validation failure')
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE-SECRET-VALUE')
    }
  })
})
