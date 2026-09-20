import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeExternalServices } from '../../services/external/runtime.js'
import { initializeProviderRuntime } from '../../providers/runtime.js'

const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).pathname, () => exports)
let modelCalls = 0
stub('../../services/api/claude.ts', { queryModelWithStreaming: async function* () {
  modelCalls++
  yield { type: 'assistant', message: { content: [{ type: 'text', text: 'legacy result' }] } }
} })
stub('../../services/analytics/growthbook.ts', { getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) => fallback })
stub('../../utils/model/providers.ts', { getAPIProvider: () => 'firstParty' })
stub('../../utils/model/model.ts', { getMainLoopModel: () => 'remote/Model', getSmallFastModel: () => 'remote/Model' })
stub('../../utils/proxy.ts', { getProxyFetchOptions: () => ({}) })
stub('../../utils/log.ts', { logError: () => {} })
stub('../../utils/messages.ts', { createUserMessage: (input: unknown) => input })
stub('../../utils/slowOperations.ts', { jsonParse: JSON.parse, jsonStringify: JSON.stringify })
stub('../../constants/common.ts', { getLocalMonthYear: () => 'September 2026' })
stub('./UI.tsx', {
  getToolUseSummary: () => null, renderToolResultMessage: () => null,
  renderToolUseMessage: () => null, renderToolUseProgressMessage: () => null,
})
const { WebSearchTool } = await import('./WebSearchTool.js')
const directory = mkdtempSync(join(tmpdir(), 'search-tool-'))
const savedFetch = globalThis.fetch
try {
  writeFileSync(join(directory, 'providers.json'), JSON.stringify({ defaultProvider: 'remote', providers: { remote: {
    api: 'openai-completions', baseURL: 'https://model.test/v1', defaultModel: 'Model', models: [{ id: 'Model' }],
  } } }))
  initializeProviderRuntime({ env: { CLAUDE_CONFIG_DIR: directory } })
  initializeExternalServices({ env: { CLAUDE_CONFIG_DIR: directory } })
  assert.equal(WebSearchTool.isEnabled(), false)
  const servicesFile = join(directory, 'services.json')
  writeFileSync(servicesFile, JSON.stringify({ webSearch: { provider: 'brave', apiKeyEnv: 'WEB_KEY' } }))
  initializeExternalServices({ env: { CLAUDE_CONFIG_DIR: directory, WEB_KEY: 'independent-search-key' } })
  assert.equal(WebSearchTool.isEnabled(), true)
  assert.equal((await WebSearchTool.checkPermissions({ query: 'test' })).behavior, 'passthrough')
  let searches = 0
  globalThis.fetch = (async (url: string | URL, options: RequestInit) => {
    searches++
    assert.equal(new URL(url).hostname, 'api.search.brave.com')
    assert.equal(new Headers(options.headers).get('x-subscription-token'), 'independent-search-key')
    return Response.json({ web: { results: [{ title: 'A reference', url: 'https://example.com/', description: 'Source excerpt' }] } })
  }) as typeof fetch
  const context = { abortController: new AbortController(), options: { mainLoopModel: 'remote/Model', agentDefinitions: { activeAgents: [] } }, getAppState: () => ({ toolPermissionContext: {} }) } as unknown as Parameters<typeof WebSearchTool.call>[1]
  const progress: unknown[] = []
  const result = await WebSearchTool.call({ query: 'test' }, context, undefined as never, undefined as never, event => progress.push(event))
  const rendered = WebSearchTool.mapToolResultToToolResultBlockParam(result.data, 'tool-id')
  assert.equal(rendered.tool_use_id, 'tool-id')
  assert.match(String(rendered.content), /Source excerpt/)
  assert.match(String(rendered.content), /https:\/\/example.com\//)
  assert.equal(progress.length, 2)
  assert.equal(searches, 1)
  assert.equal(modelCalls, 0)
  globalThis.fetch = (async () => new Response('no', { status: 429 })) as unknown as typeof fetch
  await assert.rejects(WebSearchTool.call({ query: 'test' }, context, undefined as never, undefined as never, undefined), /HTTP 429/)
  assert.equal(modelCalls, 0)
  rmSync(servicesFile)
  initializeExternalServices({ env: { CLAUDE_CONFIG_DIR: directory } })
  await assert.rejects(WebSearchTool.call({ query: 'test' }, context, undefined as never, undefined as never, undefined), /requires a search service/)
  assert.equal(modelCalls, 0)
  initializeProviderRuntime({ provider: 'legacy', env: { CLAUDE_CONFIG_DIR: directory } })
  context.options.mainLoopModel = 'claude-sonnet-4'
  assert.equal(WebSearchTool.isEnabled(), true)
  const legacy = await WebSearchTool.call({ query: 'legacy query' }, context, undefined as never, undefined as never, undefined)
  assert.equal(modelCalls, 1)
  assert.equal(legacy.data.results[0], 'legacy result')
  console.log('portable search tool checks passed')
} finally {
  globalThis.fetch = savedFetch
  rmSync(directory, { recursive: true, force: true })
}
