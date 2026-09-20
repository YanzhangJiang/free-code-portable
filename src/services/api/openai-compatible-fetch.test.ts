import { describe, expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { createOpenAICompatibleFetch, type OpenAICompatibleFetchOptions } from './openai-compatible-fetch.js'
import { adaptMessagesClient } from './provider-client.js'

const messagesURL = 'https://api.anthropic.com/v1/messages'
const requestBody = { model: 'custom/model-v3', max_tokens: 200, messages: [{ role: 'user', content: 'Hello' }] }

function completion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-test',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello back' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 8 } },
    ...overrides,
  }
}

function fixture(options: Partial<OpenAICompatibleFetchOptions> = {}, reply: () => Response = () => Response.json(completion())) {
  const calls: Request[] = []
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init))
    return reply()
  }) as typeof globalThis.fetch
  const fetch = createOpenAICompatibleFetch({ baseURL: 'https://provider.example/api/v1/', fetch: transport, ...options })
  return {
    calls,
    fetch,
    request: (body: Record<string, unknown> = requestBody, init: RequestInit = {}) => fetch(messagesURL, { method: 'POST', body: JSON.stringify(body), ...init }),
  }
}

function streamReply(chunks: unknown[], suffix = 'data: [DONE]\n\n'): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + suffix, { headers: { 'content-type': 'text/event-stream' } })
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: 'chatcmpl-stream', choices: [{ index: 0, delta, finish_reason: finish }] }
}

function events(text: string) {
  return text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\ndata: ')[1]!))
}

describe('OpenAI-compatible request boundary', () => {
  test.each([false, true])('reasoning provenance survives resume and never crosses profiles (stream=%s)', async streaming => {
    const adapter = fixture({ supportsReasoning: true, nativeIdentity: { provider: 'ours' } }, () => streaming
      ? streamReply([chunk({ reasoning_content: 'private reasoning' }), chunk({ content: 'Public answer' }, 'stop')])
      : Response.json(completion({ choices: [{ index: 0, message: { content: 'Public answer', reasoning_content: 'private reasoning' }, finish_reason: 'stop' }] })))
    const client = adaptMessagesClient(new Anthropic({ apiKey: 'unused', fetch: adapter.fetch }), { preserveNativeHistory: true })
    let content: any[]
    if (!streaming) content = (await client.createMessage({ ...requestBody, messages: [{ role: 'user', content: 'Hello' }] })).data.content
    else {
      content = []
      for await (const event of (await client.streamMessages({ ...requestBody, messages: [{ role: 'user', content: 'Hello' }] })).data) {
        if (event.type === 'content_block_start') content[event.index] = { ...event.content_block }
        if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') content[event.index].thinking += event.delta.thinking
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') content[event.index].text += event.delta.text
        if (event.type === 'content_block_stop' && 'providerMetadata' in event) content[event.index].providerMetadata = event.providerMetadata
      }
    }
    for (const provider of ['ours', 'other']) {
      const next = fixture({ supportsReasoning: true, nativeIdentity: { provider } })
      await next.request({ ...requestBody, messages: [{ role: 'assistant', content: JSON.parse(JSON.stringify(content)) }, { role: 'user', content: 'continue' }] })
      const request = await next.calls[0]!.json()
      expect(request.messages[0].content).toBe('Public answer')
      if (provider === 'ours') expect(request.messages[0].reasoning_content).toBe('private reasoning')
      else expect(JSON.stringify(request)).not.toContain('private reasoning')
    }
    const other = fixture({ supportsReasoning: true, nativeIdentity: { provider: 'other' } })
    await other.request({ ...requestBody, messages: [{ role: 'assistant', content: [content[0]] }, { role: 'user', content: 'continue' }] })
    expect((await other.calls[0]!.json()).messages).toEqual([{ role: 'user', content: 'continue' }])
  })

  test('preserves model, translates system/tools, and never forwards Anthropic credentials or parameters', async () => {
    const adapter = fixture({ apiKey: 'own-key', headers: { 'x-provider-project': 'ours' }, maxTokensField: 'max_completion_tokens' })
    const response = await adapter.request({
      ...requestBody,
      system: [{ type: 'text', text: 'System', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' }, defer_loading: true }],
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
      thinking: { type: 'enabled', budget_tokens: 100 },
      metadata: { user_id: 'private' },
      betas: ['private-beta'],
      temperature: 0.4,
    }, { headers: { 'x-api-key': 'anthropic-secret', authorization: 'Bearer other-secret', 'anthropic-beta': 'private-beta' } })
    const outgoing = adapter.calls[0]!
    expect(outgoing.url).toBe('https://provider.example/api/v1/chat/completions')
    expect(Object.fromEntries(outgoing.headers)).toEqual({ 'content-type': 'application/json', authorization: 'Bearer own-key', 'x-provider-project': 'ours' })
    expect(await outgoing.json()).toEqual({
      model: 'custom/model-v3',
      messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Hello' }],
      stream: false,
      max_completion_tokens: 200,
      temperature: 0.4,
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
      parallel_tool_calls: false,
    })
    expect((await response.json()).usage).toEqual({ input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 8, cache_creation_input_tokens: 0 })
  })

  test('translates parallel tool history and images without separating pending tool results', async () => {
    const adapter = fixture({ supportsImages: true, supportsReasoning: true })
    await adapter.request({ ...requestBody, output_config: { effort: 'high' }, messages: [
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Need files', signature: 'private' },
        { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a' } },
        { type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] },
        { type: 'tool_result', tool_use_id: 'call_b', content: 'missing', is_error: true },
        { type: 'text', text: 'Compare' },
      ] },
    ] })
    const body = await adapter.calls[0]!.json()
    expect(body.reasoning_effort).toBe('high')
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
    expect(body.messages[0].reasoning_content).toBe('Need files')
    expect(body.messages[0].tool_calls).toHaveLength(2)
    expect(body.messages[1]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: '' })
    expect(body.messages[2].content).toBe('Tool execution failed:\nmissing')
    expect(body.messages[3].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } })
  })

  test('rejects images for a text-only model before any network request', async () => {
    const adapter = fixture({ supportsImages: false })
    const image = { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }
    for (const content of [[image], [{ type: 'tool_result', tool_use_id: 'call', content: [image] }]]) {
      expect(await (await adapter.request({ ...requestBody, messages: [{ role: 'user', content }] })).json()).toMatchObject({ error: { message: expect.stringContaining('does not support images') } })
    }
    expect(adapter.calls).toHaveLength(0)
  })

  test('defers tool-result images until parallel results in separate user messages are complete', async () => {
    const adapter = fixture()
    await adapter.request({ ...requestBody, messages: [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'read', input: {} },
        { type: 'tool_use', id: 'b', name: 'read', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }] }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'text' }] },
    ] })
    const body = await adapter.calls[0]!.json()
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
  })

  test('rejects unsupported document/server tools and gives count_tokens an explicit unsupported result', async () => {
    const adapter = fixture()
    expect(await (await adapter.request({ ...requestBody, messages: [{ role: 'user', content: [{ type: 'document' }] }] })).json()).toMatchObject({ error: { message: expect.stringContaining('unsupported content block document') } })
    expect(await (await adapter.request({ ...requestBody, tools: [{ name: 'web_search', type: 'web_search_20250305' }] })).json()).toMatchObject({ error: { message: expect.stringContaining('unsupported server tool') } })
    const response = await adapter.fetch(`${messagesURL}/count_tokens`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toContain('local token estimation')
    expect(adapter.calls).toHaveLength(0)
  })

  test('supports Request inputs and custom-header authentication without adding a bearer token', async () => {
    const adapter = fixture({ headers: { 'api-key': 'gateway-key' } })
    await adapter.fetch(new Request(messagesURL, { method: 'POST', body: JSON.stringify(requestBody), headers: { 'x-api-key': 'do-not-send' } }))
    expect(adapter.calls[0]!.headers.get('api-key')).toBe('gateway-key')
    expect(adapter.calls[0]!.headers.has('authorization')).toBe(false)
    expect(adapter.calls[0]!.headers.has('x-api-key')).toBe(false)
  })

  test('translates structured-output schemas without changing the schema', async () => {
    const adapter = fixture()
    const schema = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }
    await adapter.request({ ...requestBody, output_config: { format: { type: 'json_schema', schema } } })
    expect((await adapter.calls[0]!.json()).response_format).toEqual({ type: 'json_schema', json_schema: { name: 'response', schema, strict: false } })
  })
})

describe('OpenAI-compatible completion conversion', () => {
  test('returns non-streaming reasoning, text, tools and cache accounting', async () => {
    const adapter = fixture({}, () => Response.json(completion({ choices: [{ index: 0, finish_reason: 'tool_calls', message: {
      role: 'assistant', reasoning_content: 'Inspect first', content: 'Checking', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
        { id: 'call_2', type: 'function', function: { name: 'list', arguments: '{}' } },
      ],
    } }] })))
    const message = await (await adapter.request()).json()
    expect(message.model).toBe('custom/model-v3')
    expect(message.stop_reason).toBe('tool_use')
    expect(message.content as unknown).toEqual([
      { type: 'thinking', thinking: 'Inspect first', signature: '' },
      { type: 'text', text: 'Checking' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } },
      { type: 'tool_use', id: 'call_2', name: 'list', input: {} },
    ])
  })

  test('converts streaming reasoning, text and interleaved parallel calls using Anthropic SDK', async () => {
    const adapter = fixture({}, () => streamReply([
      chunk({ role: 'assistant', reasoning_content: 'Inspect' }),
      chunk({ reasoning_content: ' files' }),
      chunk({ content: 'Checking' }),
      chunk({ tool_calls: [
        { index: 1, id: 'call_b', type: 'function', function: { name: 'li', arguments: '{' } },
        { index: 0, id: 'call_a', type: 'function', function: { name: 're', arguments: '{"pa' } },
      ] }),
      chunk({ tool_calls: [
        { index: 0, function: { name: 'ad', arguments: 'th":"a"}' } },
        { index: 1, function: { name: 'st', arguments: '}' } },
      ] }),
      chunk({}, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 20 } } },
    ]))
    const client = new Anthropic({ apiKey: 'must-not-leave', fetch: adapter.fetch })
    const stream = client.messages.stream({ model: 'custom/model-v3', max_tokens: 200, messages: [{ role: 'user', content: 'Hello' }] })
    const message = await stream.finalMessage()
    expect(message.content as unknown).toEqual([
      { type: 'thinking', thinking: 'Inspect files', signature: '' },
      { type: 'text', text: 'Checking' },
      { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a' } },
      { type: 'tool_use', id: 'call_b', name: 'list', input: {} },
    ])
    // The SDK updates input and cache counters from the final message_delta too.
    expect(message.usage).toMatchObject({ input_tokens: 30, output_tokens: 15, cache_read_input_tokens: 20 })
    expect(message.stop_reason).toBe('tool_use')
    expect((await adapter.calls[0]!.json()).stream_options).toEqual({ include_usage: true })
  })

  test('handles byte-sized UTF-8 chunks, CRLF, comments and final events without blank lines', async () => {
    const bytes = new TextEncoder().encode(`: heartbeat\r\n\r\ndata: ${JSON.stringify(chunk({ content: '你好' }))}\r\n\r\ndata: ${JSON.stringify(chunk({}, 'stop'))}`)
    let offset = 0
    const adapter = fixture({}, () => new Response(new ReadableStream({ pull(controller) {
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset))
      else controller.close()
    } })))
    const result = events(await (await adapter.request({ ...requestBody, stream: true })).text())
    expect(result.find(event => event.type === 'content_block_delta').delta.text).toBe('你好')
    expect(result.at(-1).type).toBe('message_stop')
  })

  test('delivers incremental tool arguments before the provider finishes', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    const adapter = fixture({}, () => new Response(new ReadableStream({ start(controller) { upstream = controller } })))
    const response = await adapter.request({ ...requestBody, stream: true })
    const reader = response.body!.getReader()
    upstream.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'write', arguments: '' } }] }))}\n\n`))
    expect(events(new TextDecoder().decode((await reader.read()).value))[0].type).toBe('message_start')
    upstream.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }))}\n\n`))
    expect(events(new TextDecoder().decode((await reader.read()).value))[0].type).toBe('content_block_start')
    const partial = events(new TextDecoder().decode((await reader.read()).value))[0]
    expect(partial.delta).toEqual({ type: 'input_json_delta', partial_json: '{"path":' })
    await reader.cancel()
    reader.releaseLock()
  })

  test('preserves max_tokens for truncated tool arguments', async () => {
    const adapter = fixture({}, () => streamReply([chunk({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'write', arguments: '{"path":' } }] }, 'length')]))
    const result = events(await (await adapter.request({ ...requestBody, stream: true })).text())
    expect(result.at(-2).delta.stop_reason).toBe('max_tokens')
  })

  test.each(['stop', 'length', 'content_filter'])('maps the %s finish reason', async reason => {
    const adapter = fixture({}, () => streamReply([chunk({ content: 'Result' }, reason)]))
    const result = events(await (await adapter.request({ ...requestBody, stream: true })).text())
    expect(result.at(-2).delta.stop_reason).toBe({ stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal' }[reason])
  })
})

describe('OpenAI-compatible failures and lifetime', () => {
  test('preserves HTTP errors and retry headers', async () => {
    const adapter = fixture({}, () => Response.json({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': '3' } }))
    const response = await adapter.request()
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('3')
    expect((await response.json()).error.message).toBe('Rate limit')
  })

  test('rejects provider errors, malformed JSON and truncated streams instead of returning assistant text', async () => {
    for (const response of [
      () => streamReply([{ error: { message: 'backend failed' } }]),
      () => new Response('data: invalid-json\n\n'),
      () => streamReply([chunk({ content: 'partial' })]),
      () => streamReply([chunk({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'read', arguments: '{' } }] }, 'tool_calls')]),
    ]) {
      const adapter = fixture({}, response)
      const result = await adapter.request({ ...requestBody, stream: true })
      await expect(result.text()).rejects.toThrow()
    }
    const adapter = fixture({}, () => Response.json({ error: { message: 'backend failed' } }))
    await expect(adapter.request()).rejects.toThrow('backend failed')
  })

  test('propagates transport rejection and a pre-aborted request', async () => {
    const adapter = fixture({ fetch: (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error('connection lost') }) as typeof globalThis.fetch })
    await expect(adapter.request()).rejects.toThrow('connection lost')
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled before start'))
    await expect(adapter.request(requestBody, { signal: aborted.signal })).rejects.toThrow('cancelled before start')
  })

  test('forwards the AbortSignal during transport', async () => {
    const controller = new AbortController()
    const adapter = fixture({ fetch: (async (_input, init) => {
      controller.abort(new Error('cancelled in transport'))
      init!.signal!.throwIfAborted()
      return Response.json(completion())
    }) as typeof globalThis.fetch })
    await expect(adapter.request(requestBody, { signal: controller.signal })).rejects.toThrow('cancelled in transport')
  })

  test('cancels upstream and releases its reader when the consumer stops early', async () => {
    let cancelled: unknown
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`)) },
      cancel(reason) { cancelled = reason },
    })
    const adapter = fixture({}, () => new Response(upstream))
    const response = await adapter.request({ ...requestBody, stream: true })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel('user stopped')
    reader.releaseLock()
    expect(cancelled).toBe('user stopped')
    expect(upstream.locked).toBe(false)
  })

  test('propagates an upstream stream error and releases its reader', async () => {
    let readCount = 0
    const upstream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (readCount++ === 0) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`))
      else controller.error(new Error('socket closed'))
    } })
    const adapter = fixture({}, () => new Response(upstream))
    const response = await adapter.request({ ...requestBody, stream: true })
    await expect(response.text()).rejects.toThrow('socket closed')
    expect(upstream.locked).toBe(false)
  })

  test('aborts a stalled upstream read after headers arrive', async () => {
    const controller = new AbortController()
    let cancelled = false
    const upstream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const adapter = fixture({}, () => new Response(upstream))
    const response = await adapter.request({ ...requestBody, stream: true }, { signal: controller.signal })
    const pending = response.text()
    controller.abort(new Error('cancelled while stalled'))
    await expect(pending).rejects.toThrow('cancelled while stalled')
    expect(cancelled).toBe(true)
    expect(upstream.locked).toBe(false)
  })

  test('aborts while draining tool events after the upstream has completed', async () => {
    const controller = new AbortController()
    const adapter = fixture({}, () => streamReply([chunk({ tool_calls: [
      { index: 0, id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } },
      { index: 1, id: 'b', type: 'function', function: { name: 'read', arguments: '{}' } },
    ] }, 'tool_calls')]))
    const response = await adapter.request({ ...requestBody, stream: true }, { signal: controller.signal })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    controller.abort(new Error('cancelled buffered events'))
    await expect(reader.read()).rejects.toThrow('cancelled buffered events')
    reader.releaseLock()
  })
})
