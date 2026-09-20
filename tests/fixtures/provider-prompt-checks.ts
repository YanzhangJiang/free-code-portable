import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise the real prompt composition without reading user settings, launching
// processes, or initializing the application's network services.
const stub = (path: string, exports: Record<string, unknown>) => {
  mock.module(new URL(`../../src/${path}`, import.meta.url).pathname, () => exports)
}
let fastModeAvailable = false
stub('utils/env.ts', { env: { platform: 'linux' } })
stub('utils/git.ts', { getIsGit: async () => true })
stub('utils/cwd.ts', { getCwd: () => '/workspace' })
stub('bootstrap/state.ts', { getIsNonInteractiveSession: () => false })
stub('utils/worktree.ts', { getCurrentWorktreeSession: () => null })
stub('constants/common.ts', { getSessionStartDate: () => '2026-09-21' })
stub('utils/settings/settings.ts', { getInitialSettings: () => ({}) })
stub('utils/model/model.ts', { getCanonicalName: (model: string) => model, getMarketingNameForModel: () => undefined })
stub('commands.ts', { getSkillToolCommands: async () => [] })
stub('constants/outputStyles.ts', { getOutputStyleConfig: async () => null })
stub('utils/embeddedTools.ts', { hasEmbeddedSearchTools: () => false })
stub('tools/AgentTool/built-in/exploreAgent.ts', { EXPLORE_AGENT: { agentType: 'Explore' }, EXPLORE_AGENT_MIN_QUERIES: 3 })
stub('tools/AgentTool/builtInAgents.ts', { areExplorePlanAgentsEnabled: () => false })
stub('utils/permissions/filesystem.ts', { isScratchpadEnabled: () => false, getScratchpadDir: () => '/scratchpad' })
stub('tools/REPLTool/constants.ts', { isReplModeEnabled: () => false })
stub('services/analytics/growthbook.ts', { getFeatureValue_CACHED_MAY_BE_STALE: (_name: string, fallback: unknown) => fallback })
stub('utils/betas.ts', { shouldUseGlobalCacheScope: () => false })
stub('tools/AgentTool/forkSubagent.ts', { isForkSubagentEnabled: () => true })
stub('constants/systemPromptSections.ts', {
  systemPromptSection: (_name: string, compute: () => unknown) => compute,
  DANGEROUS_uncachedSystemPromptSection: (_name: string, compute: () => unknown) => compute,
  resolveSystemPromptSections: async (sections: (() => unknown)[]) => Promise.all(sections.map(compute => compute())),
})
stub('utils/debug.ts', { logForDebugging: () => {} })
stub('memdir/memdir.ts', { loadMemoryPrompt: async () => 'Project memory instructions' })
stub('utils/undercover.ts', { isUndercover: () => false })
stub('utils/mcpInstructionsDelta.ts', { isMcpInstructionsDeltaEnabled: () => false })
stub('utils/fastMode.ts', { isFastModeAvailable: () => fastModeAvailable })
stub('utils/pdfUtils.ts', { isPDFSupported: () => false })
stub('utils/auth.ts', { getSubscriptionType: () => null })
stub('utils/teammate.ts', { isTeammate: () => false })
stub('utils/teammateContext.ts', { isInProcessTeammate: () => false })
stub('utils/model/providers.ts', { getAPIProvider: () => 'firstParty' })
stub('utils/workloadContext.ts', { getWorkload: () => undefined })
stub('services/analytics/index.ts', { logEvent: () => {} })
stub('tools/AgentTool/loadAgentsDir.ts', { isBuiltInAgent: (agent: { source: string }) => agent.source === 'built-in' })
Object.assign(globalThis, { MACRO: { ISSUES_EXPLAINER: 'use the repository issue tracker', VERSION: 'test' } })

const runtime = await import('../../src/providers/runtime.js')
const prompts = await import('../../src/constants/prompts.js')
const agentPrompt = await import('../../src/tools/AgentTool/prompt.js')
const readPrompt = await import('../../src/tools/FileReadTool/prompt.js')
const effectivePrompt = await import('../../src/utils/systemPrompt.js')
const system = await import('../../src/constants/system.js')
const generalPurpose = await import('../../src/tools/AgentTool/built-in/generalPurposeAgent.js')
const directory = mkdtempSync(join(tmpdir(), 'free-code-prompt-checks-'))
try {
  const configPath = join(directory, 'providers.json')
  writeFileSync(configPath, JSON.stringify({ providers: {
    local: { api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', defaultModel: 'claude-opus-4-6', models: [
      { id: 'claude-opus-4-6', contextWindow: 16_384, maxOutputTokens: 2048, vision: false },
    ] },
    other: { api: 'anthropic', baseURL: 'https://example.invalid', defaultModel: 'Visual', models: [
      { id: 'Visual', contextWindow: 128_000, maxOutputTokens: 8192, vision: true },
    ] },
  } }))
  runtime.initializeProviderRuntime({ configPath, provider: 'local', env: {} })
  const tools = [{ name: 'Read' }, { name: 'Edit' }, { name: 'WebSearch' }] as Parameters<typeof prompts.getSystemPrompt>[0]
  const main = (await prompts.getSystemPrompt(tools, 'local/claude-opus-4-6')).join('\n')
  assert(main.includes('independent agent harness'))
  assert(main.includes('Use WebSearch'))
  assert(main.includes('exact text replacement'))
  assert(main.includes('configured for text input'))
  assert(main.includes('16384 tokens'))
  assert(main.includes('Project memory instructions'))
  assert(!main.includes("Anthropic's official"))
  assert(!main.includes('latest and most capable Claude'))
  assert(!main.includes('knowledge cutoff'))
  assert(!main.includes('/fast'))
  assert(!main.includes('unlimited context'))
  assert.equal(system.getAttributionHeader('fixture', 'local/claude-opus-4-6'), '')
  assert.equal(system.getAttributionHeader('fixture'), '')
  const requestPrefix = system.getCLISyspromptPrefix({ isNonInteractive: true, hasAppendSystemPrompt: false, model: 'local/claude-opus-4-6' })
  assert(requestPrefix.includes('independent agent harness'))
  assert(!requestPrefix.includes("Anthropic's official"))
  assert(system.CLI_SYSPROMPT_PREFIXES.has(requestPrefix))
  assert(![system.getAttributionHeader('fixture', 'local/claude-opus-4-6'), requestPrefix, main].filter(Boolean).join('\n').includes("Anthropic's official"))

  // An explicitly requested other-provider model determines its prompt even
  // while the foreground provider remains selected.
  const other = (await prompts.getSystemPrompt([{ name: 'Read' }] as typeof tools, 'other/Visual')).join('\n')
  assert(other.includes('other/Visual'))
  assert(other.includes('128000 tokens'))
  assert(other.includes('configured to accept images'))
  assert(!other.includes('Use WebSearch'))
  assert(!other.includes('local/claude'))
  assert.equal(runtime.getActiveProviderProfile()?.id, 'local')

  const subagent = (await prompts.enhanceSystemPromptWithEnvDetails([prompts.DEFAULT_AGENT_PROMPT], 'other/Visual', undefined, new Set(['Read']))).join('\n')
  assert(subagent.includes('independent agent harness'))
  assert(subagent.includes('other/Visual'))
  assert(!subagent.includes("Anthropic's official"))
  assert(subagent.includes('configured to accept images'))
  const generalAgent = (await prompts.enhanceSystemPromptWithEnvDetails([
    generalPurpose.GENERAL_PURPOSE_AGENT.getSystemPrompt({ toolUseContext: { options: { tools } } } as never),
  ], 'local/claude-opus-4-6')).join('\n')
  assert(!generalAgent.includes("Anthropic's official"))
  assert(generalAgent.includes('independent agent harness'))
  const specialist = 'Custom instructions supplied by the user'
  const custom = await prompts.enhanceSystemPromptWithEnvDetails([specialist], 'local/claude-opus-4-6')
  assert(custom.includes(specialist))

  const promptOptions = {
    mainThreadAgentDefinition: { source: 'built-in', getSystemPrompt: () => 'Specialist instructions' },
    toolUseContext: { options: { mainLoopModel: 'other/Visual', tools } },
    defaultSystemPrompt: ['Default instructions'],
    customSystemPrompt: undefined,
    appendSystemPrompt: 'Appended instructions',
  } as Parameters<typeof effectivePrompt.buildEffectiveSystemPrompt>[0]
  const builtInMain = effectivePrompt.buildEffectiveSystemPrompt(promptOptions).join('\n')
  assert(builtInMain.includes('other/Visual'))
  assert(builtInMain.includes('configured to accept images'))
  assert(builtInMain.includes('Specialist instructions'))
  assert(!builtInMain.includes('Default instructions'))
  assert(builtInMain.includes('Appended instructions'))
  assert.deepEqual(effectivePrompt.buildEffectiveSystemPrompt({ ...promptOptions, overrideSystemPrompt: 'Exact override' }), ['Exact override'])
  assert.deepEqual(effectivePrompt.buildEffectiveSystemPrompt({ ...promptOptions, mainThreadAgentDefinition: undefined, customSystemPrompt: 'Exact custom prompt' }), ['Exact custom prompt', 'Appended instructions'])

  const delegation = await agentPrompt.getPrompt([])
  assert(delegation.includes('does not guarantee provider-side cache reuse'))
  assert(!delegation.includes('Forks are cheap'))
  assert(!delegation.includes('<thinking>'))
  const fileReading = readPrompt.renderPromptTemplate('', '', '')
  assert(!fileReading.includes('Claude Code is a multimodal'))
  assert(fileReading.includes('models configured for image input'))

  process.env.CLAUDE_CODE_SIMPLE = '1'
  const simple = (await prompts.getSystemPrompt(tools, 'local/claude-opus-4-6')).join('\n')
  assert(simple.includes('independent agent harness'))
  assert(!simple.includes("Anthropic's official"))
  delete process.env.CLAUDE_CODE_SIMPLE

  runtime.selectProviderProfile()
  const legacy = await prompts.computeSimpleEnvInfo('claude-opus-4-6')
  assert(legacy.includes('Claude Code is available'))
  assert(!legacy.includes('/fast'))
  fastModeAvailable = true
  assert((await prompts.computeSimpleEnvInfo('claude-opus-4-6')).includes('/fast'))
  assert(system.getCLISyspromptPrefix().includes("Anthropic's official"))
  assert(system.getAttributionHeader('fixture').includes('x-anthropic-billing-header:'))
  assert(system.getCLISyspromptPrefix({ isNonInteractive: true, hasAppendSystemPrompt: false, model: 'other/Visual' }).includes('independent agent harness'))
  assert.equal(system.getAttributionHeader('fixture', 'other/Visual'), '')
  console.log('provider prompt checks passed')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
