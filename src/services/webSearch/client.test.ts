import { describe, expect, test } from 'bun:test'
import { createWebSearchClient, normalizeSearchDomain, type SearchTransport } from './client.js'

const searxng = { provider: 'searxng' as const, baseURL: 'http://127.0.0.1:8888', timeoutMs: 500, maxResults: 10 }
const brave = { provider: 'brave' as const, baseURL: 'https://api.search.brave.com', apiKeyEnv: 'SEARCH_KEY', timeoutMs: 500, maxResults: 10 }
const signal = () => new AbortController().signal
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('portable web search', () => {
  test('SearXNG wire format and exact domain filtering do not require a model or a key', async () => {
    let requestURL: URL | undefined
    let requestOptions: RequestInit | undefined
    const client = createWebSearchClient(searxng, { fetch: async (url, init) => {
      requestURL = new URL(url)
      requestOptions = init
      return json({ results: [
        { title: 'Root', url: 'https://example.com/a', content: 'First excerpt' },
        { title: 'Docs', url: 'https://docs.example.com/b', content: 'Second excerpt' },
        { title: 'Wrong', url: 'https://notexample.com/a', content: 'Not allowed' },
        { title: 'Duplicate', url: 'https://example.com/a' },
        { title: 'Bad protocol', url: 'file:///etc/passwd' },
        { title: 'Credential URL', url: 'https://secret@example.com/private' },
        { title: 'Oversized URL', url: `https://example.com/${'a'.repeat(2000)}` },
      ] })
    } })
    const hits = await client.search({ query: 'TypeScript', allowedDomains: ['EXAMPLE.COM.'], limit: 2, signal: signal() })
    expect(requestURL?.pathname).toBe('/search')
    expect(requestURL?.searchParams.get('format')).toBe('json')
    expect(requestURL?.searchParams.get('q')).toBe('TypeScript (site:example.com)')
    expect(requestOptions?.redirect).toBe('error')
    expect(new Headers(requestOptions?.headers).has('authorization')).toBe(false)
    expect(hits).toEqual([
      { title: 'Root', url: 'https://example.com/a', snippet: 'First excerpt' },
      { title: 'Docs', url: 'https://docs.example.com/b', snippet: 'Second excerpt' },
    ])
  })

  test('Brave pins its own token and includes excerpts without leaking keys in URLs', async () => {
    const key = 'test-token-only'
    const client = createWebSearchClient(brave, { apiKey: key, fetch: async (url, init) => {
      const target = new URL(url)
      expect(target.pathname).toBe('/res/v1/web/search')
      expect(target.searchParams.get('count')).toBe('4')
      expect(target.toString()).not.toContain(key)
      const headers = new Headers(init.headers)
      expect(headers.get('X-Subscription-Token')).toBe(key)
      expect(headers.has('x-api-key')).toBe(false)
      return json({ web: { results: [
        { title: 'Allowed', url: 'https://news.test/a', description: 'News excerpt' },
        { title: 'Blocked', url: 'https://sub.blocked.test/a', description: 'No' },
      ] } })
    } })
    expect(await client.search({ query: 'updates', blockedDomains: ['blocked.test'], limit: 4, signal: signal() })).toEqual([
      { title: 'Allowed', url: 'https://news.test/a', snippet: 'News excerpt' },
    ])
  })

  test('configured maxResults caps per-request limits', async () => {
    const client = createWebSearchClient({ ...searxng, maxResults: 1 }, { fetch: async () => json({ results: [
      { title: 'One', url: 'https://example.com/1' }, { title: 'Two', url: 'https://example.com/2' },
    ] }) })
    expect(await client.search({ query: 'test', limit: 20, signal: signal() })).toHaveLength(1)
  })

  test('empty result is successful; malformed payload, HTTP failures and bad keys fail explicitly', async () => {
    expect(() => createWebSearchClient(brave, { fetch })).toThrow('API key')
    for (const provider of [brave, searxng]) {
      const client = createWebSearchClient(provider, { apiKey: 'key', fetch: async () => json(provider.provider === 'brave' ? { type: 'search' } : { results: [] }) })
      expect(await client.search({ query: 'none', signal: signal() })).toEqual([])
    }
    const invalid = createWebSearchClient(searxng, { fetch: async () => json({ secret: 'not printed' }) })
    await expect(invalid.search({ query: 'bad', signal: signal() })).rejects.toThrow('invalid response')
    const html = createWebSearchClient(searxng, { fetch: async () => new Response('secret html') })
    await expect(html.search({ query: 'bad', signal: signal() })).rejects.toThrow('enable the JSON format')
    const denied = createWebSearchClient(searxng, { fetch: async () => new Response('secret response', { status: 403 }) })
    await expect(denied.search({ query: 'bad', signal: signal() })).rejects.toThrow('Enable the JSON output format')
  })

  test('invalid query/filter/limit and pre-abort make no network request', async () => {
    let calls = 0
    const client = createWebSearchClient(searxng, { fetch: async () => { calls++; return json({ results: [] }) } })
    for (const request of [
      { query: '' }, { query: 'test', limit: 0 }, { query: 'test', allowedDomains: ['https://example.com'] },
      { query: 'test', allowedDomains: ['a.test'], blockedDomains: ['b.test'] },
    ]) await expect(client.search({ ...request, signal: signal() })).rejects.toBeInstanceOf(Error)
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled before start'))
    await expect(client.search({ query: 'test', signal: aborted.signal })).rejects.toThrow('cancelled before start')
    expect(calls).toBe(0)
  })

  test('Brave validates its documented query budget including added domain operators', async () => {
    let calls = 0
    const client = createWebSearchClient(brave, { apiKey: 'key', fetch: async () => { calls++; return json({ type: 'search' }) } })
    await expect(client.search({ query: 'x'.repeat(601), signal: signal() })).rejects.toThrow('600 characters and 75 words')
    await expect(client.search({ query: 'x '.repeat(76).trim(), signal: signal() })).rejects.toThrow('600 characters and 75 words')
    await expect(client.search({ query: 'x'.repeat(600), allowedDomains: ['example.com'], signal: signal() })).rejects.toThrow('domain filters')
    expect(calls).toBe(0)
    expect(await client.search({ query: 'x'.repeat(600), signal: signal() })).toEqual([])
    expect(calls).toBe(1)
  })

  test('caller cancellation cancels and releases an incomplete response body', async () => {
    let cancelled = false
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(sink) { sink.enqueue(new TextEncoder().encode('{"results":[')) },
      cancel() { cancelled = true },
    })
    const client = createWebSearchClient(searxng, { fetch: async () => new Response(stream) })
    const pending = client.search({ query: 'test', signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 1))
    controller.abort(new Error('user cancelled'))
    await expect(pending).rejects.toThrow('user cancelled')
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  test('operation timeout cancels a response which never finishes', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const client = createWebSearchClient({ ...searxng, timeoutMs: 5 }, { fetch: async () => new Response(stream) })
    await expect(client.search({ query: 'test', signal: signal() })).rejects.toThrow('timed out')
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  test('oversized responses cancel body and do not parse partial success', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(sink) { sink.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) },
      cancel() { cancelled = true },
    })
    const client = createWebSearchClient(searxng, { fetch: async () => new Response(stream) })
    await expect(client.search({ query: 'test', signal: signal() })).rejects.toThrow('2 MB')
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  test('network failure is redacted and never invokes another provider', async () => {
    let calls = 0
    const transport: SearchTransport = async () => { calls++; throw new TypeError('fetch failed secret https://example.com/?q=private') }
    const client = createWebSearchClient(brave, { apiKey: 'key', fetch: transport })
    await expect(client.search({ query: 'private', signal: signal() })).rejects.toThrow('Check the configured endpoint')
    expect(calls).toBe(1)
  })

  test('domain syntax rejects search-operator injection', () => {
    expect(normalizeSearchDomain('WWW.Example.COM.')).toBe('www.example.com')
    for (const domain of ['*.example.com', 'example.com OR site:evil.test', 'example.com/path', '-example.com', 'example.com:443']) {
      expect(() => normalizeSearchDomain(domain)).toThrow('hostnames')
    }
  })
})
