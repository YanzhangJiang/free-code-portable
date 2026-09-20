import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { initializeProviderRuntime, resolveProviderModel, selectProviderProfile } from '../../providers/runtime.js'
import { createProfileClient } from './profile-client.js'
import { withoutProviderMetadata } from '../../providers/messages.js'
import { adaptMessagesClient } from './provider-client.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  initializeProviderRuntime({ env: { CLAUDE_CONFIG_DIR: '/nonexistent-free-code-test' } })
})

function configure() {
  const directory = mkdtempSync(join(tmpdir(), 'free-code-profile-client-'))
  directories.push(directory)
  const configPath = join(directory, 'providers.json')
  const model = { id: 'Vendor/Model', contextWindow: 16000, maxOutputTokens: 1024 }
  const thinkingModels = [
    { ...model, id: 'Vendor/Thinking', maxOutputTokens: 4096, reasoning: true },
    { ...model, id: 'Vendor/OtherThinking', maxOutputTokens: 4096, reasoning: true },
    { ...model, id: 'Vendor/TinyThinking', reasoning: true },
  ]
  writeFileSync(configPath, JSON.stringify({
    defaultProvider: 'one',
    providers: {
      one: { api: 'openai-completions', baseURL: 'https://one.example/v1', apiKeyEnv: 'ONE_KEY', defaultModel: model.id, models: [model] },
      two: { api: 'openai-completions', baseURL: 'https://two.example/v1', apiKeyEnv: 'TWO_KEY', defaultModel: model.id, models: [model] },
      messages: { api: 'anthropic', baseURL: 'https://messages.example', apiKeyEnv: 'ONE_KEY', defaultModel: model.id, models: [model, ...thinkingModels] },
      'messages-two': { api: 'anthropic', baseURL: 'https://messages-two.example', apiKeyEnv: 'TWO_KEY', defaultModel: model.id, models: [model, ...thinkingModels] },
      responses: { api: 'openai-responses', baseURL: 'https://responses.example/v1', apiKeyEnv: 'ONE_KEY', defaultModel: model.id, models: [model] },
      'responses-endpoint': { api: 'openai-responses', baseURL: 'https://responses.example/v1/responses/', apiKeyEnv: 'ONE_KEY', defaultModel: model.id, models: [model] },
    },
  }))
  initializeProviderRuntime({ configPath, env: { ONE_KEY: 'one-test-key', TWO_KEY: 'two-test-key' } })
}

function anthropicMessage(content: unknown[] = [{ type: 'text', text: 'ok' }]) {
  return {
    id: 'msg-test', type: 'message', role: 'assistant', model: 'Vendor/Thinking', content,
    stop_reason: content.some(block => (block as { type: string }).type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  }
}

const thinking = { type: 'thinking', thinking: 'Read the file', signature: 'signature-from-messages-profile' } as const
const tool = { type: 'tool_use', id: 'call_read', name: 'read_file', input: { path: 'a.ts' }, caller: { type: 'direct' } } as const
const toolResult: Anthropic.MessageParam = { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'file contents' }] }

function thinkingToolStream(): Response {
  const events = [
    { type: 'message_start', message: { ...anthropicMessage([]), stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinking.thinking } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: thinking.signature } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { ...tool, input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('profile API client isolation', () => {
  test.each(['json', 'stream'])('resumes %s Anthropic thinking from a transcript after runtime recreation', async mode => {
    configure()
    const first = createProfileClient(resolveProviderModel('messages/Vendor/Thinking')!, {
      maxRetries: 0, fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => mode === 'stream' ? thinkingToolStream() : Response.json(anthropicMessage([thinking, tool]))) as typeof fetch,
    })
    const request = { model: 'messages/Vendor/Thinking', max_tokens: 4096, messages: [{ role: 'user' as const, content: 'Read' }] }
    let content: any[]
    if (mode === 'json') content = (await adaptMessagesClient(first, { preserveNativeHistory: true }).createMessage(request)).data.content
    else {
      content = []
      for await (const event of (await adaptMessagesClient(first, { preserveNativeHistory: true }).streamMessages(request)).data) {
        if (event.type === 'content_block_start') content[event.index] = { ...event.content_block }
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'thinking_delta') content[event.index].thinking += event.delta.thinking
          if (event.delta.type === 'signature_delta') content[event.index].signature = event.delta.signature
          if (event.delta.type === 'input_json_delta') content[event.index].input = JSON.parse(event.delta.partial_json)
        }
        if (event.type === 'content_block_stop' && 'providerMetadata' in event) content[event.index].providerMetadata = event.providerMetadata
      }
    }
    const resumed = JSON.parse(JSON.stringify(content))
    expect(resumed[0].providerMetadata).toBeDefined()
    configure() // New profile objects and no in-memory signature trust.
    let sent: any
    const next = createProfileClient(resolveProviderModel('messages/Vendor/Thinking')!, {
      maxRetries: 0, fetch: (async (_input, init) => { sent = JSON.parse(String(init?.body)); return Response.json(anthropicMessage()) }) as typeof fetch,
    })
    await next.messages.create({ ...request, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'assistant', content: resumed }, toolResult] })
    expect(sent.messages[0].content[0]).toEqual(thinking)
    expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(JSON.stringify(sent)).not.toContain('providerMetadata')
    const other = createProfileClient(resolveProviderModel('messages-two/Vendor/Thinking')!, {
      maxRetries: 0, fetch: (async (_input, init) => { sent = JSON.parse(String(init?.body)); return Response.json(anthropicMessage()) }) as typeof fetch,
    })
    await other.messages.create({ ...request, messages: [{ role: 'assistant', content: resumed }, toolResult] })
    expect(sent.messages[0].content).toEqual([tool])
    expect(JSON.stringify(sent)).not.toContain(thinking.signature)
  })

  test('captures endpoint, exact remote model and credential across a session switch', async () => {
    configure()
    const seen: Array<{ url: string; headers: Headers; body: any }> = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      return Response.json({ id: 'chat-test', model: 'Vendor/Model', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
    }) as typeof globalThis.fetch
    const first = createProfileClient(resolveProviderModel('one/Vendor/Model')!, { maxRetries: 0, fetch })
    selectProviderProfile('two')
    const second = createProfileClient(resolveProviderModel()!, { maxRetries: 0, fetch })
    for (const client of [first, second]) {
      const response = await client.messages.create({ model: 'ignored-at-boundary', max_tokens: 8192, messages: [{ role: 'user', content: 'hello' }] })
      expect(response.content).toMatchObject([{ type: 'text', text: 'ok' }])
    }
    expect(seen.map(request => request.url)).toEqual(['https://one.example/v1/chat/completions', 'https://two.example/v1/chat/completions'])
    expect(seen.map(request => request.headers.get('authorization'))).toEqual(['Bearer one-test-key', 'Bearer two-test-key'])
    for (const request of seen) {
      expect(request.body.model).toBe('Vendor/Model')
      expect(request.body.max_tokens ?? request.body.max_completion_tokens).toBe(1024)
      expect(request.headers.has('x-api-key')).toBe(false)
      expect(request.headers.has('anthropic-beta')).toBe(false)
    }
  })

  test('Anthropic-compatible endpoints receive their own key and portable history', async () => {
    configure()
    let request: any
    let headers: Headers | undefined
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = JSON.parse(String(init?.body))
      headers = new Headers(init?.headers)
      expect(init?.redirect).toBe('error')
      return Response.json({ id: 'msg-test', type: 'message', role: 'assistant', model: request.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    }) as typeof globalThis.fetch
    const client = createProfileClient(resolveProviderModel('messages/Vendor/Model')!, { maxRetries: 0, fetch })
    await client.beta.messages.create({
      model: 'messages/Vendor/Model', max_tokens: 2048, betas: ['oauth-2025-04-20'], metadata: { user_id: 'unrelated-account' },
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'private', signature: 'old-provider-signature' }, { type: 'text', text: 'previous reply' }] }, { role: 'user', content: 'next' }],
    })
    expect(headers!.get('x-api-key')).toBe('one-test-key')
    expect(headers!.has('authorization')).toBe(false)
    expect(headers!.has('anthropic-beta')).toBe(false)
    expect(request.model).toBe('Vendor/Model')
    expect(request.metadata).toBeUndefined()
    expect(request.messages[0].content).toEqual([{ type: 'text', text: 'previous reply' }])
  })

  test.each(['json', 'stream'] as const)('retains %s thinking across SDK clients and isolates other profiles and models', async mode => {
    configure()
    const seen: any[] = []
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)))
      if (seen.length === 1) {
        return mode === 'stream' ? thinkingToolStream() : Response.json(anthropicMessage([thinking, tool]))
      }
      return Response.json(anthropicMessage())
    }) as typeof globalThis.fetch
    const first = createProfileClient(resolveProviderModel('messages/Vendor/Thinking')!, { maxRetries: 0, fetch })
    const initial: Anthropic.MessageCreateParamsNonStreaming = {
      model: 'ignored', max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: [{ role: 'user', content: 'Read a.ts' }],
    }
    const reply = mode === 'stream' ? await first.messages.stream(initial).finalMessage() : await first.messages.create(initial)
    expect(reply.content[0]).toMatchObject(thinking)
    const messages: Anthropic.MessageParam[] = [{ role: 'assistant', content: reply.content }, toolResult]
    for (const model of ['messages/Vendor/Thinking', 'messages-two/Vendor/Thinking', 'messages/Vendor/OtherThinking', 'messages/Vendor/Thinking']) {
      const rebuilt = createProfileClient(resolveProviderModel(model)!, { maxRetries: 0, fetch })
      await rebuilt.messages.create({ ...initial, messages })
    }
    for (const index of [1, 4]) {
      expect(seen[index].messages).toEqual(withoutProviderMetadata(messages))
      expect(seen[index].thinking).toEqual(initial.thinking)
    }
    for (const index of [2, 3]) {
      expect(seen[index].messages).toEqual([{ role: 'assistant', content: [reply.content[1]] }, toolResult])
      expect(seen[index].thinking).toBeUndefined()
    }
    expect(messages[0]!.content).toEqual(reply.content)
  })

  test('continues foreign tool calls without thinking and re-enables thinking on the following turn', async () => {
    configure()
    const seen: any[] = []
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)))
      return Response.json(anthropicMessage())
    }) as typeof globalThis.fetch
    const client = createProfileClient(resolveProviderModel('messages/Vendor/Thinking')!, { maxRetries: 0, fetch })
    const messages: Anthropic.MessageParam[] = [{ role: 'assistant', content: [thinking, tool] }, toolResult]
    const request = { model: 'ignored', max_tokens: 4096, thinking: { type: 'enabled' as const, budget_tokens: 2048 } }
    const reply = await client.messages.create({ ...request, messages })
    await client.messages.create({ ...request, messages: [...messages, { role: 'assistant', content: reply.content }, { role: 'user', content: 'Continue' }] })
    expect(seen[0].messages).toEqual([{ role: 'assistant', content: [tool] }, toolResult])
    expect(seen[0].thinking).toBeUndefined()
    expect(seen[1].thinking).toEqual(request.thinking)
  })

  test('clamps thinking to the model output limit and disables it when the limit cannot fit the minimum', async () => {
    configure()
    const seen: any[] = []
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)))
      return Response.json(anthropicMessage())
    }) as typeof globalThis.fetch
    for (const [modelId, budget] of [
      ['Vendor/Thinking', 8192], ['Vendor/Thinking', 1], ['Vendor/TinyThinking', 8192], ['Vendor/Model', 8192],
    ] as const) {
      const client = createProfileClient(resolveProviderModel(`messages/${modelId}`)!, { maxRetries: 0, fetch })
      await client.messages.create({
        model: 'ignored', max_tokens: 8192, thinking: { type: 'enabled', budget_tokens: budget },
        messages: [{ role: 'user', content: 'Think' }],
      })
    }
    expect(seen.map(request => request.max_tokens)).toEqual([4096, 4096, 1024, 1024])
    expect(seen.map(request => request.thinking)).toEqual([
      { type: 'enabled', budget_tokens: 4095 }, { type: 'enabled', budget_tokens: 1024 }, undefined, undefined,
    ])
  })

  test.each(['messages', 'one', 'responses'])('rejects direct and tool-result images for text-only %s models before transport', async profile => {
    configure()
    let calls = 0
    const fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++
      return Response.json(anthropicMessage())
    }) as typeof globalThis.fetch
    const client = createProfileClient(resolveProviderModel(`${profile}/Vendor/Model`)!, { maxRetries: 0, fetch })
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YXNk' } } as const
    for (const content of [[image], [{ type: 'tool_result' as const, tool_use_id: tool.id, content: [image] }]]) {
      await expect(Promise.resolve(client.messages.create({
        model: 'ignored', max_tokens: 1024, messages: [{ role: 'user', content }],
      }))).rejects.toMatchObject({ status: 400, message: expect.stringContaining('does not support images') })
    }
    expect(calls).toBe(0)
  })

  test('keeps structured output format while dropping model-specific effort at Anthropic endpoints', async () => {
    configure()
    let request: any
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = JSON.parse(String(init?.body))
      return Response.json(anthropicMessage())
    }) as typeof globalThis.fetch
    const client = createProfileClient(resolveProviderModel('messages/Vendor/Model')!, { maxRetries: 0, fetch })
    const format = { type: 'json_schema' as const, schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } }
    await client.beta.messages.create({
      model: 'ignored', max_tokens: 2048, output_config: { format, effort: 'high' },
      messages: [{ role: 'user', content: 'Return JSON' }],
    })
    expect(request.output_config).toEqual({ format })
  })

  test.each(['responses', 'responses-endpoint'])('routes the real SDK through %s with the configured /v1 path exactly once', async profile => {
    configure()
    let url: string | undefined
    let headers: Headers | undefined
    let request: any
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input)
      headers = new Headers(init?.headers)
      request = JSON.parse(String(init?.body))
      return Response.json({
        id: 'resp_test', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 10, output_tokens: 2 },
      })
    }) as typeof globalThis.fetch
    const client = createProfileClient(resolveProviderModel(`${profile}/Vendor/Model`)!, { maxRetries: 0, fetch })
    const reply = await client.messages.create({ model: 'ignored', max_tokens: 2048, messages: [{ role: 'user', content: 'Hello' }] })
    expect(url).toBe('https://responses.example/v1/responses')
    expect(headers!.get('authorization')).toBe('Bearer one-test-key')
    expect(headers!.has('x-api-key')).toBe(false)
    expect(request.model).toBe('Vendor/Model')
    expect(request.max_output_tokens).toBe(1024)
    expect(reply.content).toMatchObject([{ type: 'text', text: 'ok' }])
  })
})
