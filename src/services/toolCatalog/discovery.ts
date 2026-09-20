/** Portable tool discovery operates on the caller's registry and conversation. */
export type ToolCatalogEntry = {
  name: string
  description: string
  searchHint?: string
  aliases?: readonly string[]
  deferred: boolean
}

export const MAX_TOOL_SEARCH_RESULTS = 20

function resultLimit(requested: number): number {
  return Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_TOOL_SEARCH_RESULTS, Math.floor(requested)))
    : 5
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function nameText(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase()
}

/** Deterministic, bounded ranking. Discovery never grants execution permission. */
export function searchToolCatalog(
  entries: readonly ToolCatalogEntry[],
  query: string,
  maximumResults = 5,
): string[] {
  const limit = resultLimit(maximumResults)
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const findName = (name: string) => entries.find(entry =>
    entry.name.toLowerCase() === name || entry.aliases?.some(alias => alias.toLowerCase() === name),
  )?.name
  if (normalized.startsWith('select:')) {
    const selected = new Set<string>()
    for (const name of normalized.slice('select:'.length).split(',')) {
      const found = findName(name.trim())
      if (found) selected.add(found)
      if (selected.size === limit) break
    }
    return [...selected]
  }
  const exact = findName(normalized)
  if (exact) return [exact]
  const terms = [...new Set(normalized.split(/\s+/).filter(Boolean))]
  const required = terms.filter(term => term.startsWith('+') && term.length > 1).map(term => term.slice(1))
  const scoring = terms.map(term => term.startsWith('+') ? term.slice(1) : term).filter(Boolean)
  return entries.filter(entry => entry.deferred).map(entry => {
    const name = nameText(entry.name)
    const description = entry.description.toLowerCase()
    const hint = entry.searchHint?.toLowerCase() ?? ''
    const nameParts = name.split(/\s+/)
    const includes = (term: string) => name.includes(term) || entry.name.toLowerCase().includes(term) || description.includes(term) || hint.includes(term)
    if (!required.every(includes)) return { name: entry.name, score: 0 }
    let score = 0
    for (const term of scoring) {
      if (nameParts.includes(term)) score += 12
      else if (name.includes(term) || entry.name.toLowerCase().includes(term)) score += 6
      if (hint.includes(term)) score += 4
      if (description.includes(term)) score += 2
    }
    return { name: entry.name, score }
  }).filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score || compareNames(left.name, right.name))
    .slice(0, limit)
    .map(match => match.name)
}

const LOCAL_TOOL_SEARCH_TYPE = 'local_tool_search'

/** Ordinary text on every API; no tool_reference or vendor-owned schema format. */
export function formatLocalToolSearchResult(matches: readonly string[], pendingServers?: readonly string[]): string {
  return JSON.stringify({
    type: LOCAL_TOOL_SEARCH_TYPE,
    tools: matches,
    message: matches.length
      ? 'These tools are available in the next request. Use their provided schemas. Existing tool permissions still apply.'
      : 'No matching tools found. Try different keywords or select an exact tool name.',
    ...(pendingServers?.length ? { pending_servers: pendingServers } : {}),
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function localMatches(content: unknown): string[] {
  const texts = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.flatMap(value => {
      const block = record(value)
      return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    }) : []
  for (const text of texts) {
    if (text.length > 100_000) continue
    try {
      const result = record(JSON.parse(text))
      if (result?.type !== LOCAL_TOOL_SEARCH_TYPE || !Array.isArray(result.tools)) continue
      if (result.tools.length > MAX_TOOL_SEARCH_RESULTS || !result.tools.every(name => typeof name === 'string' && name.length > 0)) continue
      return result.tools as string[]
    } catch {
      // Other tool results are ordinary user text, not discovery records.
    }
  }
  return []
}

/**
 * Conversation history owns discovery state, including a subagent's history.
 * Only results paired with a ToolSearch call count; arbitrary text and unrelated
 * tool output cannot select schemas. The caller intersects with its live registry.
 */
export function extractLocalDiscoveredToolNames(messages: readonly unknown[]): Set<string> {
  const selected = new Set<string>()
  const searchCallIds = new Set<string>()
  for (const value of messages) {
    const message = record(value)
    if (!message) continue
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      const carried = record(message.compactMetadata)?.preCompactDiscoveredTools
      if (Array.isArray(carried)) for (const name of carried) {
        if (typeof name === 'string') selected.add(name)
      }
      continue
    }
    const content = record(message.message)?.content
    if (!Array.isArray(content)) continue
    for (const value of content) {
      const block = record(value)
      if (message.type === 'assistant' && block?.type === 'tool_use' && block.name === 'ToolSearch' && typeof block.id === 'string') {
        searchCallIds.add(block.id)
      } else if (message.type === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && searchCallIds.has(block.tool_use_id) && !block.is_error) {
        for (const name of localMatches(block.content)) selected.add(name)
        searchCallIds.delete(block.tool_use_id)
      }
    }
  }
  return selected
}

/** Preserve non-deferred tools and intersect discovered names with the live registry. */
export function selectDiscoveredToolSchemas<T extends { name: string }>(
  registry: readonly T[],
  deferredNames: ReadonlySet<string>,
  discoveredNames: ReadonlySet<string>,
): T[] {
  return registry.filter(tool => !deferredNames.has(tool.name) || discoveredNames.has(tool.name))
}

/** Catalog hints stay constant-sized when hundreds of MCP tools are connected. */
export function getLocalToolCatalogHint(deferredToolCount: number): string {
  return `${deferredToolCount} additional tools are available through ToolSearch. Search by task, integration, or tool-name keywords before using them. ToolSearch loads only matching tools for the next request; it does not grant permission to execute them.`
}
