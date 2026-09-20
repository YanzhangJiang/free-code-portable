import { expect, test } from 'bun:test'
import { connect, createServer } from 'node:net'
import { createServer as createHTTPSServer } from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { requestPublicURL } from './direct.js'

// Loopback only, no external network or credentials. Some sandboxes prohibit
// listeners; explicitly enable alongside the CLI's other network integration tests.
const networkTest = process.env.FREE_CODE_TEST_NETWORK === '1' ? test : test.skip

async function withProxy(
  connected: (authority: string, socket: Duplex, headers: string) => void,
  run: (proxy: string) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Duplex>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let request = ''
    const receive = (chunk: Buffer) => {
      request += chunk.toString()
      if (!request.includes('\r\n\r\n')) return
      socket.removeListener('data', receive)
      connected(/^CONNECT ([^ ]+) HTTP\/1\.1/.exec(request)?.[1] ?? '', socket, request)
    }
    socket.on('data', receive)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing proxy listener')
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

networkTest('native proxy CONNECT targets the pinned IP and returns proxy failure without following it', async () => {
  let authority = ''
  await withProxy((request, socket) => {
    authority = request
    socket.resume()
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  }, async proxy => {
    await expect(requestPublicURL(new URL('https://example.com/'), { address: '93.184.216.34', family: 4 }, new AbortController().signal, undefined, undefined, proxy)).rejects.toThrow('proxy rejected CONNECT with HTTP 502')
    expect(authority).toBe('93.184.216.34:443')
  })
})

networkTest('CONNECT preserves target TLS certificate and HTTP Host through a local proxy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'free-code-webfetch-tls-'))
  try {
    const keyPath = join(directory, 'key.pem')
    const certPath = join(directory, 'cert.pem')
    const generated = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=example.com', '-addext', 'subjectAltName=DNS:example.com', '-keyout', keyPath, '-out', certPath],
      { stdout: 'pipe', stderr: 'pipe' })
    if (generated.exitCode !== 0) throw new Error('Could not generate throwaway test TLS certificate.')
    const certificate = readFileSync(certPath, 'utf8')
    let host = ''
    const target = createHTTPSServer({ key: readFileSync(keyPath), cert: certificate }, (request, response) => {
      host = request.headers.host ?? ''
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers['proxy-authorization']).toBeUndefined()
      response.end('proxy success')
    })
    await new Promise<void>((resolve, reject) => {
      target.once('error', reject)
      target.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = target.address()
      if (!address || typeof address === 'string') throw new Error('Missing TLS target listener')
      await withProxy((authority, socket, headers) => {
        expect(authority).toBe('93.184.216.34:443')
        expect(headers).toContain(`Proxy-Authorization: Basic ${Buffer.from('fixture:secret').toString('base64')}`)
        const upstream = connect(address.port, '127.0.0.1')
        upstream.once('error', () => socket.destroy())
        socket.once('error', () => upstream.destroy())
        upstream.once('close', () => socket.destroy())
        socket.once('close', () => upstream.destroy())
        upstream.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.pipe(socket)
          socket.pipe(upstream)
        })
      }, async proxy => {
        const authenticatedProxy = proxy.replace('://', '://fixture:secret@')
        const result = await requestPublicURL(new URL('https://example.com/'), { address: '93.184.216.34', family: 4 }, new AbortController().signal, [certificate], undefined, authenticatedProxy)
        expect(result.body.toString()).toBe('proxy success')
        expect(host).toBe('example.com')
        await expect(requestPublicURL(new URL('https://wrong.example.com/'), { address: '93.184.216.34', family: 4 }, new AbortController().signal, [certificate], undefined, authenticatedProxy)).rejects.toThrow()
      })
    } finally {
      target.closeAllConnections()
      // Bun's closeAllConnections also stops this test listener.
      await new Promise<void>((resolve, reject) => target.close(error =>
        error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve(),
      ))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

networkTest('cancelling a pending native CONNECT releases the proxy socket', async () => {
  const controller = new AbortController()
  let closed: Promise<void> | undefined
  await withProxy((_request, socket) => {
    closed = new Promise(resolve => socket.once('close', resolve))
    socket.resume()
    controller.abort(new Error('cancelled pending CONNECT'))
  }, async proxy => {
    await expect(requestPublicURL(new URL('https://example.com/'), { address: '93.184.216.34', family: 4 }, controller.signal, undefined, undefined, proxy)).rejects.toThrow()
    if (!closed) throw new Error('CONNECT was not received')
    await closed
  })
})

networkTest('cancelling a pending target TLS handshake releases the proxy tunnel', async () => {
  const controller = new AbortController()
  let closed: Promise<void> | undefined
  await withProxy((_request, socket) => {
    closed = new Promise(resolve => socket.once('close', resolve))
    socket.once('data', () => controller.abort(new Error('cancelled TLS handshake')))
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  }, async proxy => {
    await expect(requestPublicURL(new URL('https://example.com/'), { address: '93.184.216.34', family: 4 }, controller.signal, undefined, undefined, proxy)).rejects.toThrow()
    if (!closed) throw new Error('CONNECT was not received')
    await closed
  })
})
