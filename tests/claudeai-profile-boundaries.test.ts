import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import type { Tool } from '../src/Tool.js'

const directory = mkdtempSync(join(tmpdir(), 'free-code-claudeai-boundaries-'))
const configPath = join(directory, 'providers.json')
type Effects = { reads: number; refreshes: number; requests: number; downloads: number; refreshHook?: () => Promise<void> }
let harness: typeof import('../src/providers/runtime.js') & typeof import('../src/providers/execution-context.js') & {
  effects: Effects
  fetchClaudeAIMcpConfigsIfEligible: typeof import('../src/services/mcp/claudeai.js').fetchClaudeAIMcpConfigsIfEligible
  clearClaudeAIMcpConfigsCache: () => void
  createClaudeAiProxyFetch: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch
  fetchToolsForClient: (client: unknown) => Promise<Tool[]>
  ensureConnectedClient: (client: unknown) => Promise<unknown>
  settings: {
    downloadUserSettings: () => Promise<boolean>
    redownloadUserSettings: () => Promise<boolean>
    fetchUserSettingsOnce: () => Promise<{ success: boolean }>
    uploadUserSettings: (entries: Record<string, string>) => Promise<{ success: boolean }>
  }
  team: {
    fetchTeamMemoryOnce: (state: object, repo: string) => Promise<{ success: boolean }>
    fetchTeamMemoryHashes: (state: object, repo: string) => Promise<{ success: boolean }>
    uploadTeamMemory: (state: object, repo: string, entries: object) => Promise<{ success: boolean }>
  }
}

/**
 * Isolate the real boundary declarations from large application modules. The
 * source AST is used only to retain code, never to assert implementation text;
 * all tests execute these functions with observable OAuth/network adapters.
 */
function boundaryDeclarations(path: string, names: readonly string[]): string {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const selected = new Set(names)
  const declarations: string[] = []
  for (const node of source.statements) {
    const name = ts.isFunctionDeclaration(node) ? node.name?.text
      : ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
        ? node.declarationList.declarations[0]?.name.getText(source) : undefined
    if (!name || !selected.delete(name)) continue
    const exported = ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    declarations.push((exported ? '' : 'export ') + node.getText(source))
  }
  if (selected.size) throw new Error(`Boundary declarations missing: ${[...selected].join(', ')}`)
  return declarations.join('\n')
}

beforeAll(async () => {
  const runtimePath = resolve(import.meta.dir, '../src/providers/runtime.ts')
  const executionPath = resolve(import.meta.dir, '../src/providers/execution-context.ts')
  const accessPath = resolve(import.meta.dir, '../src/services/mcp/claudeaiAccess.ts')
  const configModulePath = resolve(import.meta.dir, '../src/services/mcp/claudeai.ts')
  const clientPath = resolve(import.meta.dir, '../src/services/mcp/client.ts')
  const settingsPath = resolve(import.meta.dir, '../src/services/settingsSync/index.ts')
  const teamPath = resolve(import.meta.dir, '../src/services/teamMemorySync/index.ts')
  const imports = `import { effects, axios, getOauthConfig, getClaudeAIOAuthTokens, checkAndRefreshOAuthTokenIfNeeded, handleOAuth401Error, logEvent, logForDebugging, logForDiagnosticsNoPII, getAPIProvider, isFirstPartyAnthropicBaseUrl, getClaudeCodeUserAgent, classifyAxiosError, CLAUDE_AI_INFERENCE_SCOPE, CLAUDE_AI_PROFILE_SCOPE, OAUTH_BETA_HEADER, memoizeWithLRU, MCPTool, recursivelySanitizeUnicode, buildMcpToolName, isEnvTruthy, isIncludedMcpTool, feature, doDownloadUserSettings } from 'claudeai-boundary-effects';`
  const sources: Record<string, string> = {
    client: `${imports}
      import { assertClaudeAiMcpAllowed, isClaudeAiMcpAllowed } from ${JSON.stringify(accessPath)};
      const MAX_MCP_DESCRIPTION_LENGTH = 10000, MCP_FETCH_CACHE_SIZE = 20;
      const ListToolsResultSchema = {};
      const isClaudeInChromeMCPServer = () => false;
      const logMCPError = (_name, message) => { throw new Error(message); };
      const errorMessage = error => String(error);
      ${boundaryDeclarations(clientPath, ['createClaudeAiProxyFetch', 'ensureConnectedClient', 'fetchToolsForClient'])}
    `,
    settings: `${imports}
      const SETTINGS_SYNC_TIMEOUT_MS = 10000;
      ${boundaryDeclarations(settingsPath, ['downloadPromise', 'isUsingOAuth', 'getSettingsSyncEndpoint', 'getSettingsSyncAuthHeaders', 'fetchUserSettingsOnce', 'uploadUserSettings', 'downloadUserSettings', 'redownloadUserSettings'])}
    `,
    team: `${imports}
      const TEAM_MEMORY_SYNC_TIMEOUT_MS = 10000;
      ${boundaryDeclarations(teamPath, ['isUsingOAuth', 'getTeamMemorySyncEndpoint', 'getAuthHeaders', 'fetchTeamMemoryOnce', 'fetchTeamMemoryHashes', 'uploadTeamMemory'])}
    `,
  }
  const effectsSource = `
    import { getExecutionProviderProfile } from ${JSON.stringify(runtimePath)};
    export const effects = { reads: 0, refreshes: 0, requests: 0, downloads: 0, refreshHook: undefined };
    export const axios = { get: async url => { effects.requests++; return url.includes('/v1/mcp_servers') ? { data: { data: [{ id: 'connector', display_name: 'Mail', url: 'https://mail.example/mcp' }] } } : { status: 404, data: {} }; }, put: async () => { effects.requests++; return { status: 200, data: {} }; } };
    export default axios;
    export const getOauthConfig = () => ({ BASE_API_URL: 'https://claude.example' });
    export const getClaudeAIOAuthTokens = () => { effects.reads++; return { accessToken: 'legacy-test-token', scopes: ['user:mcp_servers', 'user:inference', 'user:profile'] }; };
    export const checkAndRefreshOAuthTokenIfNeeded = async () => { effects.refreshes++; await effects.refreshHook?.(); };
    export const handleOAuth401Error = async () => false;
    export const getAPIProvider = () => 'firstParty';
    export const isFirstPartyAnthropicBaseUrl = () => !getExecutionProviderProfile();
    export const getClaudeCodeUserAgent = () => 'test';
    export const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference', CLAUDE_AI_PROFILE_SCOPE = 'user:profile', OAUTH_BETA_HEADER = 'oauth';
    export const classifyAxiosError = error => ({ kind: 'other', message: String(error) });
    export const logEvent = () => {}, logForDebugging = () => {}, logForDiagnosticsNoPII = () => {};
    export const isEnvDefinedFalsy = () => false, isEnvTruthy = () => false, clearMcpAuthCache = () => {};
    export const getGlobalConfig = () => ({}), saveGlobalConfig = () => {};
    export const normalizeNameForMCP = name => name.replace(/[^A-Za-z0-9]/g, '_');
    export const memoizeWithLRU = fn => { const cache = new Map(); return Object.assign(client => { if (!cache.has(client.name)) cache.set(client.name, fn(client)); return cache.get(client.name); }, { cache }); };
    export const MCPTool = {}, recursivelySanitizeUnicode = value => value, buildMcpToolName = (server, tool) => 'mcp__' + server + '__' + tool;
    export const isIncludedMcpTool = () => true, feature = () => false;
    export const doDownloadUserSettings = async () => { effects.downloads++; return true; };
  `
  const output = await Bun.build({ entrypoints: ['claudeai-boundary-test'], target: 'bun', plugins: [{
    name: 'claudeai-boundary-adapters', setup(build) {
      build.onResolve({ filter: /^claudeai-boundary-(?:test|effects|client|settings|team)$/ }, args => ({ path: args.path.replace('claudeai-boundary-', ''), namespace: 'claudeai-boundary' }))
      build.onResolve({ filter: /.*/ }, args => {
        if (args.importer !== configModulePath) return
        if (args.path === 'axios' || /^(?:src\/|\.\/client\.js|\.\/normalization\.js)/.test(args.path)) return { path: 'effects', namespace: 'claudeai-boundary' }
      })
      build.onLoad({ filter: /.*/, namespace: 'claudeai-boundary' }, args => ({ loader: 'ts', contents: args.path === 'test'
        ? `export * from ${JSON.stringify(runtimePath)}; export * from ${JSON.stringify(executionPath)}; export * from ${JSON.stringify(configModulePath)}; export * from 'claudeai-boundary-client'; export { effects } from 'claudeai-boundary-effects'; export * as settings from 'claudeai-boundary-settings'; export * as team from 'claudeai-boundary-team';`
        : args.path === 'effects' ? effectsSource : sources[args.path]!,
      }))
    },
  }] })
  if (!output.success) throw new Error(output.logs.map(log => log.message).join('\n'))
  const bundlePath = join(directory, 'claudeai-boundary.mjs')
  await Bun.write(bundlePath, output.outputs[0]!)
  harness = await import(pathToFileURL(bundlePath).href)
  writeFileSync(configPath, JSON.stringify({ providers: { local: { api: 'anthropic', baseURL: 'https://custom.example', defaultModel: 'model', models: [{ id: 'model' }] } } }))
})

beforeEach(() => {
  harness.initializeProviderRuntime({ configPath, env: {} })
  harness.clearClaudeAIMcpConfigsCache()
  Object.assign(harness.effects, { reads: 0, refreshes: 0, requests: 0, downloads: 0, refreshHook: undefined })
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('Claude.ai account boundaries for provider profiles', () => {
  test('connector configuration eligibility is checked before cached legacy results', async () => {
    const legacy = await harness.fetchClaudeAIMcpConfigsIfEligible()
    expect(Object.keys(legacy)).toHaveLength(1)
    expect(harness.effects.requests).toBe(1)
    harness.selectProviderProfile('local')
    const before = { ...harness.effects }
    expect(await harness.fetchClaudeAIMcpConfigsIfEligible()).toEqual({})
    expect(harness.effects).toEqual(before)
    harness.selectProviderProfile(undefined)
    expect(await harness.fetchClaudeAIMcpConfigsIfEligible()).toEqual(legacy)
    expect(harness.effects.requests).toBe(1)
  })

  test('profile startup does not touch connector OAuth or networking', async () => {
    harness.selectProviderProfile('local')
    expect(await harness.fetchClaudeAIMcpConfigsIfEligible()).toEqual({})
    expect(harness.effects.reads).toBe(0)
    expect(harness.effects.requests).toBe(0)
  })

  test('a retained proxy fetch refuses custom profile calls before reading credentials', async () => {
    let networkCalls = 0
    const proxyFetch = harness.createClaudeAiProxyFetch((async () => { networkCalls++; return new Response('ok') }) as typeof fetch)
    await proxyFetch('https://proxy.example')
    harness.selectProviderProfile('local')
    const reads = harness.effects.reads
    await expect(proxyFetch('https://proxy.example')).rejects.toThrow('direct MCP server')
    expect(harness.effects.reads).toBe(reads)
    expect(networkCalls).toBe(1)
  })

  test('retained connector tools disable dynamically; direct SDK MCP remains available', async () => {
    const proxy = { name: 'proxy-test', type: 'connected', config: { type: 'claudeai-proxy' }, capabilities: { tools: true }, client: { request: async () => ({ tools: [{ name: 'read', description: 'Read mail', inputSchema: { type: 'object' } }] }) } }
    const direct = { ...proxy, name: 'direct-test', config: { type: 'sdk' } }
    const [proxyTools, directTools] = await Promise.all([harness.fetchToolsForClient(proxy), harness.fetchToolsForClient(direct)])
    expect(proxyTools[0]!.isEnabled()).toBe(true)
    harness.selectProviderProfile('local')
    expect(proxyTools[0]!.isEnabled()).toBe(false)
    expect(directTools[0]!.isEnabled()).toBe(true)
    expect(await harness.ensureConnectedClient(direct)).toBe(direct)
    await expect(harness.ensureConnectedClient(proxy)).rejects.toThrow('/provider legacy')
    await expect(proxyTools[0]!.call({}, {} as never, undefined as never, undefined as never)).rejects.toThrow('direct MCP server')
  })

  test('settings download checks eligibility outside its cached promise', async () => {
    expect(await harness.settings.downloadUserSettings()).toBe(true)
    harness.selectProviderProfile('local')
    const before = { ...harness.effects }
    expect(await harness.settings.downloadUserSettings()).toBe(false)
    expect(await harness.settings.redownloadUserSettings()).toBe(false)
    expect(harness.effects).toEqual(before)
  })

  test('each settings/team-memory I/O boundary refuses profile OAuth and axios', async () => {
    harness.selectProviderProfile('local')
    const results = await Promise.all([
      harness.settings.fetchUserSettingsOnce(),
      harness.settings.uploadUserSettings({}),
      harness.team.fetchTeamMemoryOnce({}, 'org/repo'),
      harness.team.fetchTeamMemoryHashes({}, 'org/repo'),
      harness.team.uploadTeamMemory({}, 'org/repo', {}),
    ])
    expect(results.every(result => result.success === false)).toBe(true)
    expect(harness.effects.reads).toBe(0)
    expect(harness.effects.refreshes).toBe(0)
    expect(harness.effects.requests).toBe(0)
  })

  test('switching unscoped UI while refresh awaits stops the subsequent OAuth request', async () => {
    harness.effects.refreshHook = async () => { harness.selectProviderProfile('local') }
    expect((await harness.settings.fetchUserSettingsOnce()).success).toBe(false)
    expect(harness.effects.requests).toBe(0)
    expect(harness.effects.reads).toBe(1)
  })

  test('an owned legacy execution keeps its account after UI provider selection changes', async () => {
    const legacy = harness.createProviderExecutionContext('claude-sonnet-4-6')
    harness.selectProviderProfile('local')
    const results = await harness.runWithProviderExecutionContext(legacy, async () => Promise.all([
      harness.settings.fetchUserSettingsOnce(), harness.team.fetchTeamMemoryOnce({}, 'org/repo'),
    ]))
    expect(results.every(result => result.success)).toBe(true)
    expect(harness.effects.requests).toBe(2)
  })
})
