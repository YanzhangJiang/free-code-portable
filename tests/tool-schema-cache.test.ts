import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Tool, ToolPermissionContext } from '../src/Tool.js'

const directory = mkdtempSync(join(tmpdir(), 'free-code-tool-schema-cache-'))
const configPath = join(directory, 'providers.json')
let harness: typeof import('../src/providers/runtime.js') & typeof import('../src/providers/execution-context.js') & typeof import('../src/utils/toolSchemaCache.js') & {
  toolToAPISchema: typeof import('../src/utils/api.js').toolToAPISchema
  effects: { provider: string; strict: boolean; eager: boolean }
}

beforeAll(async () => {
  const apiPath = resolve(import.meta.dir, '../src/utils/api.ts')
  const runtimePath = resolve(import.meta.dir, '../src/providers/runtime.ts')
  const executionPath = resolve(import.meta.dir, '../src/providers/execution-context.ts')
  const cachePath = resolve(import.meta.dir, '../src/utils/toolSchemaCache.ts')
  const output = await Bun.build({ entrypoints: ['schema-cache-test'], target: 'bun', plugins: [{
    name: 'schema-cache-boundary', setup(build) {
      build.onResolve({ filter: /^schema-cache-test$/ }, () => ({ path: 'entry', namespace: 'schema-cache-test' }))
      build.onResolve({ filter: /^schema-cache-effects$/ }, () => ({ path: 'effects', namespace: 'schema-cache-test' }))
      build.onResolve({ filter: /^(?:src\/|\.\.?\/)/ }, args => {
        if (args.importer !== apiPath) return
        if (/(?:providers\/(?:runtime|execution-context)|toolSchemaCache)\.js$/.test(args.path)) return
        return { path: 'effects', namespace: 'schema-cache-test' }
      })
      build.onLoad({ filter: /.*/, namespace: 'schema-cache-test' }, args => ({ loader: 'ts', contents: args.path === 'entry'
        ? `export { toolToAPISchema } from ${JSON.stringify(apiPath)}; export * from ${JSON.stringify(runtimePath)}; export * from ${JSON.stringify(executionPath)}; export * from ${JSON.stringify(cachePath)}; export * from 'schema-cache-effects';`
        : `
          export const effects = { provider: 'firstParty', strict: true, eager: true };
          export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = 'boundary';
          export const CLI_SYSPROMPT_PREFIXES = [];
          export const getSystemContext = () => ({}), getUserContext = () => ({});
          export const isAnalyticsDisabled = () => true;
          export const checkStatsigFeatureGate_CACHED_MAY_BE_STALE = () => effects.strict;
          export const getFeatureValue_CACHED_MAY_BE_STALE = (_key, fallback) => effects.eager;
          export const logEvent = () => {}, prefetchAllMcpResources = () => {};
          export const BashTool = { name: 'Bash' }, FileEditTool = { name: 'Edit' }, FileWriteTool = { name: 'Write' };
          export const normalizeFileEditInput = value => value, stripTrailingWhitespace = value => value;
          export const getTools = () => [], roughTokenCountEstimation = () => 0;
          export const AGENT_TOOL_NAME = 'Agent', EXIT_PLAN_MODE_V2_TOOL_NAME = 'ExitPlanMode', TASK_OUTPUT_TOOL_NAME = 'TaskOutput';
          export const isAgentSwarmsEnabled = () => true;
          export const modelSupportsStructuredOutputs = model => model === 'strict-model' || model.endsWith('/strict-model');
          export const shouldUseGlobalCacheScope = () => false;
          export const getCwd = () => '/', logForDebugging = () => {};
          export const isEnvTruthy = () => false, createUserMessage = value => value;
          export const getAPIProvider = () => effects.provider, isFirstPartyAnthropicBaseUrl = () => true;
          export const getFileReadIgnorePatterns = () => [], normalizePatternsToPath = value => value;
          export const getPlan = () => '', getPlanFilePath = () => '', persistFileSnapshotIfRemote = () => {};
          export const getPlatform = () => 'linux', countFilesRoundedRg = () => 0;
          export const jsonStringify = JSON.stringify, windowsPathToPosixPath = value => value;
          export const zodToJsonSchema = () => ({ type: 'object', properties: {} });
        `,
      }))
    },
  }] })
  if (!output.success) throw new Error(output.logs.map(log => log.message).join('\n'))
  const bundlePath = join(directory, 'schema-cache.mjs')
  await Bun.write(bundlePath, output.outputs[0]!)
  harness = await import(pathToFileURL(bundlePath).href)
  writeFileSync(configPath, JSON.stringify({ providers: {
    alpha: { api: 'anthropic', baseURL: 'https://alpha.example', defaultModel: 'strict-model', models: [{ id: 'strict-model' }, { id: 'plain-model' }] },
    beta: { api: 'openai-responses', baseURL: 'https://beta.example/v1', defaultModel: 'strict-model', models: [{ id: 'strict-model' }] },
  } }))
})

beforeEach(() => {
  harness.initializeProviderRuntime({ configPath, env: {} })
  harness.clearToolSchemaCache()
  Object.assign(harness.effects, { provider: 'firstParty', strict: true, eager: true })
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function tool(prompt: Tool['prompt'], name = 'ToolSearch'): Tool {
  return { name, prompt, strict: true, inputJSONSchema: { type: 'object', properties: {} } } as Tool
}
function options(model?: string): Parameters<typeof harness.toolToAPISchema>[1] {
  return { model, tools: [], agents: [], getToolPermissionContext: async () => ({ mode: 'default' }) as ToolPermissionContext }
}

describe('tool schema cache execution boundaries', () => {
  test('legacy retains stable schemas while model and provider capabilities are isolated', async () => {
    let renderCount = 0
    const sharedTool = tool(async () => `render ${++renderCount}`)
    const strict = await harness.toolToAPISchema(sharedTool, { ...options('strict-model'), deferLoading: true })
    const strictAgain = await harness.toolToAPISchema(sharedTool, options('strict-model'))
    const plain = await harness.toolToAPISchema(sharedTool, options('plain-model'))
    harness.effects.provider = 'bedrock'
    const cloud = await harness.toolToAPISchema(sharedTool, options('strict-model'))
    expect(strict).toMatchObject({ description: 'render 1', strict: true, eager_input_streaming: true, defer_loading: true })
    expect(strictAgain).toMatchObject({ description: 'render 1', strict: true })
    expect(strictAgain).not.toHaveProperty('defer_loading')
    expect(plain).toHaveProperty('description', 'render 2')
    expect(plain).not.toHaveProperty('strict')
    expect(cloud).toHaveProperty('description', 'render 3')
    expect(cloud).not.toHaveProperty('eager_input_streaming')
    expect(renderCount).toBe(3)
  })

  test('concurrent profile and legacy prompts retain their execution identity across awaits', async () => {
    const sharedTool = tool(async () => {
      await Promise.resolve()
      return harness.getExecutionProviderProfile()?.id ?? 'legacy'
    })
    const alpha = harness.createProviderExecutionContext('alpha/strict-model')
    const beta = harness.createProviderExecutionContext('beta/strict-model')
    const legacy = harness.createProviderExecutionContext('strict-model')
    const [first, second, third] = await Promise.all([
      harness.runWithProviderExecutionContext(alpha, () => harness.toolToAPISchema(sharedTool, options('alpha/strict-model'))),
      harness.runWithProviderExecutionContext(beta, () => harness.toolToAPISchema(sharedTool, options('beta/strict-model'))),
      harness.runWithProviderExecutionContext(legacy, () => harness.toolToAPISchema(sharedTool, options('strict-model'))),
    ])
    expect(first).toHaveProperty('description', 'alpha')
    expect(second).toHaveProperty('description', 'beta')
    expect(third).toHaveProperty('description', 'legacy')
    expect(first).not.toHaveProperty('eager_input_streaming')
    expect(second).not.toHaveProperty('eager_input_streaming')
  })

  test('same profile/model agents render their own registry and permission prompt', async () => {
    let renderCount = 0
    const sharedTool = tool(async ({ tools, getToolPermissionContext }) => {
      renderCount++
      const permission = await getToolPermissionContext()
      return `${permission.mode}:${tools.map(tool => tool.name).join(',')}`
    })
    const alpha = harness.createProviderExecutionContext('alpha/strict-model')
    const [parent, child] = await Promise.all([
      harness.runWithProviderExecutionContext(alpha, () => harness.toolToAPISchema(sharedTool, { ...options(), tools: [tool(async () => '', 'Read')] })),
      harness.runWithProviderExecutionContext(alpha, () => harness.toolToAPISchema(sharedTool, { ...options(), tools: [tool(async () => '', 'Bash')], getToolPermissionContext: async () => ({ mode: 'plan' }) as ToolPermissionContext })),
    ])
    expect(parent).toHaveProperty('description', 'default:Read')
    expect(child).toHaveProperty('description', 'plan:Bash')
    expect(renderCount).toBe(2)
  })

  test('omitted model uses the execution model for both namespace and capabilities', async () => {
    let renderCount = 0
    const sharedTool = tool(async () => `render ${++renderCount}`)
    const strictScope = harness.createProviderExecutionContext('strict-model')
    const plainScope = harness.createProviderExecutionContext('plain-model')
    const strict = await harness.runWithProviderExecutionContext(strictScope, () => harness.toolToAPISchema(sharedTool, options()))
    const plain = await harness.runWithProviderExecutionContext(plainScope, () => harness.toolToAPISchema(sharedTool, options()))
    const explicit = await harness.toolToAPISchema(sharedTool, options('strict-model'))
    expect(strict).toHaveProperty('strict', true)
    expect(plain).not.toHaveProperty('strict')
    expect(explicit).toHaveProperty('description', 'render 1')
    expect(renderCount).toBe(2)
  })

  test('cache invalidation detaches in-flight renders from the new cache generation', async () => {
    let releaseOld!: (value: string) => void
    const heldPrompt = new Promise<string>(resolve => { releaseOld = resolve })
    const pending = harness.toolToAPISchema(tool(() => heldPrompt), options('strict-model'))
    harness.clearToolSchemaCache()
    const fresh = await harness.toolToAPISchema(tool(async () => 'new generation'), options('strict-model'))
    releaseOld('old generation')
    expect(await pending).toHaveProperty('description', 'old generation')
    expect(fresh).toHaveProperty('description', 'new generation')
    const cached = await harness.toolToAPISchema(tool(async () => 'must remain cached'), options('strict-model'))
    expect(cached).toHaveProperty('description', 'new generation')
  })

  test('failed prompt rendering never caches partial schemas', async () => {
    await expect(harness.toolToAPISchema(tool(async () => { throw new Error('prompt unavailable') }), options('strict-model'))).rejects.toThrow('prompt unavailable')
    expect(await harness.toolToAPISchema(tool(async () => 'recovered'), options('strict-model'))).toHaveProperty('description', 'recovered')
  })

  test('input schemas and per-request cache overlays remain distinct', async () => {
    const firstTool = tool(async () => 'schema')
    const secondTool = { ...firstTool, inputJSONSchema: { type: 'object', properties: { filename: { type: 'string' } } } } as Tool
    const first = await harness.toolToAPISchema(firstTool, { ...options('strict-model'), cacheControl: { type: 'ephemeral' } })
    const second = await harness.toolToAPISchema(secondTool, options('strict-model'))
    expect(first).toHaveProperty('input_schema', { type: 'object', properties: {} })
    expect(second).toHaveProperty('input_schema', secondTool.inputJSONSchema)
    expect(second).not.toHaveProperty('cache_control')
  })
})
