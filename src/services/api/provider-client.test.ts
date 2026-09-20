import { expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { adaptMessagesClient } from './provider-client.js'
import type { ProviderClient } from '../../providers/client.js'

test('an agent consumer only requires message, stream, and token-count operations', async () => {
  const signal = new AbortController().signal
  const calls: string[] = []
  const sdk = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: (async (input, init) => {
    const request = new Request(input, init)
    calls.push(new URL(request.url).pathname)
    expect(request.signal.aborted).toBe(false)
    if (new URL(request.url).pathname.endsWith('count_tokens')) return Response.json({ input_tokens: 12 }, { headers: { 'request-id': 'count-id' } })
    return Response.json({ id: 'msg', type: 'message', role: 'assistant', model: 'model', content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 2 } }, { headers: { 'request-id': 'message-id' } })
  }) as typeof fetch })
  const client = adaptMessagesClient(sdk)
  expect(Object.keys(client).sort()).toEqual(['countTokens', 'createMessage', 'streamMessages'])
  const request = { model: 'model', max_tokens: 100, messages: [{ role: 'user' as const, content: 'hello' }] }
  expect((await client.createMessage(request, { signal })).requestId).toBe('message-id')
  expect((await client.countTokens(request, { signal })).data.input_tokens).toBe(12)
  expect(calls).toEqual(['/v1/messages', '/v1/messages/count_tokens'])
})

test('a native implementation replaces SDKs and exposes explicit stream cancellation', async () => {
  const controller = new AbortController()
  let released = false
  const client: ProviderClient<{ prompt: string }, string, string, string, number> = {
    async createMessage(request) { return { data: request.prompt, response: new Response(), requestId: null } },
    async countTokens(request) { return { data: request.length, response: new Response(), requestId: null } },
    async streamMessages(request) {
      return { data: {
        controller,
        async *[Symbol.asyncIterator]() {
          try { yield request.prompt; controller.signal.throwIfAborted() }
          finally { released = true }
        },
      }, response: new Response(), requestId: null }
    },
  }
  const stream = (await client.streamMessages({ prompt: 'native' })).data
  for await (const event of stream) { expect(event).toBe('native'); stream.controller.abort(); break }
  expect(released).toBe(true)
  expect(controller.signal.aborted).toBe(true)
})

test('legacy/native SDK boundaries strip internal state before serialization while profiles retain it for their adapter', async () => {
  const history = [
    { role: 'assistant' as const, content: [
      { type: 'thinking' as const, thinking: 'foreign private state', signature: 'foreign signature', providerMetadata: { opaque: true } },
      { type: 'text' as const, text: 'Portable answer', providerMetadata: { opaque: true } },
      { type: 'tool_use' as const, id: 'call', name: 'read', input: { providerMetadata: 'user field' }, providerMetadata: { opaque: true } },
    ] },
  ]
  let sent: any
  const sdk = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: (async (_input, init) => {
    sent = JSON.parse(String(init?.body))
    return Response.json({ id: 'msg', type: 'message', role: 'assistant', model: 'model', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } })
  }) as typeof fetch })
  await adaptMessagesClient(sdk).createMessage({ model: 'model', max_tokens: 10, messages: history })
  expect(sent.messages[0].content.map((block: any) => block.type)).toEqual(['text', 'tool_use'])
  expect(sent.messages[0].content[0]).toEqual({ type: 'text', text: 'Portable answer' })
  expect(sent.messages[0].content[1].input).toEqual({ providerMetadata: 'user field' })
  expect(JSON.stringify(sent)).not.toContain('foreign')
  await adaptMessagesClient(sdk, { preserveNativeHistory: true }).createMessage({ model: 'model', max_tokens: 10, messages: history })
  expect(sent.messages).toEqual(history)
})
