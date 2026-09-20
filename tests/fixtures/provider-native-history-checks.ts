import assert from 'node:assert/strict'
import { createNativeMessageSource, nativeItemMetadata } from '../../src/providers/messages.js'
import { filterOrphanedThinkingOnlyMessages, normalizeMessagesForAPI } from '../../src/utils/messages.js'
import type { AssistantMessage } from '../../src/utils/messages.js'

const source = createNativeMessageSource('openai-responses', { provider: 'one', endpoint: 'https://example.com/v1/responses', model: 'model' })
const reasoning = { type: 'thinking' as const, thinking: '', signature: '' }
const metadata = nativeItemMetadata(source, 'response', 0, { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'opaque' }, [reasoning])[0]!
const nativeReasoning = { ...reasoning, providerMetadata: metadata }
function assistant(content: unknown[]): AssistantMessage {
  return { type: 'assistant', uuid: 'a7d401c4-a738-4588-bbf1-3a4a2c935e19', timestamp: '2026-01-01T00:00:00Z', message: {
    id: 'response', type: 'message', role: 'assistant', model: 'one/model', content,
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  } } as AssistantMessage
}

const nativeOnly = assistant([nativeReasoning])
assert.deepEqual(filterOrphanedThinkingOnlyMessages([nativeOnly]), [nativeOnly])
assert.deepEqual(normalizeMessagesForAPI([nativeOnly])[0]!.message.content, [nativeReasoning])

const signed = { type: 'thinking' as const, thinking: 'private Claude thought', signature: 'signed' }
assert.deepEqual(filterOrphanedThinkingOnlyMessages([assistant([signed])]), [])
assert.deepEqual(normalizeMessagesForAPI([assistant([signed])]), [])

const text = { type: 'text' as const, text: 'answer' }
assert.deepEqual(normalizeMessagesForAPI([assistant([text, signed])])[0]!.message.content, [text])
assert.deepEqual(normalizeMessagesForAPI([assistant([text, nativeReasoning])])[0]!.message.content, [text, nativeReasoning])
assert.deepEqual(normalizeMessagesForAPI([assistant([text, nativeReasoning, signed])])[0]!.message.content, [text, nativeReasoning])

const invalid = { ...reasoning, providerMetadata: { invalid: 'opaque' } }
assert.deepEqual(filterOrphanedThinkingOnlyMessages([assistant([invalid])]), [])
console.log('native history checks passed')
