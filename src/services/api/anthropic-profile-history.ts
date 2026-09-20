import { createHash, type Hash } from 'node:crypto'
import { replayNativeContent, withoutProviderMetadata, type NativeMessageSource } from '../../providers/messages.js'
import { annotateAnthropicResponse } from './anthropic-message-metadata.js'

type WireObject = Record<string, unknown>
type ThinkingIdentity = { type: 'thinking' | 'redacted_thinking'; value: string }

function wireObject(value: unknown): WireObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as WireObject
    : undefined
}

function thinkingIdentity(block: WireObject): ThinkingIdentity | undefined {
  if (block.type === 'thinking' && typeof block.signature === 'string' && block.signature) {
    return { type: 'thinking', value: block.signature }
  }
  if (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data) {
    return { type: 'redacted_thinking', value: block.data }
  }
  return undefined
}

function identityHash(type: ThinkingIdentity['type']): Hash {
  return createHash('sha256').update(type).update('\0')
}

/** One owner per runtime profile/model; never share this across provider credentials. */
export function createAnthropicProfileHistory(source?: NativeMessageSource): {
  prepareMessages(messages: unknown[]): unknown[]
  observeResponse(response: Response, signal?: AbortSignal | null): Response
} {
  // Store only fingerprints, never thinking text. An evicted old block becomes
  // portable history without thinking; the newest completed blocks stay trusted.
  const trusted = new Set<string>()
  const maximumIdentities = 4096

  function remember(fingerprint: string): void {
    trusted.delete(fingerprint)
    trusted.add(fingerprint)
    if (trusted.size > maximumIdentities) trusted.delete(trusted.values().next().value!)
  }

  function rememberContent(content: unknown): void {
    if (!Array.isArray(content)) return
    for (const value of content) {
      const block = wireObject(value)
      const identity = block && thinkingIdentity(block)
      if (identity) remember(identityHash(identity.type).update(identity.value).digest('hex'))
    }
  }

  function prepareMessages(messages: unknown[]): unknown[] {
    return messages.flatMap(value => {
      const message = wireObject(value)
      if (!message || !Array.isArray(message.content)) return [value]
      const content = message.content.filter(value => {
        const block = wireObject(value)
        if (!block || (block.type !== 'thinking' && block.type !== 'redacted_thinking')) return true
        const identity = thinkingIdentity(block)
        if (!identity) return false
        if (source && 'nativeItem' in replayNativeContent([block], source)[0]!) return true
        const fingerprint = identityHash(identity.type).update(identity.value).digest('hex')
        if (!trusted.has(fingerprint)) return false
        remember(fingerprint)
        return true
      })
      // A foreign thinking-only assistant message has no portable content. Keep
      // tool_use/tool_result blocks together with their original message ordering.
      if (message.role === 'assistant' && content.length === 0) return []
      if (!content.some(value => wireObject(value)?.providerMetadata !== undefined)) {
        return content.length === message.content.length ? [value] : [{ ...message, content }]
      }
      return [{ ...message, content: content.map(withoutProviderMetadata) }]
    })
  }

  function observeResponse(response: Response, signal?: AbortSignal | null): Response {
    if (source) response = annotateAnthropicResponse(response, source, signal)
    if (!response.ok || !response.body) return response
    const contentType = response.headers.get('content-type') ?? ''
    const streaming = contentType.includes('text/event-stream')
    if (!streaming && !contentType.includes('application/json')) return response

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const pendingBlocks = new Map<number, { type: ThinkingIdentity['type']; hash: Hash; hasValue: boolean }>()
    let buffered = ''
    let eventData: string[] = []
    let ended = false
    let cleanup: Promise<void> | undefined

    function observeEvent(payload: string): void {
      let event: WireObject | undefined
      try {
        event = wireObject(JSON.parse(payload))
      } catch {
        // Observation must not alter protocol errors or bytes seen by the SDK.
        return
      }
      if (!event) return
      if (event.type === 'message_start') pendingBlocks.clear()
      if (!Number.isSafeInteger(event.index) || (event.index as number) < 0) return
      const index = event.index as number
      if (event.type === 'content_block_start') {
        pendingBlocks.delete(index)
        const block = wireObject(event.content_block)
        if (!block || (block.type !== 'thinking' && block.type !== 'redacted_thinking')) return
        const identity = thinkingIdentity(block)
        pendingBlocks.set(index, {
          type: block.type,
          hash: identityHash(block.type).update(identity?.value ?? ''),
          hasValue: Boolean(identity),
        })
      } else if (event.type === 'content_block_delta') {
        const delta = wireObject(event.delta)
        const pending = pendingBlocks.get(index)
        if (pending?.type === 'thinking' && delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
          // Match @anthropic-ai/sdk 0.80 MessageStream and claude.ts's
          // signature_delta handling: each event replaces the full signature.
          pending.hash = identityHash('thinking').update(delta.signature)
          pending.hasValue = delta.signature.length > 0
        }
      } else if (event.type === 'content_block_stop') {
        const pending = pendingBlocks.get(index)
        if (pending?.hasValue) remember(pending.hash.digest('hex'))
        pendingBlocks.delete(index)
      }
    }

    function observeLine(line: string): void {
      if (!line) {
        if (eventData.length > 0) observeEvent(eventData.join('\n'))
        eventData = []
      } else if (line.startsWith('data:')) {
        eventData.push(line.slice(5).replace(/^ /, ''))
      }
    }

    function observeBytes(bytes?: Uint8Array, done = false): void {
      buffered += decoder.decode(bytes, { stream: !done })
      if (!streaming) {
        if (done) {
          try {
            rememberContent(wireObject(JSON.parse(buffered))?.content)
          } catch {
            // The SDK remains responsible for reporting invalid JSON responses.
          }
        }
        return
      }
      let boundary: RegExpExecArray | null
      while ((boundary = /\r\n|\r|\n/.exec(buffered)) !== null) {
        // A CR at a chunk boundary may be the first byte of CRLF.
        if (!done && boundary[0] === '\r' && boundary.index === buffered.length - 1) break
        observeLine(buffered.slice(0, boundary.index))
        buffered = buffered.slice(boundary.index + boundary[0].length)
      }
      if (done && buffered) observeLine(buffered)
      if (done) observeLine('')
    }

    function releaseReader(cancel: boolean, reason?: unknown): Promise<void> {
      cleanup ??= (async () => {
        try {
          if (cancel) await reader.cancel(reason)
        } catch {
          // Preserve the original read/cancel error rather than cleanup failure.
        } finally {
          reader.releaseLock()
          buffered = ''
          eventData = []
          pendingBlocks.clear()
        }
      })()
      return cleanup
    }

    // This body owns the upstream reader. No background read or clone consumes
    // bytes ahead of the SDK, and every completion/cancel/error releases the lock.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (ended) return
        try {
          const chunk = await reader.read()
          if (ended) return
          observeBytes(chunk.value, chunk.done)
          if (chunk.done) {
            ended = true
            await releaseReader(false)
            controller.close()
          } else {
            controller.enqueue(chunk.value)
          }
        } catch (error) {
          if (!ended) {
            ended = true
            controller.error(error)
          }
          await releaseReader(true, error)
        }
      },
      async cancel(reason) {
        ended = true
        await releaseReader(true, reason)
      },
    }, { highWaterMark: 0 })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  return { prepareMessages, observeResponse }
}
