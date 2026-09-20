import { describe, expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { createAnthropicProfileHistory } from './anthropic-profile-history.js'
import { createNativeMessageSource } from '../../providers/messages.js'

const encoder = new TextEncoder()
const thinking = { type: 'thinking', thinking: 'Inspect the file', signature: 'this-profile-signature' } as const
const redacted = { type: 'redacted_thinking', data: 'this-profile-redacted-data' } as const
const tool = { type: 'tool_use', id: 'call_read', name: 'read_file', input: { path: 'a.ts' }, caller: { type: 'direct' } } as const
const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'file contents' }] }

test('native Anthropic provenance wakes a stalled body on abort and releases its reader', async () => {
  const source = createNativeMessageSource('anthropic', { provider: 'one', endpoint: 'https://provider.example', model: 'model' })
  const history = createAnthropicProfileHistory(source)
  const controller = new AbortController()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }, { highWaterMark: 0 })
  const response = history.observeResponse(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), controller.signal)
  const pending = response.text()
  controller.abort(new Error('cancelled while waiting for thinking'))
  await expect(pending).rejects.toThrow('cancelled while waiting for thinking')
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

test('native Anthropic metadata drops modified signatures after a fresh session', async () => {
  const source = createNativeMessageSource('anthropic', { provider: 'one', endpoint: 'https://provider.example', model: 'model' })
  const history = createAnthropicProfileHistory(source)
  const response = await history.observeResponse(Response.json(message([thinking, redacted, tool]))).json()
  const fresh = createAnthropicProfileHistory(source)
  const content = JSON.parse(JSON.stringify(response.content))
  expect(fresh.prepareMessages([{ role: 'assistant', content }])).toEqual([{ role: 'assistant', content: [thinking, redacted, tool] }])
  content[0].signature = 'changed signature'
  content[1].data = 'changed opaque state'
  expect(fresh.prepareMessages([{ role: 'assistant', content }])).toEqual([{ role: 'assistant', content: [tool] }])
})

test('native Anthropic metadata parse failure releases and cancels the source', async () => {
  const history = createAnthropicProfileHistory(createNativeMessageSource('anthropic', { provider: 'one', endpoint: 'https://provider.example', model: 'model' }))
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('data: not-json\n\n')) },
    cancel() { cancelled = true },
  })
  await expect(history.observeResponse(new Response(body, { headers: { 'content-type': 'text/event-stream' } })).text()).rejects.toThrow()
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

function message(content: unknown[]) {
  return {
    id: 'msg_history', type: 'message', role: 'assistant', model: 'vendor/model', content,
    stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
  }
}

function client(history: ReturnType<typeof createAnthropicProfileHistory>, reply: () => Response): Anthropic {
  return new Anthropic({
    apiKey: 'test-key', maxRetries: 0,
    fetch: async () => history.observeResponse(reply()),
  })
}

function frames(events: unknown[]): string {
  return events.map(event => `event: ${(event as { type: string }).type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('')
}

function streamEvents(): unknown[] {
  return [
    { type: 'message_start', message: { ...message([]), stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinking.thinking } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: thinking.signature } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: redacted },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { ...tool, input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
}

function streamingResponse(text: string, chunkSize = 7): Response {
  const bytes = encoder.encode(text)
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close()
      else {
        controller.enqueue(bytes.slice(offset, offset + chunkSize))
        offset = Math.min(offset + chunkSize, bytes.length)
      }
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'history-test' } })
}

describe('Anthropic profile thinking history', () => {
  test('keeps observed JSON thinking in a tool continuation using the real SDK', async () => {
    const history = createAnthropicProfileHistory()
    const sdk = client(history, () => Response.json(message([thinking, redacted, tool])))
    const reply = await sdk.messages.create({
      model: 'vendor/model', max_tokens: 2000, thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'Read a.ts' }],
    })
    expect(reply.content).toEqual([thinking, redacted, tool])
    const conversation = [{ role: 'assistant', content: reply.content }, result]
    expect(history.prepareMessages(conversation)).toEqual(conversation)
    expect(history.prepareMessages(conversation)[0]).toBe(conversation[0])
    const otherProfile = createAnthropicProfileHistory()
    expect(otherProfile.prepareMessages(conversation)).toEqual([{ role: 'assistant', content: [tool] }, result])
    expect(conversation[0]!.content).toEqual([thinking, redacted, tool])
  })

  test('records signatures fragmented across TCP chunks and redacted thinking before SDK finalMessage', async () => {
    const history = createAnthropicProfileHistory()
    const sdk = client(history, () => streamingResponse(frames(streamEvents())))
    const reply = await sdk.messages.stream({
      model: 'vendor/model', max_tokens: 2000, thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'Read a.ts' }],
    }).finalMessage()
    expect(reply.content).toMatchObject([thinking, redacted, tool])
    const assistant = { role: 'assistant', content: reply.content }
    expect(history.prepareMessages([assistant, result])).toEqual([assistant, result])
    const foreign = { ...thinking, signature: 'other-profile-signature' }
    expect(history.prepareMessages([{ role: 'assistant', content: [foreign, thinking, redacted, tool] }, result]))
      .toEqual([assistant, result])
  })

  test('preserves exact bytes, status and headers while handling CRLF split across chunks', async () => {
    const history = createAnthropicProfileHistory()
    const text = `: heartbeat\r\n\r\n${frames(streamEvents())}data: invalid-json\r\n\r\n`
    const original = streamingResponse(text, 1)
    const observed = history.observeResponse(original)
    expect(observed.status).toBe(original.status)
    expect(observed.statusText).toBe(original.statusText)
    expect([...observed.headers]).toEqual([...original.headers])
    expect(new Uint8Array(await observed.arrayBuffer())).toEqual(encoder.encode(text))
    expect(original.body!.locked).toBe(false)
    expect(history.prepareMessages([{ role: 'assistant', content: [thinking] }]))
      .toEqual([{ role: 'assistant', content: [thinking] }])
  })

  test('trusts the final signature when the SDK receives multiple signature events', async () => {
    const history = createAnthropicProfileHistory()
    const events = streamEvents()
    events.splice(3, 0, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'replaced-signature' } })
    const sdk = client(history, () => streamingResponse(frames(events)))
    const reply = await sdk.messages.stream({
      model: 'vendor/model', max_tokens: 2000, messages: [{ role: 'user', content: 'Read a.ts' }],
    }).finalMessage()
    expect(reply.content[0]).toEqual(thinking)
    expect(history.prepareMessages([{ role: 'assistant', content: reply.content }]))
      .toEqual([{ role: 'assistant', content: reply.content }])
    expect(history.prepareMessages([{ role: 'assistant', content: [{ ...thinking, signature: 'replaced-signature' }] }]))
      .toEqual([])
  })

  test('keeps interleaved signature streams separate and follows SDK signature replacement semantics', async () => {
    const history = createAnthropicProfileHistory()
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'a' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'cd' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'b' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'content_block_stop', index: 0 },
    ]
    await history.observeResponse(streamingResponse(frames(events))).text()
    const content = ['b', 'cd'].map(signature => ({ ...thinking, signature }))
    expect(history.prepareMessages([{ role: 'assistant', content }])).toEqual([{ role: 'assistant', content }])
    expect(history.prepareMessages([{ role: 'assistant', content: [{ ...thinking, signature: 'abcd' }] }])).toEqual([])
  })

  test('does not trust unfinished blocks or consume bytes ahead of the reader', async () => {
    const history = createAnthropicProfileHistory()
    let reads = 0
    let cancelled: unknown
    const prefix = frames(streamEvents().slice(0, 4))
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        controller.enqueue(encoder.encode(prefix))
      },
      cancel(reason) { cancelled = reason },
    }, { highWaterMark: 0 })
    const observed = history.observeResponse(new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }))
    await Promise.resolve()
    expect(reads).toBe(0)
    const reader = observed.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(prefix)
    expect(reads).toBe(1)
    await reader.cancel('finished early')
    reader.releaseLock()
    expect(cancelled).toBe('finished early')
    expect(upstream.locked).toBe(false)
    expect(history.prepareMessages([{ role: 'assistant', content: [thinking, tool] }]))
      .toEqual([{ role: 'assistant', content: [tool] }])
  })

  test('cancel wakes an in-flight upstream read and releases its lock', async () => {
    const history = createAnthropicProfileHistory()
    let cancelled = false
    const upstream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }, { highWaterMark: 0 })
    const observed = history.observeResponse(new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }))
    const reader = observed.body!.getReader()
    const pending = reader.read()
    await reader.cancel('stop')
    expect(await pending).toEqual({ done: true, value: undefined })
    reader.releaseLock()
    expect(cancelled).toBe(true)
    expect(upstream.locked).toBe(false)
  })

  test('forwards read failures and releases the upstream reader', async () => {
    const history = createAnthropicProfileHistory()
    const failure = new Error('connection lost')
    const upstream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure) } }, { highWaterMark: 0 })
    const observed = history.observeResponse(new Response(upstream, { headers: { 'content-type': 'application/json' } }))
    await expect(observed.text()).rejects.toBe(failure)
    expect(upstream.locked).toBe(false)
  })

  test('passes through HTTP errors and unsupported response types without trusting their content', async () => {
    const history = createAnthropicProfileHistory()
    for (const response of [
      Response.json(message([thinking]), { status: 400 }),
      new Response(JSON.stringify(message([thinking])), { headers: { 'content-type': 'text/plain' } }),
      new Response(null, { status: 204 }),
    ]) {
      expect(history.observeResponse(response)).toBe(response)
    }
    expect(history.prepareMessages([{ role: 'assistant', content: [thinking] }])).toEqual([])
  })

  test('removes foreign thinking-only assistant turns and keeps ordinary messages unchanged', () => {
    const history = createAnthropicProfileHistory()
    const text = { role: 'assistant', content: [{ type: 'text', text: 'Earlier reply' }] }
    const user = { role: 'user', content: 'Continue' }
    expect(history.prepareMessages([
      { role: 'assistant', content: [thinking, redacted] }, text, user,
      { role: 'assistant', content: [{ ...thinking, signature: '' }, tool] }, result,
    ])).toEqual([text, user, { role: 'assistant', content: [tool] }, result])
  })

  test('bounds trust history while retaining the newest completed thinking', async () => {
    const history = createAnthropicProfileHistory()
    const content = Array.from({ length: 4097 }, (_, index) => ({ ...thinking, signature: `signature-${index}` }))
    await history.observeResponse(Response.json(message(content))).json()
    expect(history.prepareMessages([{ role: 'assistant', content: [content[0]!, content.at(-1)!] }]))
      .toEqual([{ role: 'assistant', content: [content.at(-1)!] }])
  })
})
