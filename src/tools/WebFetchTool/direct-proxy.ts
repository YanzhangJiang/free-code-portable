import { HttpsProxyAgent } from 'https-proxy-agent'
import { connect as connectTCP, isIP } from 'node:net'
import { checkServerIdentity, connect as connectTLS, type TLSSocket, type PeerCertificate } from 'node:tls'
import type { Duplex } from 'node:stream'
import { isPublicAddress, type PublicAddress } from './direct-address.js'

type ProxyConnectionOptions = Parameters<HttpsProxyAgent<string>['connect']>[1]

/** CONNECT uses the validated IP; target TLS authenticates the original URL host. */
export function pinnedProxyOptions(options: ProxyConnectionOptions, address: PublicAddress, hostname: string): ProxyConnectionOptions {
  if (!isPublicAddress(address.address)) throw new Error('WebFetch blocked a non-public proxy destination.')
  return {
    ...options,
    secureEndpoint: true,
    host: address.address,
    servername: isIP(hostname) ? undefined : hostname,
    rejectUnauthorized: true,
    checkServerIdentity: (_servername: string, certificate: PeerCertificate) => checkServerIdentity(hostname, certificate),
  }
}

/** Own setup sockets explicitly: Bun does not reliably cancel agent CONNECT setup. */
function openProxyTunnel(proxy: URL, options: ProxyConnectionOptions, signal: AbortSignal, ca?: string[]): Promise<Duplex> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let socket: Duplex | undefined
    let settled = false
    let buffered = Buffer.alloc(0)
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      socket?.removeListener('data', receive)
      socket?.removeListener('end', ended)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      socket?.destroy()
      reject(error)
    }
    const abort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('WebFetch proxy connection cancelled.'))
    const ended = () => fail(new Error('WebFetch proxy closed before completing CONNECT.'))
    const receive = (chunk: Buffer) => {
      if (buffered.length + chunk.length > 64 * 1024) {
        fail(new Error('WebFetch proxy CONNECT response headers exceeded 64 KiB.'))
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      const headerEnd = buffered.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const status = /^HTTP\/1\.[01] (\d{3})(?: |\r\n)/.exec(buffered.toString('ascii'))?.[1]
      if (status !== '200' || headerEnd + 4 !== buffered.length) {
        fail(new Error(`WebFetch proxy rejected CONNECT${status ? ` with HTTP ${status}` : ''}.`))
        return
      }
      settled = true
      cleanup()
      socket!.pause()
      resolve(socket!)
    }
    const target = isIP(options.host ?? '') === 6 ? `[${options.host}]:${options.port}` : `${options.host}:${options.port}`
    let authorization = ''
    if (proxy.username || proxy.password) {
      let credentials: string
      try { credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}` } catch {
        reject(new Error('WebFetch proxy credentials contain invalid URL encoding.'))
        return
      }
      authorization = `Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}\r\n`
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const hostname = proxy.hostname.replace(/^\[|\]$/g, '')
      const endpoint = { host: hostname, port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)) }
      const connected: Duplex = proxy.protocol === 'https:'
        ? connectTLS({ ...endpoint, ca, rejectUnauthorized: true,
            servername: isIP(hostname) ? undefined : hostname,
            checkServerIdentity: (_servername: string, certificate: PeerCertificate) => checkServerIdentity(hostname, certificate),
            ALPNProtocols: ['http/1.1'],
          })
        : connectTCP(endpoint)
      socket = connected
      connected.once('error', fail)
      connected.once('end', ended)
      connected.on('data', receive)
      connected.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization}\r\n`)
    } catch (error) {
      fail(error instanceof Error ? error : new Error('WebFetch proxy connection failed.'))
    }
  })
}

function secureProxyTunnel(socket: Duplex, hostname: string, signal: AbortSignal, ca?: string[]): Promise<TLSSocket> {
  if (signal.aborted) { socket.destroy(); return Promise.reject(signal.reason) }
  return new Promise((resolve, reject) => {
    let secure: TLSSocket | undefined
    let settled = false
    const abort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('WebFetch proxy TLS connection cancelled.'))
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      secure?.destroy()
      socket.destroy()
      reject(error)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const connected: TLSSocket = connectTLS({
        socket, ca, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true,
        checkServerIdentity: (_servername: string, certificate: PeerCertificate) => checkServerIdentity(hostname, certificate),
        ALPNProtocols: ['http/1.1'],
      })
      secure = connected
      connected.once('error', fail)
      connected.once('secureConnect', () => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        secure!.removeListener('error', fail)
        resolve(secure!)
      })
    } catch (error) {
      fail(error instanceof Error ? error : new Error('WebFetch proxy TLS connection failed.'))
    }
  })
}

// This per-request agent owns completed tunnel sockets. Setup owns sockets until
// transfer, so cancellation works even before the agent registers a connection.
class PinnedProxyAgent extends HttpsProxyAgent<string> {
  constructor(
    proxy: string,
    private readonly destination: PublicAddress,
    private readonly hostname: string,
    private readonly signal: AbortSignal,
    private readonly ca?: string[],
  ) {
    super(proxy, { signal, ca, rejectUnauthorized: true, keepAlive: false })
  }

  override async connect(request: Parameters<HttpsProxyAgent<string>['connect']>[0], options: ProxyConnectionOptions) {
    const destination = pinnedProxyOptions(options, this.destination, this.hostname)
    const socket = await openProxyTunnel(this.proxy, destination, this.signal, this.ca)
    const secure = await secureProxyTunnel(socket, this.hostname, this.signal, this.ca)
    request.once('socket', connected => connected.resume())
    return secure
  }
}

export function createPinnedProxyAgent(proxy: string, url: URL, address: PublicAddress, signal: AbortSignal, ca?: string[]): HttpsProxyAgent<string> {
  let parsed: URL
  try {
    parsed = new URL(proxy)
  } catch {
    throw new Error('Direct WebFetch proxy URL is invalid. Check the HTTP_PROXY or HTTPS_PROXY setting.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Direct WebFetch supports HTTP(S) CONNECT proxies. Use an approved MCP fetch tool for other proxy protocols.')
  }
  return new PinnedProxyAgent(proxy, address, url.hostname.replace(/^\[|\]$/g, ''), signal, ca)
}
