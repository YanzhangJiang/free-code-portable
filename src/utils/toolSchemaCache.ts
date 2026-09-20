import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

// Legacy session cache of rendered tool schemas. Tool schemas render at server
// position 2 (before system prompt), so any byte-level change busts the entire
// ~11K-token tool block AND everything downstream. GrowthBook gate flips
// (tengu_tool_pear, tengu_fgts), MCP reconnects, or dynamic content in
// tool.prompt() all cause this churn. Memoizing per-session locks the schema
// bytes at first render — mid-session GB refreshes no longer bust the cache.
// Model/provider namespaces prevent capability flags crossing model boundaries.
// Configured profiles render afresh because prompts also depend on each agent's
// visible registry and permission context, not just its provider/model.
//
// Lives in a leaf module so auth.ts can clear it without importing api.ts
// (which would create a cycle via plans→settings→file→growthbook→config→
// bridgeEnabled→auth).
type CachedSchema = BetaTool & {
  strict?: boolean
  eager_input_streaming?: boolean
}

let schemaCaches = new Map<string, Map<string, CachedSchema>>()

/** Callers retain one cache generation for the duration of an async render. */
export function getToolSchemaCache(namespace = 'legacy'): Map<string, CachedSchema> {
  let cache = schemaCaches.get(namespace)
  if (!cache) {
    cache = new Map<string, CachedSchema>()
    schemaCaches.set(namespace, cache)
  }
  return cache
}

export function clearToolSchemaCache(): void {
  // An in-flight prompt may resolve after invalidation. Detach its old map so
  // that completion cannot repopulate the cache used by subsequent requests.
  schemaCaches = new Map()
}
