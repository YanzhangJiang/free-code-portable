import { describe, expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { createOpenAIResponsesFetch } from './openai-responses-fetch.js'
import { adaptMessagesClient } from './provider-client.js'
import { collectResponsesMessage } from './openai-responses-stream.js'

const endpoint = 'https://api.anthropic.com/v1/messages'
const baseRequest = { model: 'arbitrary/provider-model', max_tokens: 2048, messages: [{ role: 'user', content: 'Hi' }] }
const encoder = new TextEncoder()
const completed = { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 30, output_tokens: 9, input_tokens_details: { cached_tokens: 10 } } }

function fetchStub(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return handler as typeof fetch
}

function jsonResponse(output: unknown[] = []): Response {
  return Response.json({ ...completed, output })
}

function eventResponse(events: unknown[], chunkSize = 17, ending = '\r\n\r\n'): Response {
  const text = ': heartbeat\n\n' + events.map(event => `data: ${JSON.stringify(event)}${ending}`).join('')
  const bytes = encoder.encode(text)
  let offset = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) controller.close()
      else {
        controller.enqueue(bytes.slice(offset, offset + chunkSize))
        offset += chunkSize
      }
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

function toolEvents(): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Consider 中' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'Consider 中' },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Calling tools.' },
    { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'Calling tools.' },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' } },
    { type: 'response.output_item.added', output_index: 3, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'list', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '{"file":' },
    { type: 'response.function_call_arguments.delta', output_index: 3, item_id: 'fc_2', delta: '{"path":"/tmp"}' },
    { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '"a.ts"}' },
    { type: 'response.output_item.done', output_index: 3, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'list', arguments: '{"path":"/tmp"}' } },
    { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"file":"a.ts"}' },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"file":"a.ts"}' } },
    { type: 'response.completed', response: completed },
  ]
}

describe('OpenAI Responses fetch adapter', () => {
  test('resumes complete encrypted reasoning, phase and item IDs after serialization and client recreation', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_private', encrypted_content: 'encrypted-only-for-origin', summary: [] },
      { type: 'message', id: 'msg_phase', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'I will read.', annotations: [] }, { type: 'output_text', text: 'Then answer.', annotations: [] }] },
      { type: 'function_call', id: 'fc_origin', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}', status: 'completed' },
    ]
    const first = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', nativeIdentity: { provider: 'one' }, fetch: fetchStub(() => jsonResponse(output)) })
    const client = adaptMessagesClient(new Anthropic({ apiKey: 'placeholder', fetch: first }), { preserveNativeHistory: true })
    const reply = (await client.createMessage({ ...baseRequest, messages: [{ role: 'user', content: 'Hi' }] })).data
    const history = JSON.parse(JSON.stringify(reply.content))
    expect(history[0].thinking).toBe('')
    expect(history[0].providerMetadata).toBeDefined()
    for (const provider of ['one', 'two']) {
      let body: any
      const resumed = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', nativeIdentity: { provider }, fetch: fetchStub((_input, init) => { body = JSON.parse(String(init?.body)); return jsonResponse() }) })
      // The main loop persists one assistant fragment per completed content block.
      await resumed(endpoint, { body: JSON.stringify({ ...baseRequest, messages: [
        ...history.map((block: unknown) => ({ role: 'assistant', content: [block] })),
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }] },
      ] }) })
      if (provider === 'one') expect(body.input.slice(0, -1)).toEqual(output)
      else {
        expect(JSON.stringify(body)).not.toContain('encrypted-only-for-origin')
        expect(JSON.stringify(body)).not.toContain('msg_phase')
        expect(body.input[0].content.map((part: any) => part.text).join('')).toBe('I will read.Then answer.')
        expect(body.input[1]).toMatchObject({ type: 'function_call', call_id: 'call_1', arguments: '{"path":"a"}' })
      }
      expect(body.input.at(-1)).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'file contents' })
    }
  })

  test('stream metadata arrives before each block is persisted, including empty reasoning and parallel tool IDs', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_stream', summary: [], encrypted_content: 'opaque-state' },
      { type: 'message', id: 'msg_stream', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done', annotations: [] }] },
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'read', arguments: '{}' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'list', arguments: '{}' },
    ]
    const events = [
      { type: 'response.created', response: { id: 'resp_1' } },
      ...[0, 1, 3, 2].map(index => ({ type: 'response.output_item.done', output_index: index, item: output[index] })),
      { type: 'response.completed', response: { ...completed, output } },
    ]
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', nativeIdentity: { provider: 'one' }, fetch: fetchStub(() => eventResponse(events, 1)) })
    const client = adaptMessagesClient(new Anthropic({ apiKey: 'unused', fetch: adapter }), { preserveNativeHistory: true })
    const stream = (await client.streamMessages({ ...baseRequest, messages: [{ role: 'user', content: 'Hi' }] })).data
    const stops: any[] = []
    for await (const event of stream) if (event.type === 'content_block_stop') stops.push(event)
    expect(stops).toHaveLength(4)
    expect(stops.map(event => event.providerMetadata['free-code/native'].item.id)).toEqual(['rs_stream', 'msg_stream', 'fc_b', 'fc_a'])
    const response = await adapter(endpoint, { body: JSON.stringify({ ...baseRequest, stream: true }) })
    const reply = await collectResponsesMessage(response.body!)
    let request: any
    const resumed = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', nativeIdentity: { provider: 'one' }, fetch: fetchStub((_input, init) => { request = JSON.parse(String(init?.body)); return jsonResponse() }) })
    await resumed(endpoint, { body: JSON.stringify({ ...baseRequest, messages: [{ role: 'assistant', content: JSON.parse(JSON.stringify(reply.content)) }] }) })
    expect(request.input).toEqual(output)
  })

  test('preserves structured provider error codes in HTTP and stream errors', async () => {
    const error = { message: 'Please shorten input', type: 'invalid_request_error', code: 'context_length_exceeded', param: 'input' }
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub(() => Response.json({ error }, { status: 400 })) })
    expect((await (await adapter(endpoint, { body: JSON.stringify(baseRequest) })).json()).error).toEqual(error)
    const streaming = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub(() => eventResponse([{ type: 'error', error }])) })
    const response = await streaming(endpoint, { body: JSON.stringify({ ...baseRequest, stream: true }) })
    await expect(response.text()).rejects.toMatchObject({ code: 'context_length_exceeded', param: 'input' })
  })

  test('SDK does not retry local request conversion failures', async () => {
    let conversions = 0
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', supportsImages: false, fetch: fetchStub(() => { throw new Error('network must not run') }) })
    const client = new Anthropic({ apiKey: 'test', maxRetries: 3, fetch: fetchStub((input, init) => { conversions++; return adapter(input, init) }) })
    await expect(Promise.resolve(client.messages.create({ ...baseRequest, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }] }] }))).rejects.toMatchObject({ status: 400 })
    expect(conversions).toBe(1)
  })

  test('native state preservation does not convert truncated tool JSON into a transport failure', async () => {
    const item = { type: 'function_call', id: 'fc', call_id: 'call', name: 'read', arguments: '{"path":' }
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', nativeIdentity: { provider: 'one' }, fetch: fetchStub(() => eventResponse([
      { type: 'response.incomplete', response: { ...completed, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [item] } },
    ])) })
    const text = await (await adapter(endpoint, { body: JSON.stringify({ ...baseRequest, stream: true }) })).text()
    expect(text).toContain('"stop_reason":"max_tokens"')
    expect(text).not.toContain('providerMetadata')
  })

  test('preserves models, ordered history, tools, images and provider-only credentials', async () => {
    let captured: { url: string; init?: RequestInit } | undefined
    const adapter = createOpenAIResponsesFetch({
      baseURL: 'https://provider.example/v1/', apiKey: 'provider-secret',
      headers: { 'X-Custom': 'configured' }, supportsReasoning: true,
      fetch: fetchStub((input, init) => { captured = { url: String(input), init }; return jsonResponse() }),
    })
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YXNk' } }
    await adapter(endpoint, {
      method: 'POST', headers: { 'x-api-key': 'anthropic-secret', 'anthropic-beta': 'private-feature', authorization: 'Bearer claude-token' },
      body: JSON.stringify({
        ...baseRequest, system: [{ type: 'text', text: 'Instructions', cache_control: { type: 'ephemeral' } }],
        tools: [{ name: 'read', description: 'Read file', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'tool', name: 'read', disable_parallel_tool_use: true },
        thinking: { type: 'enabled', budget_tokens: 1024 },
        output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } } } } },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Start' }, image] },
          { role: 'assistant', content: [{ type: 'text', text: 'Reading' }, { type: 'tool_use', id: 'call_1', name: 'read', input: { file: 'a' } }] },
          { role: 'user', content: [{ type: 'text', text: 'Before' }, { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'Output' }, image] }, { type: 'text', text: 'After' }] },
        ],
      }),
    })
    expect(captured!.url).toBe('https://provider.example/v1/responses')
    const headers = new Headers(captured!.init!.headers)
    expect(headers.get('authorization')).toBe('Bearer provider-secret')
    expect(headers.get('x-custom')).toBe('configured')
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.has('anthropic-beta')).toBe(false)
    expect(captured!.init!.redirect).toBe('error')
    const body = JSON.parse(String(captured!.init!.body))
    expect(body.model).toBe(baseRequest.model)
    expect(body.instructions).toBe('Instructions')
    expect(body.max_output_tokens).toBe(2048)
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(body.text).toEqual({ format: { type: 'json_schema', name: 'response', strict: false, schema: { type: 'object', properties: { answer: { type: 'string' } } } } })
    expect(body.tool_choice).toEqual({ type: 'function', name: 'read' })
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.tools[0].strict).toBe(false)
    expect(body.input.map((item: { type?: string; role?: string }) => item.type ?? item.role)).toEqual(['user', 'assistant', 'function_call', 'user', 'function_call_output', 'user'])
    expect(body.input[0].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,YXNk', detail: 'auto' })
    expect(body.input[1]).toEqual({ role: 'assistant', content: [{ type: 'input_text', text: 'Reading' }] })
    expect(body.input[4]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'Output' }, { type: 'input_image', image_url: 'data:image/png;base64,YXNk', detail: 'auto' }] })
    expect(body).not.toHaveProperty('metadata')
    expect(body.store).toBe(false)
  })

  test('supports Request input, non-streaming responses, usage and exact signal forwarding', async () => {
    const controller = new AbortController()
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub((_input, init) => {
      expect(init!.signal).toBe(controller.signal)
      return jsonResponse([
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
        { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
      ])
    }) })
    const request = new Request(endpoint, { method: 'POST', body: JSON.stringify(baseRequest) })
    const response = await adapter(request, { signal: controller.signal })
    const message = await response.json()
    expect(message.content).toEqual([{ type: 'thinking', thinking: 'Plan', signature: '' }, { type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } }])
    expect(message.stop_reason).toBe('tool_use')
    expect(message.usage).toEqual({ input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 })
    expect(request.bodyUsed).toBe(false)
  })

  test('Anthropic SDK consumes fragmented SSE with reasoning and interleaved parallel tools', async () => {
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub(() => eventResponse(toolEvents(), 1)) })
    const client = new Anthropic({ apiKey: 'unused-anthropic-key', fetch: adapter })
    const stream = await client.messages.create({ ...baseRequest, messages: [{ role: 'user', content: 'Hi' }], stream: true })
    const events = []
    for await (const event of stream) events.push(event)
    expect(events[0].type).toBe('message_start')
    const starts = events.filter(event => event.type === 'content_block_start')
    expect(starts.map(event => event.index)).toEqual([0, 1, 2, 3])
    expect(starts[2].content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'read' })
    expect(starts[3].content_block).toMatchObject({ type: 'tool_use', id: 'call_2', name: 'list' })
    expect(events.map(event => event.type === 'content_block_delta' && event.index === 2 && event.delta.type === 'input_json_delta' ? event.delta.partial_json : '').join('')).toBe('{"file":"a.ts"}')
    expect(events.at(-2) as unknown).toEqual({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } })
    expect(events.at(-1)).toEqual({ type: 'message_stop' })
  })

  test('supports completed-only output and truncated max token responses', async () => {
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub(() => eventResponse([
      { type: 'response.incomplete', response: { ...completed, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial' }] }] } },
    ])) })
    const response = await adapter(endpoint, { body: JSON.stringify({ ...baseRequest, stream: true }) })
    const text = await response.text()
    expect(text).toContain('Partial')
    expect(text).toContain('"stop_reason":"max_tokens"')
  })

  test('Anthropic SDK finalMessage accumulates tools and final usage', async () => {
    const adapter = createOpenAIResponsesFetch({
      baseURL: 'https://provider.example/v1',
      fetch: fetchStub(() => eventResponse(toolEvents())),
    })
    const client = new Anthropic({ apiKey: 'unused', fetch: adapter })
    const message = await client.messages.stream({
      ...baseRequest, messages: [{ role: 'user', content: 'Hi' }],
    }).finalMessage()
    expect(message.content[2] as unknown).toEqual({ type: 'tool_use', id: 'call_1', name: 'read', input: { file: 'a.ts' } })
    expect(message.content[3] as unknown).toEqual({ type: 'tool_use', id: 'call_2', name: 'list', input: { path: '/tmp' } })
    expect(message.usage.input_tokens).toBe(20)
    expect(message.usage.cache_read_input_tokens).toBe(10)
    expect(message.usage.output_tokens).toBe(9)
    expect(message.stop_reason).toBe('tool_use')
  })

  test('deduplicates done snapshots and closes all content blocks once', async () => {
    const item = { type: 'message', id: 'msg1', content: [{ type: 'output_text', text: 'Hi' }] }
    const adapter = createOpenAIResponsesFetch({
      baseURL: 'https://provider.example/v1',
      fetch: fetchStub(() => eventResponse([
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hi' },
        { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Hi' },
        { type: 'response.content_part.done', output_index: 0, content_index: 0, part: item.content[0] },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { ...completed, output: [item] } },
      ], 23, '\n\n')),
    })
    const response = await adapter(endpoint, { body: JSON.stringify({ ...baseRequest, stream: true }) })
    const events = (await response.text()).split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\ndata: ')[1]!))
    expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'content_block_delta')).toHaveLength(1)
    expect(events.filter(event => event.type === 'content_block_stop')).toHaveLength(1)
  })

  test('forwards status, retry hints and provider errors without converting them to assistant text', async () => {
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub(() => Response.json({ error: { message: 'Quota exceeded' } }, { status: 429, headers: { 'retry-after': '9' } })) })
    const response = await adapter(endpoint, { body: JSON.stringify(baseRequest) })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('9')
    expect(await response.json()).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'Quota exceeded' } })
  })

  test.each([
    [{ type: 'response.failed', response: { error: { message: 'Provider failure' } } }, 'Provider failure'],
    [{ type: 'response.output_text.delta', delta: 'Truncated', output_index: 0 }, 'before response completion'],
    [{ type: 'response.function_call_arguments.delta', delta: '{}', output_index: 0 }, 'before tool metadata'],
  ])('propagates failed and incomplete transport streams', async (event, error) => {
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub(() => eventResponse([event])) })
    const response = await adapter(endpoint, { body: JSON.stringify({ ...baseRequest, stream: true }) })
    await expect(response.text()).rejects.toThrow(String(error))
  })

  test('cancels an upstream read and releases the stream on early consumer exit', async () => {
    let cancelled = false
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n')) },
      cancel() { cancelled = true },
    })
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub(() => new Response(upstream)) })
    const response = await adapter(endpoint, { body: JSON.stringify({ ...baseRequest, stream: true }) })
    const reader = response.body!.getReader()
    await reader.read()
    const pending = reader.read()
    await reader.cancel('user stopped')
    expect(await pending).toEqual({ done: true, value: undefined })
    reader.releaseLock()
    expect(cancelled).toBe(true)
    expect(upstream.locked).toBe(false)
  })

  test('propagates transport body failures and releases the upstream reader', async () => {
    let reads = 0
    const failure = new Error('Connection interrupted')
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","output_index":0,"delta":"Hello"}\n\n'))
        else controller.error(failure)
      },
    })
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub(() => new Response(upstream)) })
    const response = await adapter(endpoint, { body: JSON.stringify({ ...baseRequest, stream: true }) })
    await expect(response.text()).rejects.toBe(failure)
    expect(upstream.locked).toBe(false)
  })

  test('immediate response cancellation releases an upstream body before any content', async () => {
    let cancelled = false
    const upstream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub(() => new Response(upstream)) })
    const response = await adapter(endpoint, { body: JSON.stringify({ ...baseRequest, stream: true }) })
    await response.body!.cancel()
    expect(cancelled).toBe(true)
    expect(upstream.locked).toBe(false)
  })

  test('abort discards buffered tool events even after the upstream response completes', async () => {
    const controller = new AbortController()
    const failure = new Error('User interrupted')
    const adapter = createOpenAIResponsesFetch({
      baseURL: 'https://provider.example/v1',
      fetch: fetchStub(() => eventResponse(toolEvents(), 100000)),
    })
    const response = await adapter(endpoint, { signal: controller.signal, body: JSON.stringify({ ...baseRequest, stream: true }) })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort(failure)
    await expect(reader.read()).rejects.toBe(failure)
    reader.releaseLock()
  })

  test('abort wakes and releases a transport that ignores the supplied signal', async () => {
    const controller = new AbortController()
    const failure = new Error('User interrupted')
    let cancelled = false
    const upstream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', fetch: fetchStub(() => new Response(upstream)) })
    const response = await adapter(endpoint, { signal: controller.signal, body: JSON.stringify({ ...baseRequest, stream: true }) })
    const pending = response.text()
    controller.abort(failure)
    await expect(pending).rejects.toBe(failure)
    await Promise.resolve()
    expect(cancelled).toBe(true)
    expect(upstream.locked).toBe(false)
  })

  test('rejects already aborted requests and unsupported input without making network calls', async () => {
    let calls = 0
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://provider.example/v1', supportsImages: false, fetch: fetchStub(() => { calls++; return jsonResponse() }) })
    const controller = new AbortController()
    controller.abort()
    await expect(adapter(endpoint, { signal: controller.signal, body: JSON.stringify(baseRequest) })).rejects.toThrow()
    expect((await adapter(endpoint, { body: 'not-json' })).status).toBe(400)
    expect(await (await adapter(endpoint, { body: JSON.stringify({ ...baseRequest, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }] }) })).json()).toMatchObject({ error: { message: expect.stringContaining('does not support images') } })
    await expect(adapter('https://api.anthropic.com/v1/models')).rejects.toThrow('does not support')
    const count = await adapter(`${endpoint}/count_tokens`, { body: JSON.stringify(baseRequest) })
    expect(count.status).toBe(400)
    expect((await count.json()).error.message).toContain('local estimation')
    expect(calls).toBe(0)
  })

  test.each([
    'ftp://provider.example/v1',
    'https://user:password@provider.example/v1',
    'https://provider.example/v1?api_key=secret',
    'https://provider.example/v1#secret',
  ])('rejects invalid endpoint configuration: %s', baseURL => {
    expect(() => createOpenAIResponsesFetch({ baseURL })).toThrow('base URL')
  })

  test('surfaces a failed non-streaming provider response before parsing missing output', async () => {
    const adapter = createOpenAIResponsesFetch({
      baseURL: 'https://provider.example/v1',
      fetch: fetchStub(() => Response.json({ status: 'failed', error: { message: 'Model unavailable' } })),
    })
    await expect(adapter(endpoint, { body: JSON.stringify(baseRequest) })).rejects.toThrow('Model unavailable')
  })

  test('Codex always streams remotely and collects a non-streaming tool response', async () => {
    const adapter = createOpenAIResponsesFetch({ baseURL: 'https://chatgpt.com/backend-api/codex', codex: true, apiKey: 'oauth-token', fetch: fetchStub((_input, init) => {
      const body = JSON.parse(String(init!.body))
      expect(body.stream).toBe(true)
      expect(body.store).toBe(false)
      expect(body.instructions).toBe('')
      expect(body).not.toHaveProperty('max_output_tokens')
      expect(body).not.toHaveProperty('temperature')
      return eventResponse(toolEvents())
    }) })
    const response = await adapter(endpoint, { body: JSON.stringify({ ...baseRequest, temperature: 0.4 }) })
    const message = await response.json()
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'Consider 中', signature: '' },
      { type: 'text', text: 'Calling tools.' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { file: 'a.ts' } },
      { type: 'tool_use', id: 'call_2', name: 'list', input: { path: '/tmp' } },
    ])
    expect(message.usage.input_tokens).toBe(20)
    expect(message.stop_reason).toBe('tool_use')
  })
})
