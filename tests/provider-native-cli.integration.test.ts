import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binary = process.env.FREE_CODE_TEST_BINARY
const cliTest = binary ? test : test.skip
const fixtureContents = 'native-history-cli-fixture'
const finalMarker = 'native-history-tool-loop-complete'
type WireObject = Record<string, any>

function response(body: WireObject, id: string, output: WireObject[]): Response {
  const message = { id, status: 'completed', output, usage: { input_tokens: 80, output_tokens: 12 } }
  if (!body.stream) return Response.json(message)
  const events = [
    { type: 'response.created', response: { ...message, output: [], status: 'in_progress' } },
    ...output.flatMap((item, outputIndex) => [
      { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : {}) } },
      { type: 'response.output_item.done', output_index: outputIndex, item },
    ]),
    { type: 'response.completed', response: message },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

async function runCLI(workspace: string, configPath: string, resume?: string) {
  const child = Bun.spawn({
    cmd: [binary!, '--bare', '--provider', 'test', '--model', 'test/ReasoningModel',
      '--tools', 'Read', '--allowedTools', 'Read', '--setting-sources', '',
      '--output-format', 'json', '--max-turns', '3', ...(resume ? ['--resume', resume] : []),
      '-p', resume ? 'Confirm your previous result.' : 'Read input.txt using Read, then report completion.'],
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir(),
      CLAUDE_CONFIG_DIR: join(workspace, 'config'),
      FREE_CODE_PROVIDERS_FILE: configPath,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      TEST_API_KEY: 'native-cli-test-key',
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 18_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (timedOut) throw new Error(`Native provider CLI timed out: ${stdout}\n${stderr}`)
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.is_error).toBe(false)
    expect(result.result).toBe(finalMarker)
    return result as WireObject
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
}

cliTest('CLI preserves encrypted Responses state and phase through Read and session resume', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'free-code-native-cli-'))
  const requests: WireObject[] = []
  const nativeOutput = [
    { type: 'reasoning', id: 'rs_native', summary: [], encrypted_content: 'encrypted-native-state' },
    { type: 'message', id: 'msg_commentary', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'I will read the fixture.', annotations: [] }] },
    { type: 'function_call', id: 'fc_read', call_id: 'read_input', name: 'Read', arguments: JSON.stringify({ file_path: join(workspace, 'input.txt') }), status: 'completed' },
  ]
  const finalOutput = [{ type: 'message', id: 'msg_final', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: finalMarker, annotations: [] }] }]
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as WireObject
      requests.push(body)
      expect(new URL(request.url).pathname).toBe('/v1/responses')
      expect(request.headers.get('authorization')).toBe('Bearer native-cli-test-key')
      expect(request.headers.has('x-api-key')).toBe(false)
      const result = body.input.find((item: WireObject) => item.type === 'function_call_output' && item.call_id === 'read_input')
      if (result) {
        if (!JSON.stringify(result.output).includes(fixtureContents)) return Response.json({ error: { message: 'Read fixture was not returned' } }, { status: 400 })
        return response(body, 'resp_final', finalOutput)
      }
      return response(body, 'resp_read', nativeOutput)
    } })
    mkdirSync(join(workspace, 'config'))
    writeFileSync(join(workspace, 'input.txt'), fixtureContents)
    const configPath = join(workspace, 'providers.json')
    writeFileSync(configPath, JSON.stringify({ providers: { test: {
      api: 'openai-responses', baseURL: `http://127.0.0.1:${server.port}/v1`, apiKeyEnv: 'TEST_API_KEY',
      defaultModel: 'ReasoningModel', models: [{ id: 'ReasoningModel', contextWindow: 128_000, maxOutputTokens: 4096, reasoning: true }],
    } } }))
    const first = await runCLI(workspace, configPath)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.input.filter((item: WireObject) => ['rs_native', 'msg_commentary', 'fc_read'].includes(item.id))).toEqual(nativeOutput)
    expect(requests[1]!.model).toBe('ReasoningModel')
    expect(typeof first.session_id).toBe('string')
    await runCLI(workspace, configPath, first.session_id)
    expect(requests).toHaveLength(3)
    expect(requests[2]!.input.filter((item: WireObject) => ['rs_native', 'msg_commentary', 'fc_read'].includes(item.id))).toEqual(nativeOutput)
    expect(requests[2]!.input.find((item: WireObject) => item.id === 'msg_final')).toEqual(finalOutput[0])
  } finally {
    await server?.stop(true)
    rmSync(workspace, { recursive: true, force: true })
  }
}, 45_000)
