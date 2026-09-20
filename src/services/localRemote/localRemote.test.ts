import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createLocalSession, type LocalSession } from './session.js'
import { startLocalRemoteServer, type LocalRemoteServer } from './server.js'
import { parseLocalRemoteArgs } from '../../entrypoints/localRemote.js'

class FakeChild extends EventEmitter {
  readonly writes: string[] = []
  readonly signals: string[] = []
  readonly stdin = new Writable({ write: (chunk, _encoding, done) => { this.writes.push(chunk.toString()); done() } })
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  closeOnTerminate = true
  kill(signal: string): boolean {
    this.signals.push(signal)
    if (this.closeOnTerminate || signal === 'SIGKILL') queueMicrotask(() => this.emit('close', null, signal))
    return true
  }
  emitMessage(message: unknown): void { this.stdout.write(JSON.stringify(message) + '\n') }
  asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams }
}

const sessions: LocalSession[] = []
const servers: LocalRemoteServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(sessions.splice(0).map(session => session.close()))
})

function fixture() {
  const child = new FakeChild()
  let nextId = 1
  let spawnCount = 0
  const session = createLocalSession({ spawn: () => { spawnCount++; return child.asChild() }, newId: () => `id-${nextId++}`, shutdownGraceMs: 5 })
  sessions.push(session)
  return { child, session, spawnCount: () => spawnCount }
}

describe('owned local remote SDK session', () => {
  test('one child owns successive turns and preserves the byte-level SDK wire shape', () => {
    const { child, session, spawnCount } = fixture()
    expect(spawnCount()).toBe(0)
    expect(session.prompt('Read project')).toEqual({ ok: true })
    expect(child.writes[0]).toBe('{"type":"user","message":{"role":"user","content":"Read project"},"parent_tool_use_id":null,"session_id":"","uuid":"id-1"}\n')
    expect(session.prompt('overlap').ok).toBe(false)
    child.emitMessage({ type: 'result', session_id: 'owned-session', result: 'done' })
    expect(session.status().state).toBe('idle')
    expect(session.prompt('Continue').ok).toBe(true)
    expect(child.writes[1]).toContain('"session_id":"owned-session"')
    expect(spawnCount()).toBe(1)
  })

  test('permissions can only approve an outstanding exact input once', () => {
    const { child, session } = fixture()
    session.prompt('Make a file')
    expect(session.permission('missing', true).ok).toBe(false)
    child.emitMessage({ type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { path: 'a.txt', content: 'hello' } } })
    expect(session.status().permissions).toHaveLength(1)
    expect(session.permission('permission-1', true)).toEqual({ ok: true })
    expect(child.writes[1]).toBe('{"type":"control_response","response":{"subtype":"success","request_id":"permission-1","response":{"behavior":"allow","updatedInput":{"path":"a.txt","content":"hello"}}}}\n')
    expect(session.permission('permission-1', true).ok).toBe(false)
    child.emitMessage({ type: 'control_request', request_id: 'permission-2', request: { subtype: 'can_use_tool', input: {} } })
    expect(session.permission('permission-2', false).ok).toBe(true)
    expect(child.writes[2]).toContain('"behavior":"deny"')
  })

  test('interrupt cancels pending permissions but preserves the process for the next turn', () => {
    const { child, session } = fixture()
    expect(session.cancel().ok).toBe(false)
    session.prompt('Work')
    child.emitMessage({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool', input: {} } })
    expect(session.cancel()).toEqual({ ok: true })
    expect(child.writes[1]).toBe('{"type":"control_request","request_id":"id-2","request":{"subtype":"interrupt"}}\n')
    expect(session.permission('permission', true).ok).toBe(false)
    expect(child.signals).toEqual([])
    child.emitMessage({ type: 'result', is_error: true })
    expect(session.prompt('Continue').ok).toBe(true)
  })

  test('stream fragments, bounded replay, and subscriptions do not expose init account metadata', () => {
    const { child, session } = fixture()
    session.prompt('Work')
    const events: unknown[] = []
    const unsubscribe = session.subscribe(event => events.push(event))
    child.stdout.write('{"type":"system","subtype":"init","model":"test",')
    child.stdout.write('"account":{"token":"secret"},"mcp_servers":[{"url":"secret"}]}\n')
    child.emitMessage({ type: 'control_response', response: { token: 'secret' } })
    expect(JSON.stringify(events)).not.toContain('secret')
    expect(events).toHaveLength(1)
    unsubscribe()
    for (let index = 0; index < 600; index++) child.emitMessage({ type: 'assistant', index })
    expect(events).toHaveLength(1)
    expect(session.replay(0)).toHaveLength(512)
    const lastId = session.replay(0).at(-1)!.id
    expect(session.replay(lastId)).toEqual([])
  })

  test('shutdown waits for a stubborn child and escalates termination exactly once', async () => {
    const { child, session } = fixture()
    session.prompt('Work')
    child.closeOnTerminate = false
    const first = session.close()
    expect(session.close()).toBe(first)
    expect(session.prompt('late').ok).toBe(false)
    await first
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(session.status().state).toBe('closed')
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stdin.destroyed).toBe(true)
  })

  test('malformed output terminates the child without returning raw diagnostics', async () => {
    const { child, session } = fixture()
    session.prompt('Work')
    child.stderr.write('secret credential')
    child.stdout.write('malformed secret credential\n')
    await session.close()
    expect(session.status().state).toBe('closed')
    expect(JSON.stringify(session.replay(0))).not.toContain('secret credential')
  })

  test('failed startup and closing before startup leave no process behind', async () => {
    const session = createLocalSession({ spawn: () => { throw new Error('secret path') }, newId: () => 'id' })
    sessions.push(session)
    expect(session.prompt('Work').ok).toBe(false)
    await session.close()
    expect(JSON.stringify(session.replay(0))).not.toContain('secret path')
    const neverStarted = fixture()
    await neverStarted.session.close()
    expect(neverStarted.spawnCount()).toBe(0)
    expect(neverStarted.session.status().state).toBe('closed')
  })

  test('asynchronous startup and stdin failures close all owned streams', async () => {
    const { child, session } = fixture()
    session.prompt('Work')
    child.emit('error', new Error('spawn failed with private environment'))
    await session.close()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(child.stderr.destroyed).toBe(true)
    expect(child.listenerCount('error')).toBe(0)
    expect(JSON.stringify(session.replay(0))).not.toContain('private environment')
    const second = fixture()
    second.session.prompt('Work')
    second.child.stdin.emit('error', new Error('broken pipe'))
    await second.session.close()
    expect(second.session.status().state).toBe('closed')
  })

  test('oversized unterminated output cannot retain unbounded history', async () => {
    const { child, session } = fixture()
    session.prompt('Work')
    child.stdout.write('x'.repeat(4 * 1024 * 1024 + 1))
    await session.close()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(session.replay(0).length).toBeLessThanOrEqual(2)
    expect(JSON.stringify(session.replay(0)).length).toBeLessThan(1000)
  })
})

describe('loopback HTTP API', () => {
  const token = 'a'.repeat(64)
  async function runningServer() {
    const f = fixture()
    const server = await startLocalRemoteServer({ session: f.session, token, port: 0 })
    servers.push(server)
    return { ...f, server, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  }

  test('auth, origin and input checks precede any child creation', async () => {
    const { server, headers, spawnCount } = await runningServer()
    expect((await fetch(server.url + '/status')).status).toBe(401)
    expect((await fetch(server.url + '/status', { headers: { ...headers, Origin: 'https://attacker.invalid' } })).status).toBe(403)
    expect((await fetch(server.url + '/status', { headers: { ...headers, Host: 'attacker.invalid' } })).status).toBe(403)
    expect((await fetch(server.url + '/prompt', { method: 'POST', headers, body: '{' })).status).toBe(400)
    expect((await fetch(server.url + '/prompt', { method: 'POST', headers, body: '{"prompt":""}' })).status).toBe(400)
    expect(spawnCount()).toBe(0)
    const page = await fetch(server.url)
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(await page.text()).not.toContain(token)
  })

  test('authenticated prompt, event replay, cancellation and shutdown share one session', async () => {
    const { server, headers, child, session } = await runningServer()
    expect((await fetch(server.url + '/prompt', { method: 'POST', headers, body: '{"prompt":"Read files"}' })).status).toBe(202)
    child.emitMessage({ type: 'assistant', message: { content: 'Hello' } })
    const abort = new AbortController()
    const events = await fetch(server.url + '/events', { headers, signal: abort.signal })
    const reader = events.body!.getReader()
    try {
      const chunk = await reader.read()
      const wire = new TextDecoder().decode(chunk.value)
      expect(wire).toContain('id: 1\ndata: {"type":"assistant","message":{"content":"Hello"}}\n\n')
      expect((await fetch(server.url + '/cancel', { method: 'POST', headers, body: '{}' })).status).toBe(202)
      expect(child.writes.at(-1)).toContain('"subtype":"interrupt"')
      child.emitMessage({ type: 'result' })
      expect((await (await fetch(server.url + '/status', { headers })).json()).state).toBe('idle')
    } finally { abort.abort(); await reader.cancel().catch(() => {}); reader.releaseLock() }
    expect((await fetch(server.url + '/session', { method: 'DELETE', headers })).status).toBe(200)
    expect(session.status().state).toBe('closed')
    await server.close()
  })

  test('configuration rejects weak tokens and invalid ports before listening', async () => {
    const { session } = fixture()
    await expect(startLocalRemoteServer({ session, token: 'short', port: 0 })).rejects.toThrow('32')
    await expect(startLocalRemoteServer({ session, token, port: -1 })).rejects.toThrow('Port')
  })

  test('listen failure leaves the caller owning an intact session', async () => {
    const { server } = await runningServer()
    const second = fixture()
    await expect(startLocalRemoteServer({ session: second.session, token, port: Number(new URL(server.url).port) })).rejects.toThrow()
    expect(second.session.status().state).toBe('idle')
    expect(second.spawnCount()).toBe(0)
  })

  test('SSE disconnect unsubscribes and server shutdown closes an active reader', async () => {
    const f = fixture()
    let subscriptions = 0
    const subscribe = f.session.subscribe
    f.session.subscribe = listener => {
      subscriptions++
      const unsubscribe = subscribe(listener)
      return () => { subscriptions--; unsubscribe() }
    }
    const server = await startLocalRemoteServer({ session: f.session, token, port: 0 })
    servers.push(server)
    const abort = new AbortController()
    const response = await fetch(server.url + '/events', { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal })
    const reader = response.body!.getReader()
    await reader.read()
    expect(subscriptions).toBe(1)
    abort.abort()
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    // A new HTTP request gives the server a turn to deliver the disconnect.
    await fetch(server.url + '/status', { headers: { Authorization: `Bearer ${token}` } })
    expect(subscriptions).toBe(0)
    const second = await fetch(server.url + '/events', { headers: { Authorization: `Bearer ${token}` } })
    const secondReader = second.body!.getReader()
    await secondReader.read()
    await server.close()
    expect((await secondReader.read()).done).toBe(true)
    secondReader.releaseLock()
    expect(subscriptions).toBe(0)
    expect(f.session.status().state).toBe('closed')
  })
})

test('local remote CLI passes provider flags but owns its wire and permission protocol', () => {
  expect(parseLocalRemoteArgs(['--port=1234', '--cwd', '/tmp', '--token-env', 'REMOTE_TOKEN', '--', '--provider', 'local'])).toEqual({ port: 1234, cwd: '/tmp', tokenEnv: 'REMOTE_TOKEN', cliArgs: ['--provider', 'local'] })
  expect(() => parseLocalRemoteArgs(['--host', '0.0.0.0'])).toThrow('Unknown')
  expect(() => parseLocalRemoteArgs(['--port', '-1'])).toThrow('Port')
  expect(() => parseLocalRemoteArgs(['--', '--sdk-url=https://example.com'])).toThrow('manages')
  expect(() => parseLocalRemoteArgs(['--', '--permission-prompt-tool', 'other'])).toThrow('manages')
})
