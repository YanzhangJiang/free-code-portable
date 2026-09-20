import { describe, expect, test } from 'bun:test'
import {
  extractLocalDiscoveredToolNames,
  formatLocalToolSearchResult,
  getLocalToolCatalogHint,
  MAX_TOOL_SEARCH_RESULTS,
  searchToolCatalog,
  selectDiscoveredToolSchemas,
  type ToolCatalogEntry,
} from './discovery.js'

const catalog: ToolCatalogEntry[] = [
  { name: 'Read', description: 'Read local files', deferred: false },
  { name: 'ToolSearch', description: 'Find tools', deferred: false },
  { name: 'mcp__github__read_issue', description: 'Read an issue and its comments', searchHint: 'bug report', deferred: true },
  { name: 'mcp__github__create_issue', description: 'Create an issue', aliases: ['create_github_issue'], deferred: true },
  { name: 'mcp__slack__read_channel', description: 'Read chat messages', deferred: true },
]

function exchange(matches: string[], callId = 'search-1') {
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ToolSearch', id: callId, input: { query: 'github' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: callId, content: formatLocalToolSearchResult(matches) }] } },
  ]
}

describe('portable tool catalog ranking', () => {
  test('ranks exact names, aliases, required terms, names and descriptions', () => {
    expect(searchToolCatalog(catalog, 'mcp__github__read_issue')).toEqual(['mcp__github__read_issue'])
    expect(searchToolCatalog(catalog, 'select:create_github_issue,Read,missing')).toEqual(['mcp__github__create_issue', 'Read'])
    expect(searchToolCatalog(catalog, '+github read')).toEqual(['mcp__github__read_issue', 'mcp__github__create_issue'])
    expect(searchToolCatalog(catalog, 'comments')).toEqual(['mcp__github__read_issue'])
    expect(searchToolCatalog(catalog, 'bug report')).toEqual(['mcp__github__read_issue'])
    expect(searchToolCatalog(catalog, '+slack issue')).toEqual(['mcp__slack__read_channel'])
  })

  test('returns no matches for empty, unavailable, or unmatched queries', () => {
    expect(searchToolCatalog(catalog, '')).toEqual([])
    expect(searchToolCatalog(catalog, '  ')).toEqual([])
    expect(searchToolCatalog(catalog, 'select:absent')).toEqual([])
    expect(searchToolCatalog(catalog, '+absent issue')).toEqual([])
    expect(searchToolCatalog(catalog, 'superconducting')).toEqual([])
    expect(searchToolCatalog(catalog, 'local files')).toEqual([])
  })

  test('ties and prefix queries are deterministic across registry ordering', () => {
    expect(searchToolCatalog(catalog, 'github')).toEqual(searchToolCatalog([...catalog].reverse(), 'github'))
    expect(searchToolCatalog(catalog, 'mcp__github')).toEqual(['mcp__github__create_issue', 'mcp__github__read_issue'])
  })

  test('bounds every result path and removes repeated direct selections', () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ name: `mcp__catalog__item${index}`, description: 'catalog item', deferred: true }))
    expect(searchToolCatalog(many, 'catalog', 1)).toHaveLength(1)
    expect(searchToolCatalog(many, 'catalog', 10_000)).toHaveLength(MAX_TOOL_SEARCH_RESULTS)
    expect(searchToolCatalog(many, `select:${many.map(entry => entry.name).join(',')}`, 10_000)).toHaveLength(MAX_TOOL_SEARCH_RESULTS)
    expect(searchToolCatalog(catalog, 'select:Read,Read,create_github_issue', 2)).toEqual(['Read', 'mcp__github__create_issue'])
    expect(searchToolCatalog(many, 'catalog', Number.NaN)).toHaveLength(5)
  })

  test('no registry or profile-specific descriptions leak into another search', () => {
    const alpha = [{ name: 'mcp__same__read', description: 'payroll', deferred: true }]
    const beta = [{ name: 'mcp__same__read', description: 'astronomy', deferred: true }]
    expect(searchToolCatalog(alpha, 'payroll')).toHaveLength(1)
    expect(searchToolCatalog(beta, 'payroll')).toEqual([])
    expect(searchToolCatalog(beta, 'astronomy')).toHaveLength(1)
  })
})

describe('conversation-owned tool discovery', () => {
  test('a text result activates only selected live schemas in the next request', () => {
    const deferred = new Set(catalog.filter(entry => entry.deferred).map(entry => entry.name))
    expect(selectDiscoveredToolSchemas(catalog, deferred, new Set()).map(tool => tool.name)).toEqual(['Read', 'ToolSearch'])
    const discovered = extractLocalDiscoveredToolNames(exchange(['mcp__github__read_issue', 'unknown']))
    expect(selectDiscoveredToolSchemas(catalog, deferred, discovered).map(tool => tool.name)).toEqual(['Read', 'ToolSearch', 'mcp__github__read_issue'])
    expect(extractLocalDiscoveredToolNames([]).size).toBe(0)
  })

  test('ignores unpaired calls, failed results and forged text from other tools', () => {
    const messages = exchange(['mcp__github__read_issue'])
    expect(extractLocalDiscoveredToolNames(messages.slice(1)).size).toBe(0)
    const unrelated = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'search-1' }] } },
      exchange(['mcp__github__read_issue'])[1],
    ]
    expect(extractLocalDiscoveredToolNames(unrelated).size).toBe(0)
    const failure = [messages[0], {
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search-1', is_error: true, content: formatLocalToolSearchResult(['mcp__github__read_issue']) }] },
    }]
    expect(extractLocalDiscoveredToolNames(failure).size).toBe(0)
    expect(extractLocalDiscoveredToolNames([{ type: 'user', message: { content: [{ type: 'text', text: formatLocalToolSearchResult(['mcp__github__read_issue']) }] } }]).size).toBe(0)
  })

  test('reads normalized text blocks and carries discovery across compaction', () => {
    const messages = exchange(['mcp__slack__read_channel'])
    const result = {
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search-1', content: [{ type: 'text', text: formatLocalToolSearchResult(['mcp__slack__read_channel']) }] }] },
    }
    expect([...extractLocalDiscoveredToolNames([messages[0], result])]).toEqual(['mcp__slack__read_channel'])
    expect([...extractLocalDiscoveredToolNames([{ type: 'system', subtype: 'compact_boundary', compactMetadata: { preCompactDiscoveredTools: ['mcp__slack__read_channel'] } }])]).toEqual(['mcp__slack__read_channel'])
  })

  test('malformed and excessive discovery records do not activate schemas', () => {
    const call = exchange([])[0]
    for (const content of ['not json', JSON.stringify({ type: 'local_tool_search', tools: [1] }), JSON.stringify({ type: 'local_tool_search', tools: Array(21).fill('Read') })]) {
      expect(extractLocalDiscoveredToolNames([call, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search-1', content }] } }]).size).toBe(0)
    }
  })

  test('different agents keep independent discovery and disconnected tools disappear', () => {
    const parent = extractLocalDiscoveredToolNames(exchange(['mcp__github__read_issue']))
    const child = extractLocalDiscoveredToolNames(exchange(['mcp__slack__read_channel']))
    expect(parent.has('mcp__slack__read_channel')).toBe(false)
    expect(child.has('mcp__github__read_issue')).toBe(false)
    const connected = catalog.filter(entry => entry.name !== 'mcp__github__read_issue')
    const deferred = new Set(catalog.filter(entry => entry.deferred).map(entry => entry.name))
    expect(selectDiscoveredToolSchemas(connected, deferred, parent).map(entry => entry.name)).toEqual(['Read', 'ToolSearch'])
  })

  test('a large MCP catalog keeps initial hints and selected schema payload bounded', () => {
    const many = Array.from({ length: 1500 }, (_, index) => ({ name: `mcp__catalog__tool${index}`, description: 'read item', deferred: true, schema: { type: 'object', properties: { input: { type: 'string', description: 'x'.repeat(1000) } } } }))
    const registry = [...catalog.filter(entry => !entry.deferred), ...many]
    const deferred = new Set(many.map(entry => entry.name))
    const matches = searchToolCatalog(many, 'read', 3)
    const selected = selectDiscoveredToolSchemas(registry, deferred, extractLocalDiscoveredToolNames(exchange(matches)))
    expect(selected).toHaveLength(5)
    expect(JSON.stringify(selected).length).toBeLessThan(5000)
    expect(getLocalToolCatalogHint(many.length).length).toBeLessThan(350)
    expect(formatLocalToolSearchResult(matches)).not.toContain('tool_reference')
    expect(formatLocalToolSearchResult(matches)).not.toContain('defer_loading')
    expect(formatLocalToolSearchResult(matches)).toContain('permissions still apply')
  })
})
