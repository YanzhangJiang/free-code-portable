import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binary = process.env.FREE_CODE_TEST_BINARY
const cliTest = binary ? test : test.skip
const fixtureContents = 'provider-cli-fixture-7fdcc279'
const finalMarker = 'provider-cli-tool-loop-complete'

type ChatRequest = {
  model: string
  stream?: boolean
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>
  tools?: Array<{ type: string; function: { name: string; parameters: { type: string; properties: Record<string, unknown>; required?: string[] } } }>
}

type CapturedRequest = {
  method: string
  path: string
  authorization: string | null
  anthropicKey: string | null
  body: ChatRequest
}

function mockCompletion(body: ChatRequest, message: Record<string, unknown>, finishReason: string, usage: { prompt_tokens: number; completion_tokens: number }): Response {
  const envelope = { id: 'chatcmpl-cli-integration', model: 'ExactModel', created: 1 }
  if (!body.stream) {
    return Response.json({ ...envelope, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finishReason }], usage })
  }
  const delta = { ...message }
  if (Array.isArray(delta.tool_calls)) {
    delta.tool_calls = delta.tool_calls.map((call, index) => ({ index, ...call }))
  }
  const chunks = [
    { ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
    { ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    { ...envelope, object: 'chat.completion.chunk', choices: [], usage },
  ]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function runCLI(configurationPath: string, workspace: string, options: { provider?: string; model?: string; includeKey?: boolean } = {}) {
  const child = Bun.spawn({
    cmd: [
      binary!, '--bare', '--provider', options.provider ?? 'test',
      '--model', options.model ?? 'test/ExactModel', '--tools', 'Read', '--allowedTools', 'Read',
      '--no-session-persistence', '--setting-sources', '', '--output-format', 'json',
      '--max-turns', '3', '-p', 'Read input.txt with the Read tool, then report that it was read.',
    ],
    cwd: workspace,
    // Deliberately build an environment from scratch: user tokens, proxy settings,
    // provider flags, and real configuration are not inherited by the subprocess.
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      CLAUDE_CONFIG_DIR: join(workspace, 'config'),
      FREE_CODE_PROVIDERS_FILE: configurationPath,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(options.includeKey === false ? {} : { TEST_API_KEY: 'integration-test-key' }),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, 16_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (timedOut) throw new Error(`Provider CLI timed out. stdout: ${stdout}\nstderr: ${stderr}`)
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
}

async function withLocalProvider<T>(run: (workspace: string, configPath: string, requests: CapturedRequest[]) => Promise<T>): Promise<T> {
  const workspace = mkdtempSync(join(tmpdir(), 'free-code-cli-provider-'))
  const requests: CapturedRequest[] = []
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = await request.json() as ChatRequest
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          authorization: request.headers.get('authorization'),
          anthropicKey: request.headers.get('x-api-key'),
          body,
        })
        const toolResult = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'read_input')
        if (toolResult) {
          if (!JSON.stringify(toolResult.content).includes(fixtureContents)) {
            return Response.json({ error: { message: 'Read tool did not return the fixture contents' } }, { status: 400 })
          }
          return mockCompletion(body, { role: 'assistant', content: finalMarker }, 'stop', { prompt_tokens: 120, completion_tokens: 20 })
        }
        return mockCompletion(body, {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'read_input', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: join(workspace, 'input.txt') }) } }],
        }, 'tool_calls', { prompt_tokens: 100, completion_tokens: 10 })
      },
    })
    mkdirSync(join(workspace, 'config'))
    writeFileSync(join(workspace, 'input.txt'), fixtureContents)
    const configPath = join(workspace, 'providers.json')
    writeFileSync(configPath, JSON.stringify({
      providers: {
        test: {
          api: 'openai-completions',
          baseURL: `http://127.0.0.1:${server.port}/mock/v1`,
          apiKeyEnv: 'TEST_API_KEY',
          models: [{ id: 'ExactModel', contextWindow: 128_000, maxOutputTokens: 4096 }],
          defaultModel: 'ExactModel',
        },
      },
    }))
    return await run(workspace, configPath, requests)
  } finally {
    await server?.stop(true)
    rmSync(workspace, { recursive: true, force: true })
  }
}

cliTest('CLI completes a configured provider Read tool round trip with exact model and usage', async () => {
  await withLocalProvider(async (workspace, configPath, requests) => {
    const result = await runCLI(configPath, workspace)
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.type).toBe('result')
    expect(output.subtype).toBe('success')
    expect(output.is_error).toBe(false)
    expect(output.result).toBe(finalMarker)
    expect(output.usage).toMatchObject({ input_tokens: 220, output_tokens: 30 })
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.method).toBe('POST')
      expect(request.path).toBe('/mock/v1/chat/completions')
      expect(request.authorization).toBe('Bearer integration-test-key')
      expect(request.anthropicKey).toBeNull()
      expect(request.body.model).toBe('ExactModel')
      const readTool = request.body.tools?.find(tool => tool.function.name === 'Read')
      expect(readTool?.type).toBe('function')
      expect(readTool?.function.parameters.type).toBe('object')
      expect(readTool?.function.parameters.properties.file_path).toBeDefined()
      expect(readTool?.function.parameters.required).toContain('file_path')
    }
    const returnedFile = requests[1]!.body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'read_input')
    expect(JSON.stringify(returnedFile?.content)).toContain(fixtureContents)
  })
}, 20_000)

cliTest('CLI rejects a missing provider key before any model request', async () => {
  await withLocalProvider(async (workspace, configPath, requests) => {
    const result = await runCLI(configPath, workspace, { includeKey: false })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('TEST_API_KEY')
    expect(requests).toHaveLength(0)
  })
}, 20_000)

cliTest('CLI rejects an unknown provider before any model request', async () => {
  await withLocalProvider(async (workspace, configPath, requests) => {
    const result = await runCLI(configPath, workspace, { provider: 'unknown', model: 'ExactModel' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('Unknown provider')
    expect(requests).toHaveLength(0)
  })
}, 20_000)
