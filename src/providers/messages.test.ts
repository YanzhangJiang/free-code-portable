import { expect, test } from 'bun:test'
import { createNativeMessageSource, nativeItemMetadata, replayNativeContent, readProviderMetadata, withoutProviderMetadata } from './messages.js'

const source = createNativeMessageSource('openai-responses', { provider: 'ours', endpoint: 'https://example.com/v1/responses', model: 'Model' })
const native = { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'A' }, { type: 'output_text', text: 'B' }] }

function fixture() {
  const blocks = [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]
  const metadata = nativeItemMetadata(source, 'response_1', 1, native, blocks)
  return blocks.map((block, index) => ({ ...block, providerMetadata: metadata[index] }))
}

test('native transcript metadata survives serialization and restores an entire item once', () => {
  const resumed = JSON.parse(JSON.stringify(fixture()))
  expect(replayNativeContent(resumed, source)).toEqual([{ nativeItem: native }])
  expect(JSON.stringify(resumed)).not.toContain('https://')
  expect(readProviderMetadata({ arbitrary: 'private' })).toBeUndefined()
})

test('native data never crosses profile, endpoint, protocol or model boundaries', () => {
  for (const identity of [
    { provider: 'other', endpoint: 'https://example.com/v1/responses', model: 'Model' },
    { provider: 'ours', endpoint: 'https://other.example/v1/responses', model: 'Model' },
    { provider: 'ours', endpoint: 'https://example.com/v1/responses', model: 'OtherModel' },
  ]) expect(replayNativeContent(fixture(), createNativeMessageSource('openai-responses', identity))).toEqual(fixture().map(block => ({ block })))
  expect(replayNativeContent(fixture(), { ...source, api: 'anthropic' })).toEqual(fixture().map(block => ({ block })))
})

test('compacted, edited or duplicated projections cannot resurrect native output', () => {
  const blocks = fixture()
  for (const changed of [blocks.slice(1), [{ ...blocks[0]!, text: 'edited' }, blocks[1]!], [...blocks, blocks[0]!]]) {
    expect(replayNativeContent(changed, source).every(item => 'block' in item)).toBe(true)
  }
})

test('parallel item completion order restores output order while retaining ordinary history', () => {
  const item = { type: 'function_call', id: 'fc', call_id: 'call', name: 'read', arguments: '{}' }
  const block = { type: 'tool_use', id: 'call', name: 'read', input: {} }
  const tool = { ...block, providerMetadata: nativeItemMetadata(source, 'response_1', 0, item, [block])[0] }
  expect(replayNativeContent([...fixture(), tool], source)).toEqual([{ nativeItem: item }, { nativeItem: native }])
})

test('metadata stripping preserves a tool input property with the same name', () => {
  expect(withoutProviderMetadata({ role: 'assistant', content: [{ type: 'tool_use', providerMetadata: { secret: 'private' }, input: { providerMetadata: 'user data' } }] })).toEqual({ role: 'assistant', content: [{ type: 'tool_use', input: { providerMetadata: 'user data' } }] })
})
