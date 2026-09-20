import type { WebSearchConfiguration } from '../external/config.js'

export type SearchHit = { title: string; url: string; snippet: string }
export type SearchRequest = {
  query: string
  allowedDomains?: readonly string[]
  blockedDomains?: readonly string[]
  limit?: number
  signal: AbortSignal
}
export type SearchTransport = (input: string | URL, init: RequestInit) => Promise<Response>

export function normalizeSearchDomain(domain: string): string {
  const normalized = domain.toLowerCase().replace(/\.$/, '')
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw new Error('Search domain filters must contain hostnames without schemes, paths, ports, or wildcards.')
  }
  return normalized
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function searchHits(input: unknown, provider: WebSearchConfiguration['provider']): SearchHit[] {
  const root = record(input)
  const rows = provider === 'brave' ? record(root?.web)?.results : root?.results
  // Brave legitimately omits web for a query with no web results.
  if (provider === 'brave' && root?.type === 'search' && root.web === undefined) return []
  if (!Array.isArray(rows)) throw new Error(`The ${provider} search service returned an invalid response.`)
  const hits: SearchHit[] = []
  for (const row of rows) {
    const result = record(row)
    if (typeof result?.url !== 'string' || result.url.length > 2000 || typeof result.title !== 'string') continue
    try {
      const url = new URL(result.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
      const snippet = provider === 'brave' ? result.description : result.content
      hits.push({ title: result.title.slice(0, 500), url: url.toString(), snippet: typeof snippet === 'string' ? snippet.slice(0, 2000) : '' })
    } catch { /* Invalid result URLs are untrusted provider output. */ }
  }
  return hits
}

const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error('Search service returned an empty response.')
  const reader = response.body.getReader()
  let complete = false
  let cancellation: Promise<void> | undefined
  const abort = () => { cancellation ??= reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const decoder = new TextDecoder()
    let totalBytes = 0
    let text = ''
    for (;;) {
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) break
      totalBytes += part.value.byteLength
      if (totalBytes > MAX_SEARCH_RESPONSE_BYTES) throw new Error('Search response exceeds the 2 MB limit.')
      text += decoder.decode(part.value, { stream: true })
    }
    complete = true
    text += decoder.decode()
    try { return JSON.parse(text) } catch { throw new Error('Search service returned invalid JSON. For SearXNG, enable the JSON format in settings.yml.') }
  } finally {
    signal.removeEventListener('abort', abort)
    if (cancellation) await cancellation
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * Each invocation owns its timeout/listener and finishes or cancels response reads
 * before returning. Credentials and transport are fixed when the client is created.
 */
export function createWebSearchClient(configuration: WebSearchConfiguration, dependencies: {
  fetch: SearchTransport
  apiKey?: string
}) {
  const config = { ...configuration }
  const apiKey = dependencies.apiKey
  if (config.provider === 'brave' && !apiKey?.trim()) throw new Error('Brave Search requires its configured API key environment variable.')

  return {
    async search(request: SearchRequest): Promise<SearchHit[]> {
      if (!request.query.trim()) throw new Error('Search query cannot be empty.')
      if (request.query.length > 2000) throw new Error('Search query must not exceed 2000 characters.')
      const allowed = request.allowedDomains?.map(normalizeSearchDomain) ?? []
      const blocked = request.blockedDomains?.map(normalizeSearchDomain) ?? []
      if (allowed.length && blocked.length) throw new Error('Use either allowed or blocked search domains, not both.')
      const limit = request.limit ?? config.maxResults
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Search result limit must be between 1 and 20.')
      request.signal.throwIfAborted()
      const controller = new AbortController()
      const abort = () => controller.abort(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(new DOMException('Web search timed out.', 'TimeoutError')), config.timeoutMs)
      try {
        // Authoritative wire formats: https://docs.searxng.org/dev/search_api.html
        // https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
        const path = config.provider === 'brave' ? 'res/v1/web/search' : 'search'
        const endpoint = new URL(`${config.baseURL.replace(/\/$/, '')}/${path}`)
        const restrictions = allowed.length ? ` (${allowed.map(domain => `site:${domain}`).join(' OR ')})` : blocked.map(domain => ` -site:${domain}`).join('')
        const query = request.query + restrictions
        // https://api-dashboard.search.brave.com/api-reference/web/search/get
        if (config.provider === 'brave' && (query.length > 600 || query.trim().split(/\s+/).length > 75)) {
          throw new Error('Brave Search queries, including domain filters, must fit within 600 characters and 75 words. Shorten the query or use fewer domain filters.')
        }
        endpoint.searchParams.set('q', query)
        const headers: Record<string, string> = { Accept: 'application/json' }
        if (config.provider === 'brave') {
          endpoint.searchParams.set('count', String(Math.min(limit, config.maxResults)))
          endpoint.searchParams.set('result_filter', 'web')
          endpoint.searchParams.set('text_decorations', 'false')
          headers['X-Subscription-Token'] = apiKey!
        } else {
          endpoint.searchParams.set('format', 'json')
          endpoint.searchParams.set('categories', 'general')
        }
        let response: Response
        try {
          response = await dependencies.fetch(endpoint, { headers, signal: controller.signal, redirect: 'error' })
        } catch {
          controller.signal.throwIfAborted()
          throw new Error(`${config.provider} search request failed. Check the configured endpoint and network connection.`)
        }
        if (!response.ok) {
          await response.body?.cancel()
          // Never echo bodies or URLs: upstream errors can include request keys.
          throw new Error(`${config.provider} search failed with HTTP ${response.status}.${config.provider === 'searxng' && response.status === 403 ? ' Enable the JSON output format on your SearXNG instance.' : ''}`)
        }
        const hits = searchHits(await readResponse(response, controller.signal), config.provider)
        controller.signal.throwIfAborted()
        const seen = new Set<string>()
        return hits.filter(hit => {
          const hostname = new URL(hit.url).hostname.toLowerCase().replace(/\.$/, '')
          if (allowed.length && !allowed.some(domain => domainMatches(hostname, domain))) return false
          if (blocked.some(domain => domainMatches(hostname, domain)) || seen.has(hit.url)) return false
          seen.add(hit.url)
          return true
        }).slice(0, Math.min(limit, config.maxResults))
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason
        // Network errors may contain the request URL (including a private query).
        if (error instanceof TypeError) throw new Error(`${config.provider} search request failed. Check the configured endpoint and network connection.`)
        throw error
      } finally {
        clearTimeout(timer)
        request.signal.removeEventListener('abort', abort)
      }
    },
  }
}
