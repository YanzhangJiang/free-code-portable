import { providerStreamError } from './provider-wire-errors.js'
import { nativeItemMetadata, type NativeMessageSource } from '../../providers/messages.js'
type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`OpenAI-compatible response: expected ${label}`)
  }
  return value as JsonObject
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function usage(value: unknown): JsonObject {
  const reported = value == null ? {} : object(value, 'usage')
  const details = reported.prompt_tokens_details == null ? {} : object(reported.prompt_tokens_details, 'prompt token details')
  const promptTokens = count(reported.prompt_tokens)
  const cachedTokens = Math.min(promptTokens, count(details.cached_tokens ?? reported.prompt_cache_hit_tokens))
  // OpenAI's prompt total includes cache hits; Anthropic reports them separately.
  return {
    input_tokens: promptTokens - cachedTokens,
    output_tokens: count(reported.completion_tokens),
    cache_read_input_tokens: cachedTokens,
    cache_creation_input_tokens: 0,
  }
}

function stopReason(value: unknown): string {
  switch (value) {
    case 'stop': return 'end_turn'
    case 'length': return 'max_tokens'
    case 'tool_calls': return 'tool_use'
    case 'content_filter': return 'refusal'
    default: throw new Error(`OpenAI-compatible response: unsupported finish reason ${String(value)}`)
  }
}

function toolInput(argumentsText: string): JsonObject {
  try {
    return object(JSON.parse(argumentsText || '{}'), 'tool argument object')
  } catch {
    throw new Error('OpenAI-compatible response contains invalid JSON tool arguments')
  }
}

function responseError(value: JsonObject): void {
  if (value.error !== undefined) {
    throw providerStreamError(value.error, 'OpenAI-compatible provider error')
  }
}

function choice(value: JsonObject): JsonObject | undefined {
  responseError(value)
  if (!Array.isArray(value.choices)) throw new Error('OpenAI-compatible response is missing choices')
  if (value.choices.length === 0) return undefined
  if (value.choices.length !== 1) throw new Error('OpenAI-compatible response must contain exactly one choice')
  const selected = object(value.choices[0], 'choice')
  if (selected.index !== undefined && selected.index !== 0) throw new Error('OpenAI-compatible response has an unexpected choice index')
  return selected
}

function messageStart(id: unknown, model: string): JsonObject {
  return {
    id: typeof id === 'string' ? id : 'openai-message',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: usage(undefined),
  }
}

export function convertCompletionResponse(value: unknown, model: string, source?: NativeMessageSource): JsonObject {
  const completion = object(value, 'completion')
  const selected = choice(completion)
  if (!selected) throw new Error('OpenAI-compatible response contains no completion')
  const message = object(selected.message, 'assistant message')
  const content: JsonObject[] = []
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    const block = { type: 'thinking', thinking: message.reasoning_content, signature: '' }
    content.push({ ...block, ...(source ? { providerMetadata: nativeItemMetadata(source, String(completion.id), 0, block, [block])[0] } : {}) })
  }
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content })
  if (typeof message.refusal === 'string' && message.refusal) content.push({ type: 'text', text: message.refusal })
  if (Array.isArray(message.tool_calls)) {
    for (const value of message.tool_calls) {
      const tool = object(value, 'tool call')
      const definition = object(tool.function, 'tool function')
      if (tool.type !== 'function' || typeof tool.id !== 'string' || !tool.id || typeof definition.name !== 'string' || !definition.name || typeof definition.arguments !== 'string') {
        throw new Error('OpenAI-compatible response contains an invalid function call')
      }
      content.push({ type: 'tool_use', id: tool.id, name: definition.name, input: toolInput(definition.arguments) })
    }
  }
  return {
    ...messageStart(completion.id, model),
    content,
    stop_reason: stopReason(selected.finish_reason),
    usage: usage(completion.usage),
  }
}

/** Parse SSE framing independently from network chunks, including UTF-8 splits. */
async function* payloads(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let pending = ''
  let lines: string[] = []
  for (;;) {
    const result = await reader.read()
    pending += decoder.decode(result.value, { stream: !result.done })
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline === -1) break
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      if (line === '') {
        if (lines.length) yield lines.join('\n')
        lines = []
      } else if (line.startsWith('data:')) {
        lines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (result.done) {
      // A final event without its terminating blank line is still readable.
      if (pending.startsWith('data:')) lines.push(pending.slice(5).replace(/^ /, '').replace(/\r$/, ''))
      if (lines.length) yield lines.join('\n')
      return
    }
  }
}

type PendingTool = {
  id: string
  name: string
  arguments: string
  blockIndex?: number
  emittedArguments: number
}

export function convertCompletionStream(response: Response, model: string, signal: AbortSignal, source?: NativeMessageSource): Response {
  if (!response.body) throw new Error('OpenAI-compatible provider returned an empty stream')
  const reader = response.body.getReader()
  let readerCleanup: Promise<void> | undefined
  function releaseReader(reason?: unknown): Promise<void> {
    signal.removeEventListener('abort', onAbort)
    readerCleanup ??= (async () => {
      try {
        await reader.cancel(reason)
      } catch {
        // read() has already surfaced transport errors; cleanup must not mask them.
      } finally {
        reader.releaseLock()
      }
    })()
    return readerCleanup
  }
  const encoder = new TextEncoder()
  function event(type: string, body: JsonObject = {}): Uint8Array {
    return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`)
  }

  async function* translate(): AsyncGenerator<Uint8Array> {
    let started = false
    let finished = false
    let finishReason: unknown
    let reportedUsage: unknown
    let blockIndex = 0
    let activeBlock: 'text' | 'thinking' | undefined
    let activeText = ''
    let responseId = ''
    const stopActiveBlock = () => {
      const block = { type: 'thinking', thinking: activeText, signature: '' }
      const providerMetadata = source && activeBlock === 'thinking'
        ? nativeItemMetadata(source, responseId, blockIndex, block, [block])[0] : undefined
      return event('content_block_stop', { index: blockIndex++, ...(providerMetadata ? { providerMetadata } : {}) })
    }
    const tools = new Map<number, PendingTool>()
    try {
      for await (const payload of payloads(reader)) {
        signal.throwIfAborted()
        if (payload === '[DONE]') break
        const chunk = object(JSON.parse(payload), 'stream chunk')
        const selected = choice(chunk)
        if (!started) {
          started = true
          responseId = String(chunk.id ?? 'openai-message')
          yield event('message_start', { message: messageStart(chunk.id, model) })
        }
        if (chunk.usage != null) reportedUsage = chunk.usage
        if (!selected) continue
        const delta = selected.delta == null ? {} : object(selected.delta, 'stream delta')
        if (finished && Object.values(delta).some(value => value != null && value !== '')) {
          throw new Error('OpenAI-compatible provider sent content after the finish event')
        }
        for (const [field, type] of [['reasoning_content', 'thinking'], ['content', 'text'], ['refusal', 'text']] as const) {
          const text = delta[field]
          if (text == null || text === '') continue
          if (typeof text !== 'string') throw new Error(`OpenAI-compatible response has invalid ${field}`)
          if (activeBlock !== type) {
            if (activeBlock) yield stopActiveBlock()
            activeBlock = type
            activeText = ''
            yield event('content_block_start', {
              index: blockIndex,
              content_block: type === 'thinking' ? { type, thinking: '', signature: '' } : { type, text: '' },
            })
          }
          activeText += text
          yield event('content_block_delta', {
            index: blockIndex,
            delta: type === 'thinking' ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text },
          })
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new Error('OpenAI-compatible response has invalid tool calls')
          for (const value of delta.tool_calls) {
            const part = object(value, 'tool call delta')
            if (!Number.isSafeInteger(part.index) || Number(part.index) < 0) throw new Error('OpenAI-compatible tool call is missing its index')
            if (part.type !== undefined && part.type !== 'function') throw new Error('OpenAI-compatible response contains an unsupported tool type')
            const index = Number(part.index)
            const tool: PendingTool = tools.get(index) ?? { id: '', name: '', arguments: '', emittedArguments: 0 }
            let identityChanged = typeof part.id === 'string' && part.id.length > 0
            if (typeof part.id === 'string') tool.id += part.id
            if (part.function !== undefined) {
              const definition = object(part.function, 'tool function delta')
              if (typeof definition.name === 'string') {
                tool.name += definition.name
                identityChanged ||= definition.name.length > 0
              }
              if (typeof definition.arguments === 'string') tool.arguments += definition.arguments
            }
            if (tool.blockIndex !== undefined && identityChanged) {
              throw new Error('OpenAI-compatible provider changed a tool identity after streaming its arguments')
            }
            // Allow fragmented identities before arguments start. Once subsequent
            // argument-only deltas arrive, keep them flowing to UI/watchdog users.
            if (tool.blockIndex === undefined && !identityChanged && tool.id && tool.name) {
              if (activeBlock) {
                yield stopActiveBlock()
                activeBlock = undefined
              }
              tool.blockIndex = blockIndex++
              yield event('content_block_start', { index: tool.blockIndex, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } })
            }
            if (tool.blockIndex !== undefined && tool.arguments.length > tool.emittedArguments) {
              yield event('content_block_delta', { index: tool.blockIndex, delta: { type: 'input_json_delta', partial_json: tool.arguments.slice(tool.emittedArguments) } })
              tool.emittedArguments = tool.arguments.length
            }
            tools.set(index, tool)
          }
        }
        if (selected.finish_reason != null) {
          finishReason = selected.finish_reason
          stopReason(finishReason)
          finished = true
        }
      }
      signal.throwIfAborted()
      if (!started || !finished) throw new Error('OpenAI-compatible stream ended before a finish reason was received')
      if (activeBlock) yield stopActiveBlock()
      // Finish buffered one-chunk tools and close already streaming tools. A token
      // limit may intentionally leave partial JSON; preserve max_tokens so the
      // application's existing continuation/recovery path can handle that case.
      for (const [, tool] of [...tools].sort(([left], [right]) => left - right)) {
        if (!tool.id || !tool.name) throw new Error('OpenAI-compatible stream contains an incomplete tool call')
        if (finishReason !== 'length') toolInput(tool.arguments)
        if (tool.blockIndex === undefined) {
          tool.blockIndex = blockIndex++
          yield event('content_block_start', { index: tool.blockIndex, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } })
        }
        if (tool.arguments.length > tool.emittedArguments || tool.arguments.length === 0) {
          yield event('content_block_delta', { index: tool.blockIndex, delta: { type: 'input_json_delta', partial_json: tool.arguments.slice(tool.emittedArguments) || '{}' } })
        }
        yield event('content_block_stop', { index: tool.blockIndex })
      }
      yield event('message_delta', { delta: { stop_reason: stopReason(finishReason), stop_sequence: null }, usage: usage(reportedUsage) })
      yield event('message_stop')
    } finally {
      await releaseReader()
    }
  }

  const iterator = translate()
  let downstream: ReadableStreamDefaultController<Uint8Array>
  let ended = false
  function onAbort(): void {
    if (ended) return
    ended = true
    downstream.error(signal.reason)
    // The memoized cleanup belongs to this response and is awaited by pull/cancel.
    // Cancelling the reader also wakes an in-flight read in injected transports.
    releaseReader(signal.reason)
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    },
    async pull(controller) {
      if (ended) return
      try {
        signal.throwIfAborted()
        const result = await iterator.next()
        signal.throwIfAborted()
        if (result.done) {
          ended = true
          controller.close()
        } else if (!ended) controller.enqueue(result.value)
      } catch (error) {
        if (!ended) {
          ended = true
          controller.error(error)
        }
        await releaseReader(error)
        await iterator.return(undefined)
      }
    },
    async cancel(reason) {
      ended = true
      // Cancel first so an in-flight read resolves before returning the iterator.
      await releaseReader(reason)
      await iterator.return(undefined)
    },
  })
  const headers = new Headers({ 'content-type': 'text/event-stream' })
  const requestId = response.headers.get('request-id') ?? response.headers.get('x-request-id')
  if (requestId) headers.set('request-id', requestId)
  return new Response(body, { headers })
}
