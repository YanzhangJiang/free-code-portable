import { nativeItemMetadata, type MessageRecord, type NativeMessageSource } from '../../providers/messages.js'

/**
 * Attach provenance before the caller persists a completed thinking block. The
 * response body owns its reader; cancellation and parse failure release it.
 */
export function annotateAnthropicResponse(response: Response, source: NativeMessageSource, signal?: AbortSignal | null): Response {
  const streaming = response.headers.get('content-type')?.includes('text/event-stream')
  if (!response.ok || !response.body || (!streaming && !response.headers.get('content-type')?.includes('application/json'))) return response
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const pending = new Map<number, MessageRecord>()
  let responseId = ''
  let buffered = ''
  let ended = false
  let cleanup: Promise<void> | undefined
  let downstream: ReadableStreamDefaultController<Uint8Array>

  function annotateBlock(block: MessageRecord, index: number) {
    return nativeItemMetadata(source, responseId, index, { ...block }, [block])[0]!
  }

  function annotateFrame(frame: string): string {
    const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!payload || payload === '[DONE]') return frame
    const event = JSON.parse(payload) as MessageRecord
    const index = Number(event.index)
    if (event.type === 'message_start') {
      responseId = String((event.message as MessageRecord).id)
      pending.clear()
    } else if (event.type === 'content_block_start') {
      const block = event.content_block as MessageRecord
      if (block.type === 'thinking' || block.type === 'redacted_thinking') pending.set(index, { ...block })
    } else if (event.type === 'content_block_delta') {
      const block = pending.get(index)
      const delta = event.delta as MessageRecord
      if (block && delta.type === 'thinking_delta') block.thinking = String(block.thinking ?? '') + String(delta.thinking)
      if (block && delta.type === 'signature_delta') block.signature = delta.signature
    } else if (event.type === 'content_block_stop') {
      const block = pending.get(index)
      if (block) {
        event.providerMetadata = annotateBlock(block, index)
        pending.delete(index)
        return `event: ${event.type}\ndata: ${JSON.stringify(event)}`
      }
    }
    return frame
  }

  function release(cancel: boolean, reason?: unknown): Promise<void> {
    signal?.removeEventListener('abort', onAbort)
    cleanup ??= (async () => {
      try { if (cancel) await reader.cancel(reason) }
      catch { /* Preserve the original transport or parse error. */ }
      finally { reader.releaseLock(); pending.clear(); buffered = '' }
    })()
    return cleanup
  }

  function onAbort(): void {
    if (ended) return
    ended = true
    downstream.error(signal!.reason)
    // The body owns this cleanup promise; pending pull/cancel also await it.
    void release(true, signal!.reason)
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    },
    async pull(controller) {
      if (ended) return
      try {
        while (!ended) {
          let emitted = false
          const chunk = await reader.read()
          if (ended) return
          buffered += decoder.decode(chunk.value, { stream: !chunk.done })
          if (streaming) {
            let boundary: RegExpExecArray | null
            while ((boundary = /\r?\n\r?\n/.exec(buffered))) {
              const frame = buffered.slice(0, boundary.index)
              buffered = buffered.slice(boundary.index + boundary[0].length)
              controller.enqueue(encoder.encode(annotateFrame(frame) + '\n\n'))
              emitted = true
            }
            if (chunk.done && buffered.trim()) controller.enqueue(encoder.encode(annotateFrame(buffered) + '\n\n'))
          } else if (chunk.done) {
            const message = JSON.parse(buffered) as MessageRecord
            responseId = String(message.id)
            if (Array.isArray(message.content)) message.content.forEach((block: MessageRecord, index: number) => {
              if (block.type === 'thinking' || block.type === 'redacted_thinking') block.providerMetadata = annotateBlock(block, index)
            })
            controller.enqueue(encoder.encode(JSON.stringify(message)))
          }
          if (chunk.done) {
            ended = true
            await release(false)
            controller.close()
          }
          if (emitted) return
        }
      } catch (error) {
        if (!ended) { ended = true; controller.error(error) }
        await release(true, error)
      }
    },
    async cancel(reason) { ended = true; await release(true, reason) },
  }, { highWaterMark: 0 })
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
