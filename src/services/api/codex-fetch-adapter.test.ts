import { expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { createCodexFetch, isCodexModel, mapClaudeModelToCodex } from './codex-fetch-adapter.js'

const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.signature`

test('Codex keeps explicit model IDs instead of silently downgrading them', () => {
  for (const model of ['gpt-5.3-codex', 'gpt-5.4-mini', 'gpt-next', 'custom/gpt-new']) {
    expect(mapClaudeModelToCodex(model)).toBe(model)
  }
  expect(mapClaudeModelToCodex('claude-opus-4-6')).toBe('gpt-5.1-codex-max')
  expect(mapClaudeModelToCodex('haiku')).toBe('gpt-5.1-codex-mini')
  expect(mapClaudeModelToCodex('sonnet[1m]')).toBe('gpt-5.2-codex')
  expect(isCodexModel('gpt-5.4-mini')).toBe(true)
  expect(isCodexModel('codex-next')).toBe(true)
  expect(isCodexModel('claude-opus-4-6')).toBe(false)
})

test('Codex authenticates with its captured token and shares Responses stream/nonstream conversion', async () => {
  const controller = new AbortController()
  let calls = 0
  const adapter = createCodexFetch(token, (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++
    expect(String(input)).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${token}`)
    expect(new Headers(init!.headers).get('chatgpt-account-id')).toBe('test-account')
    expect(new Headers(init!.headers).get('originator')).toBe('free-code')
    expect(new Headers(init!.headers).has('x-api-key')).toBe(false)
    const body = JSON.parse(String(init!.body))
    expect(body.model).toBe('gpt-5.4-mini')
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('temperature')
    expect(init!.signal!.aborted).toBe(false)
    const events = [
      { type: 'response.created', response: { id: 'resp_test' } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello' },
      { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof globalThis.fetch)
  const response = await adapter('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'private-anthropic-key' },
    signal: controller.signal,
    body: JSON.stringify({ model: 'gpt-5.4-mini', max_tokens: 100, temperature: 0.8, messages: [{ role: 'user', content: 'Hi' }], stream: false }),
  })
  const message = await response.json()
  expect(calls).toBe(1)
  expect(message.content).toEqual([{ type: 'text', text: 'Hello' }])
  expect(message.usage).toMatchObject({ input_tokens: 6, cache_read_input_tokens: 4, output_tokens: 2 })
})

test('Codex rejects malformed credentials without loading ambient authentication', () => {
  for (const invalid of ['not-a-token', 'a.e30.c', `a.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 1 } })).toString('base64url')}.c`]) {
    expect(() => createCodexFetch(invalid)).toThrow('Sign in to Codex again')
  }
})
