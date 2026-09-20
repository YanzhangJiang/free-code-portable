import type { ChildProcessWithoutNullStreams } from 'node:child_process'

type JsonObject = Record<string, unknown>
export type LocalRemoteEvent = { id: number; message: JsonObject }
export type SessionAction = { ok: true } | { ok: false; status: number; error: string }
export type SessionStatus = 'idle' | 'running' | 'stopping' | 'closed'

export type LocalSession = {
  status(): { state: SessionStatus; sessionId?: string; permissions: JsonObject[] }
  prompt(prompt: string): SessionAction
  cancel(): SessionAction
  permission(requestId: string, allow: boolean): SessionAction
  replay(after: number): LocalRemoteEvent[]
  subscribe(listener: (event: LocalRemoteEvent) => void): () => void
  close(): Promise<void>
}

/** Owns one persistent SDK child, its stream listeners, and shutdown deadline.
 * Call close() and await it before releasing the server. Subscribers borrow the
 * session until their returned unsubscribe function is called.
 */
export function createLocalSession(options: {
  spawn: () => ChildProcessWithoutNullStreams
  newId: () => string
  terminate?: (child: ChildProcessWithoutNullStreams, signal: 'SIGTERM' | 'SIGKILL') => void
  shutdownGraceMs?: number
}): LocalSession {
  let state: SessionStatus = 'idle'
  let child: ChildProcessWithoutNullStreams | undefined
  let childClosed: Promise<void> | undefined
  let closePromise: Promise<void> | undefined
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined
  let sessionId: string | undefined
  let stdout = ''
  let nextEventId = 1
  let historyBytes = 0
  const history: { event: LocalRemoteEvent; bytes: number }[] = []
  const listeners = new Set<(event: LocalRemoteEvent) => void>()
  const permissions = new Map<string, JsonObject>()
  const maxEventBytes = 4 * 1024 * 1024
  const maxHistoryBytes = 8 * 1024 * 1024

  function publish(message: JsonObject): void {
    const event = { id: nextEventId++, message }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    history.push({ event, bytes })
    historyBytes += bytes
    while (history.length > 512 || historyBytes > maxHistoryBytes) {
      historyBytes -= history.shift()!.bytes
    }
    for (const listener of listeners) listener(event)
  }

  function write(message: JsonObject): boolean {
    if (!child || child.stdin.destroyed || state === 'closed' || state === 'stopping') return false
    child.stdin.write(JSON.stringify(message) + '\n')
    return true
  }

  function stopChild(): void {
    if (!child || state === 'closed' || state === 'stopping') return
    state = 'stopping'
    permissions.clear()
    child.stdin.end()
    const terminate = options.terminate ?? ((process, signal) => { process.kill(signal) })
    terminate(child, 'SIGTERM')
    shutdownTimer = setTimeout(() => { if (child) terminate(child, 'SIGKILL') }, options.shutdownGraceMs ?? 2000)
  }

  function protocolFailure(): void {
    stdout = ''
    publish({ type: 'local_error', error: 'The CLI emitted invalid or oversized stream JSON.' })
    stopChild()
  }

  function onStdout(chunk: Buffer | string): void {
    stdout += chunk.toString()
    let end: number
    while ((end = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, end)
      stdout = stdout.slice(end + 1)
      if (!line.trim()) continue
      if (Buffer.byteLength(line) > maxEventBytes) { protocolFailure(); return }
      let message: JsonObject
      try {
        const value: unknown = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid SDK event')
        message = value as JsonObject
      } catch { protocolFailure(); return }
      if (typeof message.session_id === 'string') sessionId = message.session_id
      if (message.type === 'result') {
        if (state === 'running') state = 'idle'
        permissions.clear()
      }
      if (message.type === 'control_request') {
        const request = message.request as JsonObject | undefined
        if (request?.subtype === 'can_use_tool' && typeof message.request_id === 'string') {
          if (permissions.size >= 100) { protocolFailure(); return }
          permissions.set(message.request_id, message)
        } else if (typeof message.request_id === 'string') {
          write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'This local client does not support this control request.' } })
        }
      }
      if (message.type === 'control_cancel_request' && typeof message.request_id === 'string') permissions.delete(message.request_id)
      // Initialization can contain account and connector metadata. The remote UI
      // needs only session/model/tool names, never the CLI's account response.
      if (message.type === 'control_response') continue
      if (message.type === 'system' && message.subtype === 'init') {
        message = { type: 'system', subtype: 'init', session_id: message.session_id, model: message.model, tools: message.tools }
      }
      publish(message)
    }
    if (Buffer.byteLength(stdout) > maxEventBytes) protocolFailure()
  }

  function start(): boolean {
    if (child) return true
    try { child = options.spawn() } catch {
      state = 'closed'
      publish({ type: 'local_error', error: 'Could not start the CLI process. Check the server terminal.' })
      return false
    }
    const ownedChild = child
    // stderr is drained but not exposed: diagnostics may contain credentials.
    ownedChild.stderr.resume()
    ownedChild.stdout.setEncoding('utf8')
    ownedChild.stdout.on('data', onStdout)
    const onError = () => {
      publish({ type: 'local_error', error: 'The CLI process failed. Check its local configuration.' })
      stopChild()
    }
    ownedChild.on('error', onError)
    ownedChild.stdin.on('error', onError)
    childClosed = new Promise(resolve => {
      ownedChild.once('close', (code, signal) => {
        if (shutdownTimer) clearTimeout(shutdownTimer)
        ownedChild.stdout.off('data', onStdout)
        ownedChild.off('error', onError)
        ownedChild.stdin.off('error', onError)
        ownedChild.stdin.destroy()
        ownedChild.stdout.destroy()
        ownedChild.stderr.destroy()
        stdout = ''
        permissions.clear()
        state = 'closed'
        publish({ type: 'local_session_closed', exitCode: code, signal })
        resolve()
      })
    })
    return true
  }

  return {
    status: () => ({ state, sessionId, permissions: [...permissions.values()] }),
    prompt(prompt) {
      if (state !== 'idle') return { ok: false, status: 409, error: state === 'closed' ? 'Session is closed. Restart local-remote for a new session.' : 'A turn is already running.' }
      if (!start()) return { ok: false, status: 503, error: 'Could not start the CLI process.' }
      state = 'running'
      // Canonical SDK user-message shape: entrypoints/sdk/coreSchemas.ts.
      if (!write({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: sessionId ?? '', uuid: options.newId() })) {
        stopChild()
        return { ok: false, status: 503, error: 'The CLI input stream is closed.' }
      }
      return { ok: true }
    },
    cancel() {
      if (state !== 'running') return { ok: false, status: 409, error: 'No turn is running.' }
      permissions.clear()
      publish({ type: 'local_permissions_cleared' })
      if (!write({ type: 'control_request', request_id: options.newId(), request: { subtype: 'interrupt' } })) {
        return { ok: false, status: 503, error: 'The CLI input stream is closed.' }
      }
      return { ok: true }
    },
    permission(requestId, allow) {
      const message = permissions.get(requestId)
      if (!message || state !== 'running') return { ok: false, status: 409, error: 'This permission request is no longer pending.' }
      const request = message.request as JsonObject
      const response = allow ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Denied by the local remote user.' }
      if (!write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })) {
        return { ok: false, status: 503, error: 'The CLI input stream is closed.' }
      }
      permissions.delete(requestId)
      publish({ type: 'local_permission_resolved', request_id: requestId })
      return { ok: true }
    },
    replay(after) { return history.filter(entry => entry.event.id > after).map(entry => entry.event) },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    close() {
      if (!closePromise) {
        stopChild()
        if (!child) state = 'closed'
        closePromise = (childClosed ?? Promise.resolve()).finally(() => listeners.clear())
      }
      return closePromise
    },
  }
}
