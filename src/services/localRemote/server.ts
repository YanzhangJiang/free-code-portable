import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { LOCAL_REMOTE_CSS, LOCAL_REMOTE_HTML, LOCAL_REMOTE_JS } from './browser.js'
import type { LocalSession } from './session.js'

export type LocalRemoteServer = { url: string; close(): Promise<void> }

function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new Error('Expected application/json.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('Request exceeds 256 KiB.')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Takes ownership of session only after listen succeeds. The caller must await
 * close() on shutdown; it drains the child and closes all SSE subscriptions.
 * This intentionally binds loopback only. Use an SSH tunnel for remote access.
 */
export async function startLocalRemoteServer(options: {
  session: LocalSession
  token: string
  port?: number
}): Promise<LocalRemoteServer> {
  if (options.token.length < 32 || options.token.length > 4096 || /\s/.test(options.token)) throw new Error('Local remote token must contain 32–4096 non-whitespace characters.')
  if (!Number.isInteger(options.port ?? 8080) || (options.port ?? 8080) < 0 || (options.port ?? 8080) > 65535) throw new Error('Port must be an integer from 0 to 65535.')
  const tokenHash = createHash('sha256').update(options.token).digest()
  const clients = new Set<ServerResponse>()
  const activeRequests = new Set<Promise<void>>()
  let closing = false
  let closePromise: Promise<void> | undefined

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
    const host = request.headers.host ?? ''
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) { respond(response, 403, { error: 'Only loopback Host headers are allowed.' }); return }
    if (request.headers.origin && request.headers.origin !== `http://${host}`) { respond(response, 403, { error: 'Cross-origin requests are not allowed.' }); return }
    if (request.headers['sec-fetch-site'] === 'cross-site') { respond(response, 403, { error: 'Cross-site requests are not allowed.' }); return }
    if (closing) { respond(response, 503, { error: 'Server is shutting down.' }); return }
    const url = new URL(request.url ?? '/', `http://${host}`)
    const assets: Record<string, [string, string]> = {
      '/': ['text/html; charset=utf-8', LOCAL_REMOTE_HTML],
      '/client.js': ['text/javascript; charset=utf-8', LOCAL_REMOTE_JS],
      '/style.css': ['text/css; charset=utf-8', LOCAL_REMOTE_CSS],
    }
    const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined
    if (request.method === 'GET' && asset) {
      response.writeHead(200, { 'Content-Type': asset[0] }); response.end(asset[1]); return
    }
    const authorization = request.headers.authorization ?? ''
    const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!timingSafeEqual(tokenHash, createHash('sha256').update(candidate).digest())) {
      respond(response, 401, { error: 'A valid Bearer token is required.' }); return
    }
    if (request.method === 'GET' && url.pathname === '/status') { respond(response, 200, options.session.status()); return }
    if (request.method === 'GET' && url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? '0')
      if (!Number.isSafeInteger(after) || after < 0) { respond(response, 400, { error: 'Invalid event cursor.' }); return }
      if (clients.size >= 8) { respond(response, 429, { error: 'Too many event subscribers.' }); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      response.write(': connected\n\n')
      clients.add(response)
      const send = (event: ReturnType<LocalSession['replay']>[number]) => {
        if (response.destroyed) return
        // Bound a stalled subscriber without interpreting write(false) as an
        // error: a single legitimate SDK event can exceed the high-water mark.
        if (response.writableLength > 8 * 1024 * 1024) { response.destroy(); return }
        response.write(`id: ${event.id}\ndata: ${JSON.stringify(event.message)}\n\n`)
      }
      const unsubscribe = options.session.subscribe(send)
      response.once('close', () => { unsubscribe(); clients.delete(response) })
      for (const event of options.session.replay(after)) send(event)
      return
    }
    if (request.method === 'DELETE' && url.pathname === '/session') {
      await options.session.close(); respond(response, 200, { ok: true }); return
    }
    if (request.method !== 'POST' || !['/prompt', '/cancel', '/permission'].includes(url.pathname)) { respond(response, 404, { error: 'Unknown endpoint.' }); return }
    let body: unknown
    try { body = await readJson(request) } catch { respond(response, 400, { error: 'Expected a JSON object no larger than 256 KiB.' }); return }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { respond(response, 400, { error: 'Expected a JSON object.' }); return }
    const fields = body as Record<string, unknown>
    let result
    if (url.pathname === '/prompt') {
      if (typeof fields.prompt !== 'string' || !fields.prompt.trim()) { respond(response, 400, { error: 'A non-empty prompt is required.' }); return }
      result = options.session.prompt(fields.prompt)
    } else if (url.pathname === '/permission') {
      if (typeof fields.requestId !== 'string' || typeof fields.allow !== 'boolean') { respond(response, 400, { error: 'requestId and allow are required.' }); return }
      result = options.session.permission(fields.requestId, fields.allow)
    } else result = options.session.cancel()
    respond(response, result.ok ? 202 : result.status, result)
  }

  const server = createServer((request, response) => {
    const pending = handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) respond(response, 500, { error: 'The local server could not complete the request.' })
      else response.destroy()
    }).finally(() => activeRequests.delete(pending))
    activeRequests.add(pending)
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
      const onListening = () => { server.off('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(options.port ?? 8080, '127.0.0.1')
    })
  } catch (error) { server.close(); throw error }
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      if (!closePromise) closePromise = (async () => {
        closing = true
        const stopped = new Promise<void>(resolve => server.close(() => resolve()))
        for (const response of clients) response.end()
        await options.session.close()
        server.closeAllConnections()
        await stopped
        await Promise.allSettled([...activeRequests])
      })()
      return closePromise
    },
  }
}
