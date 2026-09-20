import {
  responsesStopReason,
  responsesItemBlocks,
  responsesUsage,
  wireObject,
  wireString,
  type WireObject,
} from './openai-responses-protocol.js'
import { nativeItemMetadata, type NativeMessageSource, type ProviderMetadata } from '../../providers/messages.js'
import { providerStreamError } from './provider-wire-errors.js'

type OutputBlock = {
  index: number
  outputIndex: number
  type: 'text' | 'thinking' | 'tool_use'
  value: string
  closed: boolean
  providerMetadata?: ProviderMetadata
}

// Event names/indices follow the Responses streaming contract, not chunk order:
// https://developers.openai.com/api/reference/resources/responses/streaming-events
function createEventTranslator(model: string, source?: NativeMessageSource) {
  const blocks = new Map<string, OutputBlock>()
  let started = false
  let completed = false
  let hasTools = false
  let responseId = 'msg_responses'

  return {
    get completed() { return completed },
    translate(event: WireObject): WireObject[] {
      const events: WireObject[] = []
      const start = (key: string, outputIndex: number, content: WireObject): OutputBlock => {
        const existing = blocks.get(key)
        if (existing) return existing
        const block: OutputBlock = {
          index: blocks.size,
          outputIndex,
          type: content.type as OutputBlock['type'],
          value: '',
          closed: false,
        }
        blocks.set(key, block)
        events.push({ type: 'content_block_start', index: block.index, content_block: content })
        return block
      }
      const append = (block: OutputBlock, value: string) => {
        if (!value) return
        if (block.closed) throw new Error('OpenAI Responses: received a delta after block completion')
        block.value += value
        const delta = block.type === 'tool_use'
          ? { type: 'input_json_delta', partial_json: value }
          : block.type === 'thinking'
            ? { type: 'thinking_delta', thinking: value }
            : { type: 'text_delta', text: value }
        events.push({ type: 'content_block_delta', index: block.index, delta })
      }
      const completeValue = (block: OutputBlock, value: string) => {
        if (!value.startsWith(block.value)) {
          throw new Error('OpenAI Responses: final content differs from streamed content')
        }
        append(block, value.slice(block.value.length))
      }
      const close = (block: OutputBlock) => {
        if (block.closed) return
        block.closed = true
        events.push({ type: 'content_block_stop', index: block.index,
          ...(block.providerMetadata ? { providerMetadata: block.providerMetadata } : {}) })
      }
      const textBlock = (outputIndex: number, partIndex: number, thinking: boolean) => start(
        `${outputIndex}:${thinking ? 'thinking' : 'text'}:${partIndex}`,
        outputIndex,
        thinking ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' },
      )
      const outputItem = (item: WireObject, outputIndex: number, final: boolean) => {
        let metadata: ProviderMetadata[] | undefined
        if (final && source) {
          try {
            metadata = nativeItemMetadata(source, responseId, outputIndex, item, responsesItemBlocks(item, true))
          } catch (error) {
            // A token limit can truncate a tool's JSON. Preserve the partial
            // stream and its max_tokens reason, without replayable native state.
            if (item.type !== 'function_call' || !(error instanceof SyntaxError)) throw error
          }
        }
        switch (item.type) {
          case 'function_call': {
            hasTools = true
            const block = start(`${outputIndex}:tool`, outputIndex, {
              type: 'tool_use',
              id: wireString(item.call_id, 'tool call ID'),
              name: wireString(item.name, 'tool name'),
              input: {},
            })
            if (typeof item.arguments === 'string') completeValue(block, item.arguments)
            if (metadata) block.providerMetadata = metadata[0]
            if (final) close(block)
            break
          }
          case 'message':
          case 'reasoning': {
            const thinking = item.type === 'reasoning'
            const parts = thinking && final && source && (!Array.isArray(item.summary) || item.summary.length === 0)
              ? [{ type: 'summary_text', text: '' }]
              : thinking ? item.summary : item.content
            if (Array.isArray(parts)) {
              parts.forEach((value, partIndex) => {
                const part = wireObject(value, 'output part')
                const block = textBlock(outputIndex, partIndex, thinking)
                const content = thinking || part.type === 'output_text' ? part.text : part.refusal
                completeValue(block, wireString(content, 'output text'))
                if (metadata) block.providerMetadata = metadata[partIndex]
                if (final) close(block)
              })
            }
            break
          }
          default:
            throw new Error(`OpenAI Responses: unsupported output item ${String(item.type)}`)
        }
        if (final) {
          for (const block of blocks.values()) {
            if (block.outputIndex === outputIndex) close(block)
          }
        }
      }

      if (!started) {
        const response = event.response == null ? {} : wireObject(event.response, 'response')
        responseId = typeof response.id === 'string' ? response.id : responseId
        events.push({
          type: 'message_start',
          message: {
            id: responseId,
            type: 'message', role: 'assistant', model, content: [],
            stop_reason: null, stop_sequence: null,
            usage: responsesUsage(response.usage),
          },
        })
        started = true
      }

      const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0
      switch (event.type) {
        case 'error':
        case 'response.failed': {
          const response = event.response == null ? event : wireObject(event.response, 'failed response')
          const error = response.error == null ? response : wireObject(response.error, 'response error')
          throw providerStreamError(error, 'OpenAI Responses')
        }
        case 'response.output_item.added':
        case 'response.output_item.done':
          outputItem(wireObject(event.item, 'output item'), outputIndex, event.type.endsWith('.done'))
          break
        case 'response.function_call_arguments.delta':
        case 'response.function_call_arguments.done': {
          const block = blocks.get(`${outputIndex}:tool`)
          if (!block) throw new Error('OpenAI Responses: tool arguments arrived before tool metadata')
          if (event.type.endsWith('.done')) completeValue(block, wireString(event.arguments, 'tool arguments'))
          else append(block, wireString(event.delta, 'tool argument delta'))
          break
        }
        case 'response.content_part.added':
        case 'response.content_part.done':
        case 'response.reasoning_summary_part.added':
        case 'response.reasoning_summary_part.done': {
          const thinking = event.type.startsWith('response.reasoning')
          const partIndex = Number(thinking ? event.summary_index ?? 0 : event.content_index ?? 0)
          const part = wireObject(event.part, 'content part')
          const block = textBlock(outputIndex, partIndex, thinking)
          completeValue(block, wireString(part.type === 'refusal' ? part.refusal : part.text, 'content part text'))
          if (event.type.endsWith('.done') && !source) close(block)
          break
        }
        case 'response.output_text.delta':
        case 'response.output_text.done':
        case 'response.refusal.delta':
        case 'response.refusal.done':
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_summary_text.done': {
          const thinking = event.type.startsWith('response.reasoning')
          const partIndex = Number(thinking ? event.summary_index ?? 0 : event.content_index ?? 0)
          const block = textBlock(outputIndex, partIndex, thinking)
          if (event.type.endsWith('.done')) {
            completeValue(block, wireString(event.type === 'response.refusal.done' ? event.refusal : event.text, 'final text'))
            if (!source) close(block)
          } else append(block, wireString(event.delta, 'text delta'))
          break
        }
        case 'response.completed':
        case 'response.incomplete': {
          const response = wireObject(event.response, 'completed response')
          if (typeof response.id === 'string') responseId = response.id
          if (Array.isArray(response.output)) {
            response.output.forEach((item, index) => outputItem(wireObject(item, 'final output item'), index, true))
          }
          const stopReason = responsesStopReason(response, hasTools)
          for (const block of blocks.values()) close(block)
          // The caller updates accounting from message_delta, never message_stop.
          events.push({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: responsesUsage(response.usage),
          })
          events.push({ type: 'message_stop' })
          completed = true
          break
        }
      }
      return events
    },
  }
}

function parseFrame(frame: string): WireObject | undefined {
  const payload = frame.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n')
  if (!payload || payload === '[DONE]') return undefined
  return wireObject(JSON.parse(payload), 'stream event')
}

/** The returned body owns the upstream reader. Pull, cancel, and error all release it. */
export function responsesEventStream(
  body: ReadableStream<Uint8Array>,
  model: string,
  signal?: AbortSignal | null,
  source?: NativeMessageSource,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const translator = createEventTranslator(model, source)
  let ended = false
  let cleanup: Promise<void> | undefined
  let downstream: ReadableStreamDefaultController<Uint8Array>

  function releaseReader(reason?: unknown): Promise<void> {
    signal?.removeEventListener('abort', onAbort)
    cleanup ??= (async () => {
      try {
        await reader.cancel(reason)
      } catch {
        // read() reports the transport failure; cleanup must not replace it.
      } finally {
        reader.releaseLock()
      }
    })()
    return cleanup
  }

  function onAbort(): void {
    if (ended) return
    ended = true
    downstream.error(signal!.reason)
    // The response owns this cleanup promise; pull/cancel also await it. Cancel
    // wakes a pending read even when an injected transport ignores AbortSignal.
    void releaseReader(signal!.reason)
  }

  async function* translate(): AsyncGenerator<Uint8Array, void, void> {
    let buffered = ''
    try {
      while (!translator.completed) {
        const chunk = await reader.read()
        if (ended) return
        buffered += decoder.decode(chunk.value, { stream: !chunk.done })
        let boundary: RegExpExecArray | null
        while ((boundary = /\r?\n\r?\n/.exec(buffered)) !== null || (chunk.done && buffered.trim())) {
          const frame = boundary ? buffered.slice(0, boundary.index) : buffered
          buffered = boundary ? buffered.slice(boundary.index + boundary[0].length) : ''
          const event = parseFrame(frame)
          if (!event) continue
          for (const translated of translator.translate(event)) {
            yield encoder.encode(`event: ${translated.type}\ndata: ${JSON.stringify(translated)}\n\n`)
          }
          if (translator.completed) return
        }
        if (chunk.done) throw new Error('OpenAI Responses: stream ended before response completion')
      }
    } finally {
      await releaseReader()
    }
  }

  const iterator = translate()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    },
    async pull(controller) {
      if (ended) return
      try {
        signal?.throwIfAborted()
        const next = await iterator.next()
        signal?.throwIfAborted()
        if (ended) return
        if (next.done === true) {
          ended = true
          controller.close()
        }
        else controller.enqueue(next.value)
      } catch (error) {
        if (!ended) {
          ended = true
          controller.error(error)
        }
        await releaseReader(error)
        await iterator.return()
      }
    },
    async cancel(reason) {
      ended = true
      // Cancel before returning the generator to wake any in-flight read.
      await releaseReader(reason)
      await iterator.return()
    },
  })
}

/** Collect the adapter's own events for endpoints (Codex) that only support streaming. */
export async function collectResponsesMessage(stream: ReadableStream<Uint8Array>): Promise<WireObject> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let message: WireObject | undefined
  const content: WireObject[] = []
  const argumentsByIndex = new Map<number, string>()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      // responsesEventStream emits exactly one complete SSE frame per chunk.
      const event = parseFrame(decoder.decode(chunk.value))!
      const index = Number(event.index)
      switch (event.type) {
        case 'message_start': message = wireObject(event.message, 'message'); break
        case 'content_block_start': content[index] = wireObject(event.content_block, 'content block'); break
        case 'content_block_delta': {
          const delta = wireObject(event.delta, 'content delta')
          if (delta.type === 'text_delta') content[index]!.text = String(content[index]!.text) + String(delta.text)
          else if (delta.type === 'thinking_delta') content[index]!.thinking = String(content[index]!.thinking) + String(delta.thinking)
          else if (delta.type === 'input_json_delta') argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? '') + String(delta.partial_json))
          break
        }
        case 'content_block_stop':
          if (event.providerMetadata) content[index]!.providerMetadata = event.providerMetadata
          if (content[index]?.type === 'tool_use') {
            content[index]!.input = wireObject(JSON.parse(argumentsByIndex.get(index) ?? '{}'), 'tool arguments')
          }
          break
        case 'message_delta':
          Object.assign(message!, wireObject(event.delta, 'message delta'), { usage: event.usage })
          break
      }
    }
    if (!message) throw new Error('OpenAI Responses: stream contained no message')
    return { ...message, content }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}
