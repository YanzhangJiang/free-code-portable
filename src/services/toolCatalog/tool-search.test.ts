import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolUseContext, Tools } from '../../Tool.js'

const directory = mkdtempSync(join(tmpdir(), 'free-code-tool-catalog-'))
const configPath = join(directory, 'providers.json')
const originalSearch = process.env.ENABLE_TOOL_SEARCH
const originalDisableBetas = process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
let harness: typeof import('../../providers/runtime.js') & typeof import('../../utils/toolSearch.js') & {
  ToolSearchTool: typeof import('../../tools/ToolSearchTool/ToolSearchTool.js').ToolSearchTool
  effects: { tokenRequests: number }
}

beforeAll(async () => {
  const utilityPath = resolve(import.meta.dir, '../../utils/toolSearch.ts')
  const toolPath = resolve(import.meta.dir, '../../tools/ToolSearchTool/ToolSearchTool.ts')
  const promptPath = resolve(import.meta.dir, '../../tools/ToolSearchTool/prompt.ts')
  const runtimePath = resolve(import.meta.dir, '../../providers/runtime.ts')
  const output = await Bun.build({
    entrypoints: ['tool-catalog-test'], target: 'bun',
    plugins: [{ name: 'tool-catalog-boundary', setup(build) {
      build.onResolve({ filter: /^tool-catalog-test$/ }, () => ({ path: 'entry', namespace: 'tool-catalog-test' }))
      build.onResolve({ filter: /^tool-catalog-effects$/ }, () => ({ path: 'effects', namespace: 'tool-catalog-test' }))
      build.onResolve({ filter: /^\.\.?\// }, args => {
        if (![utilityPath, toolPath, promptPath].includes(args.importer)) return
        if (/(?:providers\/runtime|toolCatalog\/discovery|utils\/toolSearch|lazySchema|ToolSearchTool\/prompt|\.\/prompt|\.\/constants)\.js$/.test(args.path)) return
        return { path: 'effects', namespace: 'tool-catalog-test' }
      })
      build.onLoad({ filter: /.*/, namespace: 'tool-catalog-test' }, args => ({ loader: 'ts', contents: args.path === 'entry'
        ? `export * from ${JSON.stringify(utilityPath)}; export * from ${JSON.stringify(runtimePath)}; export { ToolSearchTool } from ${JSON.stringify(toolPath)}; export * from 'tool-catalog-effects';`
        : `
          export const effects = { tokenRequests: 0 };
          export const buildTool = definition => definition;
          export const toolMatchesName = (tool, name) => tool.name === name || tool.aliases?.includes(name);
          export const findToolByName = (tools, name) => tools.find(tool => toolMatchesName(tool, name));
          export const getFeatureValue_CACHED_MAY_BE_STALE = (_key, fallback) => fallback;
          export const count = (array, predicate) => array.filter(predicate).length;
          export const getMergedBetas = () => [];
          export const getContextWindowForModel = () => 10000;
          export const countToolDefinitionTokens = async () => { effects.tokenRequests++; return 100000; };
          export const TOOL_TOKEN_COUNT_OVERHEAD = 0;
          export const logEvent = () => {};
          export const logForDebugging = () => {};
          export const isEnvTruthy = value => ['1', 'true', 'yes'].includes(value);
          export const isEnvDefinedFalsy = value => ['0', 'false', 'no'].includes(value);
          export const getAPIProvider = () => 'firstParty';
          export const isFirstPartyAnthropicBaseUrl = () => true;
          export const jsonStringify = JSON.stringify;
          export const zodToJsonSchema = () => ({});
          export const escapeRegExp = value => value;
          export const isReplBridgeActive = () => false;
          export const AGENT_TOOL_NAME = 'Agent';
        `,
      }))
    } }],
  })
  if (!output.success) throw new Error(output.logs.map(log => log.message).join('\n'))
  const bundlePath = join(directory, 'catalog.mjs')
  await Bun.write(bundlePath, output.outputs[0]!)
  harness = await import(pathToFileURL(bundlePath).href)
  writeFileSync(configPath, JSON.stringify({ defaultProvider: 'local', providers: {
    local: { api: 'openai-completions', baseURL: 'http://localhost:1234/v1', defaultModel: 'coder', models: [{ id: 'coder', contextWindow: 10000, maxOutputTokens: 1000 }] },
  } }))
})

beforeEach(() => {
  delete process.env.ENABLE_TOOL_SEARCH
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  harness.initializeProviderRuntime({ configPath, env: {} })
  harness.effects.tokenRequests = 0
})

afterEach(() => {
  if (originalSearch === undefined) delete process.env.ENABLE_TOOL_SEARCH
  else process.env.ENABLE_TOOL_SEARCH = originalSearch
  if (originalDisableBetas === undefined) delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  else process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = originalDisableBetas
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function fixtureTools(description: string): Tools {
  return [
    { name: 'ToolSearch', prompt: async () => '' },
    { name: 'mcp__github__read_issue', isMcp: true, prompt: async () => description, inputJSONSchema: { type: 'object', properties: {} } },
  ] as unknown as Tools
}

function context(tools: Tools, abortController = new AbortController()): ToolUseContext {
  return {
    options: { tools, mainLoopModel: 'local/coder', agentDefinitions: { activeAgents: [] } },
    abortController,
    getAppState: () => ({ mcp: { clients: [] }, toolPermissionContext: { mode: 'default' } }),
  } as unknown as ToolUseContext
}

describe('portable ToolSearch boundary', () => {
  test('custom profiles default to a local auto threshold without remote token counting', async () => {
    expect(harness.getToolSearchMode()).toBe('tst-auto')
    expect(harness.isToolSearchEnabledOptimistic()).toBe(true)
    expect(harness.modelSupportsToolReference('local/coder')).toBe(false)
    expect(await harness.isToolSearchEnabled('local/coder', fixtureTools('small'), async () => ({} as never), [])).toBe(false)
    expect(await harness.isToolSearchEnabled('local/coder', fixtureTools('x'.repeat(3000)), async () => ({} as never), [])).toBe(true)
    expect(harness.effects.tokenRequests).toBe(0)
  })

  test('explicit modes work without enabling vendor beta shapes', async () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect(harness.getToolSearchMode()).toBe('tst')
    expect(await harness.isToolSearchEnabled('local/coder', fixtureTools('small'), async () => ({} as never), [])).toBe(true)
    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect(harness.isToolSearchEnabledOptimistic()).toBe(false)
    expect(await harness.isToolSearchEnabled('local/coder', fixtureTools('x'.repeat(3000)), async () => ({} as never), [])).toBe(false)
    process.env.ENABLE_TOOL_SEARCH = 'auto:50'
    expect(await harness.isToolSearchEnabled('local/coder', fixtureTools('x'.repeat(3000)), async () => ({} as never), [])).toBe(false)
    expect(harness.isDeferredToolsDeltaEnabled()).toBe(false)
    expect(harness.effects.tokenRequests).toBe(0)
  })

  test('a disallowed ToolSearch disables deferral instead of hiding executable schemas', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect(await harness.isToolSearchEnabled('local/coder', fixtureTools('large').slice(1), async () => ({} as never), [])).toBe(false)
  })

  test('actual tool call returns portable text and history selects the next schema', async () => {
    const tool = harness.ToolSearchTool
    const result = await tool.call({ query: 'github', max_results: 5 }, context(fixtureTools('Read Github issues')))
    expect(result.data.discovery).toBe('local')
    expect(result.data.matches).toEqual(['mcp__github__read_issue'])
    const block = tool.mapToolResultToToolResultBlockParam(result.data, 'search-one')
    expect(typeof block.content).toBe('string')
    expect(JSON.stringify(block)).not.toContain('tool_reference')
    const names = harness.extractDiscoveredToolNames([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ToolSearch', id: 'search-one' }] } },
      { type: 'user', message: { content: [block] } },
    ] as never)
    expect([...names]).toEqual(['mcp__github__read_issue'])
    expect(await tool.prompt()).toContain('Discovery does not change tool permissions')
  })

  test('search reports pending servers and cancellation returns no discovered tools', async () => {
    const tool = harness.ToolSearchTool
    const useContext = context(fixtureTools('Read issues'))
    useContext.getAppState = () => ({ mcp: { clients: [{ type: 'pending', name: 'mail' }] }, toolPermissionContext: {} }) as never
    const result = await tool.call({ query: 'absent', max_results: 5 }, useContext)
    expect(result.data.matches).toEqual([])
    expect(result.data.pending_mcp_servers).toEqual(['mail'])
    useContext.abortController.abort()
    await expect(tool.call({ query: 'github', max_results: 5 }, useContext)).rejects.toThrow()
  })

  test('cancellation during catalog preparation never returns a selection', async () => {
    const abortController = new AbortController()
    const tools = fixtureTools('Read issues')
    tools[1]!.prompt = async () => {
      abortController.abort()
      return 'Read issues'
    }
    await expect(harness.ToolSearchTool.call(
      { query: 'github', max_results: 5 }, context(tools, abortController),
    )).rejects.toThrow()
  })
})
