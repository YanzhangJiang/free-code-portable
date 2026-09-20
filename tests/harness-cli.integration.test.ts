import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binary = process.env.FREE_CODE_TEST_BINARY
const cliTest = binary ? test : test.skip

type ChatRequest = {
  model: string
  max_tokens?: number
  stream?: boolean
  system?: unknown
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>
  tools?: Array<{ type?: string; name?: string; function?: { name: string; parameters: Record<string, unknown> } }>
}

type CapturedRequest = {
  path: string
  authorization: string | null
  anthropicKey: string | null
  body: ChatRequest
}

type Fixture = {
  workspace: string
  baseURL: string
  requests: CapturedRequest[]
  searchRequests: Array<{ query: string | null; format: string | null; authorization: string | null }>
  unexpectedRequests: string[]
}

function completion(body: ChatRequest, content: string | { id: string; name: string; input: Record<string, unknown> }, inputTokens = 100): Response {
  const envelope = { id: `chatcmpl-${crypto.randomUUID()}`, model: body.model, created: 1 }
  const message = typeof content === 'string'
    ? { role: 'assistant', content }
    : { role: 'assistant', content: null, tool_calls: [{ id: content.id, type: 'function', function: { name: content.name, arguments: JSON.stringify(content.input) } }] }
  const finishReason = typeof content === 'string' ? 'stop' : 'tool_calls'
  const usage = { prompt_tokens: inputTokens, completion_tokens: 20 }
  if (!body.stream) {
    return Response.json({ ...envelope, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finishReason }], usage })
  }
  const delta = 'tool_calls' in message
    ? { ...message, tool_calls: message.tool_calls!.map((call, index) => ({ index, ...call })) }
    : message
  const chunks = [
    { ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
    { ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    { ...envelope, object: 'chat.completion.chunk', choices: [], usage },
  ]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function withHarness<T>(
  respond: (body: ChatRequest, path: string, fixture: Fixture) => Response,
  run: (fixture: Fixture) => Promise<T>,
): Promise<T> {
  const workspace = mkdtempSync(join(tmpdir(), 'free-code-harness-cli-'))
  const fixture: Fixture = { workspace, baseURL: '', requests: [], searchRequests: [], unexpectedRequests: [] }
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/search' && request.method === 'GET') {
          fixture.searchRequests.push({ query: url.searchParams.get('q'), format: url.searchParams.get('format'), authorization: request.headers.get('authorization') })
          return Response.json({ results: [{ title: 'Harness reference', url: 'https://example.org/harness-reference', content: 'search-evidence-9bfe01' }] })
        }
        if (request.method === 'POST' && (/^\/(main|child)\/v1\/chat\/completions$/.test(url.pathname) || url.pathname === '/messages/v1/messages')) {
          const body = await request.json() as ChatRequest
          fixture.requests.push({ path: url.pathname, authorization: request.headers.get('authorization'), anthropicKey: request.headers.get('x-api-key'), body })
          return respond(body, url.pathname, fixture)
        }
        // This endpoint also serves as the subprocess's fail-closed HTTP proxy.
        // A mistaken external API request cannot be forwarded to a paid service.
        fixture.unexpectedRequests.push(`${request.method} ${url.pathname}`)
        return Response.json({ error: { message: 'Unexpected network destination in offline harness test' } }, { status: 403 })
      },
    })
    fixture.baseURL = `http://127.0.0.1:${server.port}`
    mkdirSync(join(workspace, 'config'))
    return await run(fixture)
  } finally {
    await server?.stop(true)
    rmSync(workspace, { recursive: true, force: true })
  }
}

function configure(fixture: Fixture, contextWindow = 128_000, includeChild = false): void {
  const profile = (path: string, model: string, key: string) => ({
    api: 'openai-completions', baseURL: `${fixture.baseURL}/${path}/v1`, apiKeyEnv: key,
    defaultModel: model, smallModel: `${model}-small`,
    models: [model, `${model}-small`].map(id => ({ id, contextWindow, maxOutputTokens: 4096 })),
  })
  writeFileSync(join(fixture.workspace, 'providers.json'), JSON.stringify({
    providers: {
      main: profile('main', 'MainExact', 'MAIN_KEY'),
      ...(includeChild ? { child: profile('child', 'ChildExact', 'CHILD_KEY') } : {}),
    },
  }))
}

async function runHarness(fixture: Fixture, tools: string[], prompt: string, options: { disablePromptCaching?: boolean } = {}) {
  const child = Bun.spawn({
    cmd: [binary!, '--provider', 'main', '--model', 'main/MainExact',
      '--tools', tools.join(','), '--allowedTools', tools.join(','),
      '--no-session-persistence', '--setting-sources', '', '--output-format', 'json',
      '--max-turns', '8', '-p', prompt],
    cwd: fixture.workspace,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir(),
      CLAUDE_CONFIG_DIR: join(fixture.workspace, 'config'),
      FREE_CODE_PROVIDERS_FILE: join(fixture.workspace, 'providers.json'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      MAIN_KEY: 'main-test-credential', CHILD_KEY: 'child-test-credential',
      HTTP_PROXY: fixture.baseURL, HTTPS_PROXY: fixture.baseURL,
      NO_PROXY: '127.0.0.1,localhost,::1',
      ...(options.disablePromptCaching ? { DISABLE_PROMPT_CACHING: '1' } : {}),
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    if (timedOut) throw new Error(`Harness CLI timed out. stdout: ${stdout}\nstderr: ${stderr}`)
    if (exitCode !== 0) throw new Error(`Harness CLI exited ${exitCode}. stdout: ${stdout}\nstderr: ${stderr}`)
    return { output: JSON.parse(stdout), stderr }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
}

function assertProfileTraffic(fixture: Fixture): void {
  expect(fixture.unexpectedRequests).toEqual([])
  for (const request of fixture.requests) {
    const child = request.path.startsWith('/child/')
    expect(request.authorization).toBe(child ? 'Bearer child-test-credential' : 'Bearer main-test-credential')
    expect(request.anthropicKey).toBeNull()
    expect(request.body.model).toMatch(child ? /^ChildExact(?:-small)?$/ : /^MainExact(?:-small)?$/)
  }
}

cliTest('CLI uses the independent SearXNG service and returns its evidence through WebSearch', async () => {
  await withHarness((body) => {
    const searchResult = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'search_reference')
    return searchResult
      ? completion(body, 'search-tool-loop-complete')
      : completion(body, { id: 'search_reference', name: 'WebSearch', input: { query: 'harness reference' } })
  }, async fixture => {
    configure(fixture)
    writeFileSync(join(fixture.workspace, 'config', 'services.json'), JSON.stringify({ webSearch: { provider: 'searxng', baseURL: fixture.baseURL } }))
    const result = await runHarness(fixture, ['WebSearch'], 'Search for the harness reference, then report its evidence.')
    expect(result.output.subtype).toBe('success')
    expect(result.output.result).toBe('search-tool-loop-complete')
    expect(result.stderr).toBe('')
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[0]!.body.tools?.map(tool => tool.function?.name)).toContain('WebSearch')
    const toolResult = fixture.requests[1]!.body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'search_reference')
    expect(JSON.stringify(toolResult?.content)).toContain('search-evidence-9bfe01')
    expect(JSON.stringify(toolResult?.content)).toContain('https://example.org/harness-reference')
    expect(fixture.searchRequests).toEqual([{ query: 'harness reference', format: 'json', authorization: null }])
    assertProfileTraffic(fixture)
  })
}, 35_000)

cliTest('CLI compacts a 16k profile with a bounded summary and resumes its Read tool task', async () => {
  let mainCalls = 0
  let summaryCalls = 0
  await withHarness((body, _path, fixture) => {
    const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    if (system.includes('tasked with summarizing conversations')) {
      summaryCalls++
      return completion(body, 'compact-continuation-evidence: Read first.txt and second.txt successfully. Both fixture values are available. The only remaining task is to report compact-tool-loop-complete.', 200)
    }
    mainCalls++
    if (mainCalls <= 2) {
      return completion(body, { id: `read_${mainCalls}`, name: 'Read', input: { file_path: join(fixture.workspace, mainCalls === 1 ? 'first.txt' : 'second.txt') } }, mainCalls === 2 ? 11_500 : 100)
    }
    return completion(body, 'compact-tool-loop-complete', 350)
  }, async fixture => {
    configure(fixture, 16_384)
    writeFileSync(join(fixture.workspace, 'first.txt'), 'first-read-evidence-e825')
    writeFileSync(join(fixture.workspace, 'second.txt'), 'second-read-evidence-60b2')
    const result = await runHarness(fixture, ['Read'], 'Read first.txt and second.txt with the Read tool, then report success.')
    expect(result.output.subtype).toBe('success')
    expect(result.output.result).toBe('compact-tool-loop-complete')
    expect(summaryCalls).toBe(1)
    expect(mainCalls).toBe(3)
    const compact = fixture.requests.find(request => request.body.messages.some(message => message.role === 'system' && String(message.content).includes('tasked with summarizing conversations')))!
    expect(compact.body.max_tokens).toBe(2048)
    expect(compact.body.tools?.map(tool => tool.function?.name) ?? []).toEqual(['Read'])
    expect(JSON.stringify(compact.body.messages)).toContain('first-read-evidence-e825')
    expect(JSON.stringify(compact.body.messages)).toContain('second-read-evidence-60b2')
    const summaryPrompt = compact.body.messages.at(-1)
    expect(JSON.stringify(summaryPrompt?.content)).toContain('at most 1638 tokens')
    expect(JSON.stringify(summaryPrompt?.content).length).toBeLessThan(900)
    expect(JSON.stringify(summaryPrompt?.content)).not.toContain('<analysis>')
    const resumed = fixture.requests.at(-1)!
    expect(JSON.stringify(resumed.body.messages)).toContain('compact-continuation-evidence')
    expect(resumed.body.max_tokens).toBe(4096)
    assertProfileTraffic(fixture)
  })
}, 35_000)

function messagesCompletion(request: ChatRequest): Response {
  const message = {
    id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model: request.model,
    content: [{ type: 'text', text: 'cache-capability-complete' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 },
  }
  if (!request.stream) return Response.json(message)
  const events = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cache-capability-complete' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function cacheControls(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, entry]) => key === 'cache_control'
    ? [entry as Record<string, unknown>]
    : cacheControls(entry))
}

cliTest('CLI sends only explicitly enabled Messages cache markers and honors the cache kill switch', async () => {
  await withHarness(body => messagesCompletion(body), async fixture => {
    for (const mode of ['default', 'ephemeral', 'disabled-by-env'] as const) {
      writeFileSync(join(fixture.workspace, 'providers.json'), JSON.stringify({ providers: { main: {
        api: 'anthropic', baseURL: `${fixture.baseURL}/messages`, apiKeyEnv: 'MAIN_KEY', defaultModel: 'MainExact',
        models: [{ id: 'MainExact', contextWindow: 128_000, maxOutputTokens: 4096,
          ...(mode === 'default' ? {} : { promptCaching: 'ephemeral' }),
        }],
      } } }))
      const result = await runHarness(fixture, ['Read'], 'Reply that the cache capability check completed.', { disablePromptCaching: mode === 'disabled-by-env' })
      expect(result.output.subtype).toBe('success')
      expect(result.output.result).toBe('cache-capability-complete')
      const request = fixture.requests.at(-1)!
      expect(request.path).toBe('/messages/v1/messages')
      expect(request.body.model).toBe('MainExact')
      expect(request.authorization).toBeNull()
      expect(request.anthropicKey).toBe('main-test-credential')
      const markers = cacheControls(request.body)
      if (mode === 'ephemeral') {
        expect(markers.length).toBeGreaterThan(0)
        for (const marker of markers) {
          expect(marker.type).toBe('ephemeral')
          expect(marker.ttl).toBeUndefined()
        }
      } else expect(markers).toEqual([])
    }
    expect(fixture.requests).toHaveLength(3)
    expect(fixture.unexpectedRequests).toEqual([])
  })
}, 95_000)

cliTest('CLI routes an explicit Agent model to a second provider while the parent retains its credentials', async () => {
  await withHarness((body, path, fixture) => {
    if (path.startsWith('/child/')) {
      const read = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'child_read')
      return read
        ? completion(body, 'child-agent-evidence-493b')
        : completion(body, { id: 'child_read', name: 'Read', input: { file_path: join(fixture.workspace, 'child.txt') } })
    }
    const agentResult = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'delegate_task')
    return agentResult
      ? completion(body, 'cross-provider-agent-complete')
      : completion(body, { id: 'delegate_task', name: 'Agent', input: { description: 'Read child fixture file', prompt: 'Read child.txt and report its exact contents.', subagent_type: 'general-purpose', model: 'child/ChildExact' } })
  }, async fixture => {
    configure(fixture, 128_000, true)
    writeFileSync(join(fixture.workspace, 'child.txt'), 'child-file-evidence-e7c3')
    const result = await runHarness(fixture, ['Agent', 'Read'], 'Delegate reading child.txt to the child/ChildExact model, then report the result.')
    expect(result.output.subtype).toBe('success')
    expect(result.output.result).toBe('cross-provider-agent-complete')
    const mainRequests = fixture.requests.filter(request => request.path.startsWith('/main/'))
    const childRequests = fixture.requests.filter(request => request.path.startsWith('/child/'))
    expect(mainRequests).toHaveLength(2)
    const delegatedResult = mainRequests[1]!.body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'delegate_task')
    expect(JSON.stringify(delegatedResult?.content)).toContain('child-agent-evidence-493b')
    expect(childRequests).toHaveLength(2)
    expect(JSON.stringify(childRequests[1]!.body.messages)).toContain('child-file-evidence-e7c3')
    expect(mainRequests.every(request => request.body.model === 'MainExact')).toBe(true)
    expect(childRequests.every(request => request.body.model === 'ChildExact')).toBe(true)
    assertProfileTraffic(fixture)
  })
}, 35_000)
