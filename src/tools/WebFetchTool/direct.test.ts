import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { request as requestHTTPS, RequestOptions } from 'node:https'
import { isPublicAddress, parseDirectWebURL, type PublicAddress } from './direct-address.js'
import { fetchDirectWebContent, formatDirectWebContent, pinnedRequestOptions, requestPublicURL, type DirectResponse } from './direct.js'
import { isPermittedRedirect } from './redirect.js'
import { createPinnedProxyAgent, pinnedProxyOptions } from './direct-proxy.js'

const publicAddress = { address: '93.184.216.34', family: 4 as const }
const response = (body = 'hello', extra: Partial<DirectResponse> = {}): DirectResponse => ({
  status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: Buffer.from(body), ...extra,
})
function fixture(responses: DirectResponse[]) {
  const requests: { url: string; address: string; signal: AbortSignal }[] = []
  const resolutions: string[] = []
  return {
    requests, resolutions,
    dependencies: {
      resolve: async (hostname: string) => { resolutions.push(hostname); return [publicAddress] },
      request: async (url: URL, address: PublicAddress, signal: AbortSignal) => {
        requests.push({ url: url.toString(), address: address.address, signal })
        const next = responses.shift()
        if (!next) throw new Error('Unexpected network request')
        return next
      },
    },
  }
}

describe('direct WebFetch address boundary', () => {
  test('blocks private, special-use, disguised and mapped IP addresses', () => {
    for (const ip of [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.168.1.1', '192.0.2.1', '192.88.99.2',
      '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
      '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
      '::ffff:8.8.8.8', '64:ff9b::a00:1', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1',
    ]) expect(isPublicAddress(ip)).toBe(false)
    for (const ip of ['8.8.8.8', '93.184.216.34', '100.128.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(ip)).toBe(true)
    }
    for (const url of [
      'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://0177.0.0.1',
      'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://localhost.', 'https://printer.local',
      'https://machine.internal', 'https://localhost', 'https://intranet', 'file:///etc/passwd',
      'ftp://example.com', 'https://user:secret@example.com',
    ]) expect(() => parseDirectWebURL(url)).toThrow()
  })

  test('upgrades HTTP and removes fragments but preserves request path/query', () => {
    expect(parseDirectWebURL('http://example.com/path?q=1#part').toString()).toBe('https://example.com/path?q=1')
    expect(() => parseDirectWebURL(`https://example.com/${'x'.repeat(2000)}`)).toThrow('2000')
  })

  test('pins both lookup callback forms and never adds authorization or cookies', () => {
    const options = pinnedRequestOptions(publicAddress, new AbortController().signal)
    const results: unknown[] = []
    options.lookup!('example.com', {}, (...args) => results.push(args))
    options.lookup!('example.com', { all: true }, (...args) => results.push(args))
    expect(results).toEqual([[null, publicAddress.address, 4], [null, [publicAddress], 4]])
    expect(options.agent).toBe(false)
    expect(options.rejectUnauthorized).toBe(true)
    expect(options.headers).not.toHaveProperty('Authorization')
    expect(options.headers).not.toHaveProperty('Cookie')
    expect(() => pinnedRequestOptions({ address: '127.0.0.1', family: 4 }, new AbortController().signal)).toThrow()
  })
})

describe('direct WebFetch native response ownership', () => {
  function nativeFixture(headers: Record<string, string>, write: (body: PassThrough) => void) {
    const body = Object.assign(new PassThrough(), { statusCode: 200, statusMessage: 'OK', headers })
    const send = ((_url: URL, _options: unknown, onResponse: (response: IncomingMessage) => void) => {
      return Object.assign(new EventEmitter(), {
        end() {
          onResponse(body as unknown as IncomingMessage)
          if (!body.destroyed) write(body)
        },
      })
    }) as unknown as typeof requestHTTPS
    return { body, send }
  }

  test('collects successful chunks and releases the completed body', async () => {
    const f = nativeFixture({ 'content-type': 'text/plain' }, body => { body.write('one'); body.end('two') })
    const result = await requestPublicURL(new URL('https://example.com'), publicAddress, new AbortController().signal, undefined, f.send)
    expect(result.body.toString()).toBe('onetwo')
    expect(result.status).toBe(200)
    expect(f.body.readableEnded).toBe(true)
  })

  test('closes bodies with excessive declared or streaming sizes', async () => {
    for (const f of [
      nativeFixture({ 'content-length': `${6 * 1024 * 1024}` }, () => { throw new Error('Should not consume oversized body') }),
      nativeFixture({}, body => body.write(Buffer.alloc(5 * 1024 * 1024 + 1))),
    ]) {
      await expect(requestPublicURL(new URL('https://example.com'), publicAddress, new AbortController().signal, undefined, f.send)).rejects.toThrow('exceeds')
      expect(f.body.destroyed).toBe(true)
    }
  })

  test('propagates an interrupted response without a partial successful result', async () => {
    const f = nativeFixture({}, body => { body.write('partial'); body.destroy(new Error('connection lost')) })
    await expect(requestPublicURL(new URL('https://example.com'), publicAddress, new AbortController().signal, undefined, f.send)).rejects.toThrow('connection lost')
    expect(f.body.destroyed).toBe(true)
  })

  test('pins CONNECT destinations while retaining original TLS identity', () => {
    const options = pinnedProxyOptions({ host: 'example.com', port: 443, secureEndpoint: true }, publicAddress, 'example.com')
    expect(options).toMatchObject({ host: publicAddress.address, port: 443, servername: 'example.com', rejectUnauthorized: true })
    expect(() => pinnedProxyOptions({ host: 'example.com', port: 443, secureEndpoint: true }, { address: '10.0.0.1', family: 4 }, 'example.com')).toThrow('non-public')
    expect(() => createPinnedProxyAgent('secret:do-not-expose@@', new URL('https://example.com'), publicAddress, new AbortController().signal)).toThrow('supports HTTP(S)')
    expect(() => createPinnedProxyAgent('not a URL with secret', new URL('https://example.com'), publicAddress, new AbortController().signal)).toThrow('proxy URL is invalid')
  })

  test('destroys each proxy agent after success or request initialization failure', async () => {
    for (const failure of [false, true]) {
      let destroyed = false
      let targetHost = ''
      const f = nativeFixture({}, body => body.end('through proxy'))
      const send = ((url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
        targetHost = url.hostname
        const agent = options.agent
        if (!agent || typeof agent !== 'object') throw new Error('Missing proxy agent')
        const destroy = agent.destroy.bind(agent)
        agent.destroy = () => { destroyed = true; destroy() }
        if (failure) throw new Error('request initialization failed')
        return f.send(url, options, onResponse)
      }) as unknown as typeof requestHTTPS
      const promise = requestPublicURL(new URL('https://example.com'), publicAddress, new AbortController().signal, undefined, send, 'http://127.0.0.1:8080')
      if (failure) await expect(promise).rejects.toThrow('request initialization failed')
      else expect((await promise).body.toString()).toBe('through proxy')
      expect(targetHost).toBe('example.com')
      expect(destroyed).toBe(true)
    }
  })
})

describe('direct WebFetch operation', () => {
  test('converts HTML locally, removes scripts/styles and bounds excerpts', async () => {
    const f = fixture([response('<h1>Title</h1><script>secret()</script><style>.hide{}</style><p>Page body.</p>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })])
    const content = await fetchDirectWebContent('https://example.com', new AbortController().signal, f.dependencies)
    expect(content).toMatchObject({ code: 200, contentType: 'text/html; charset=utf-8' })
    if ('type' in content) throw new Error('Unexpected redirect')
    expect(content.content).toContain('Title')
    expect(content.content).toContain('Page body.')
    expect(content.content).not.toContain('secret()')
    expect(content.content).not.toContain('.hide{}')
    expect(f.requests[0]?.address).toBe(publicAddress.address)
    const truncated = await fetchDirectWebContent('https://example.com', new AbortController().signal,
      fixture([response('abcdef')]).dependencies, { maxCharacters: 3 })
    expect(truncated).toMatchObject({ content: 'abc\n\n[Page content truncated at 3 characters.]' })
    expect(formatDirectWebContent('excerpt', 'https://example.com/', 'find title')).toContain('untrusted web content')
  })

  test('follows permitted redirects with a fresh DNS check per hop', async () => {
    const f = fixture([
      response('', { status: 301, headers: { location: 'https://www.example.com/path' } }),
      response('', { status: 303, headers: { location: '/next' } }),
      response('final'),
    ])
    expect(await fetchDirectWebContent('https://example.com', new AbortController().signal, f.dependencies)).toMatchObject({ content: 'final' })
    expect(f.resolutions).toEqual(['example.com', 'www.example.com', 'www.example.com'])
    expect(f.requests.map(request => request.url)).toEqual(['https://example.com/', 'https://www.example.com/path', 'https://www.example.com/next'])
  })

  test('returns cross-host and protocol redirects without contacting the new target', async () => {
    for (const location of ['https://another.example/path', 'http://example.com/path']) {
      const f = fixture([response('', { status: 302, headers: { location } })])
      const result = await fetchDirectWebContent('https://example.com', new AbortController().signal, f.dependencies)
      expect(result).toMatchObject({ type: 'redirect', statusCode: 302 })
      expect(f.requests).toHaveLength(1)
      expect(f.resolutions).toHaveLength(1)
    }
    expect(isPermittedRedirect('https://example.com/a', 'https://www.example.com/b')).toBe(true)
    expect(isPermittedRedirect('https://example.com/a', 'https://user@example.com/b')).toBe(false)
    expect(isPermittedRedirect('https://example.com/a', 'https://example.com:444/b')).toBe(false)
  })

  test('blocks private redirects, mixed DNS and rebinding before requesting', async () => {
    const privateRedirect = fixture([response('', { status: 302, headers: { location: 'https://169.254.169.254/latest' } })])
    await expect(fetchDirectWebContent('https://example.com', new AbortController().signal, privateRedirect.dependencies)).rejects.toThrow('public')
    const mixed = fixture([])
    await expect(fetchDirectWebContent('https://example.com', new AbortController().signal, {
      ...mixed.dependencies, resolve: async () => [publicAddress, { address: '10.0.0.1', family: 4 }],
    })).rejects.toThrow('non-public')
    expect(mixed.requests).toHaveLength(0)
    const rebound = fixture([response('', { status: 302, headers: { location: '/next' } })])
    let lookups = 0
    await expect(fetchDirectWebContent('https://example.com', new AbortController().signal, {
      ...rebound.dependencies, resolve: async () => ++lookups === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }],
    })).rejects.toThrow('non-public')
    expect(rebound.requests).toHaveLength(1)
  })

  test('rejects redirect loops and invalid responses', async () => {
    for (const invalid of [
      response('', { status: 404, statusText: 'Not Found' }),
      response('', { status: 302, headers: {} }),
      response('', { headers: { 'content-type': 'application/pdf' } }),
      response('', { headers: { 'content-encoding': 'gzip' } }),
      response('x'.repeat(5 * 1024 * 1024 + 1)),
    ]) await expect(fetchDirectWebContent('https://example.com', new AbortController().signal, fixture([invalid]).dependencies)).rejects.toThrow()
    const loop = fixture(Array.from({ length: 11 }, () => response('', { status: 302, headers: { location: '/' } })))
    await expect(fetchDirectWebContent('https://example.com', new AbortController().signal, loop.dependencies)).rejects.toThrow('redirects')
    expect(loop.requests).toHaveLength(11)
  })

  test('propagates early cancellation, cancellation during DNS and whole-operation timeout', async () => {
    const early = new AbortController()
    early.abort(new Error('cancelled before start'))
    const f = fixture([])
    await expect(fetchDirectWebContent('https://example.com', early.signal, f.dependencies)).rejects.toThrow('cancelled before start')
    expect(f.resolutions).toHaveLength(0)
    const controller = new AbortController()
    await expect(fetchDirectWebContent('https://example.com', controller.signal, {
      ...f.dependencies,
      resolve: async () => { controller.abort(new Error('cancelled during DNS')); return [publicAddress] },
    })).rejects.toThrow('cancelled during DNS')
    expect(f.requests).toHaveLength(0)
    let aborted = false
    await expect(fetchDirectWebContent('https://example.com', new AbortController().signal, {
      ...f.dependencies,
      request: async (_url, _address, signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true })
      }),
    }, { timeoutMs: 1 })).rejects.toThrow('timed out')
    expect(aborted).toBe(true)
  })

  test('releases timer and cancellation ownership on completion', async () => {
    const f = fixture([response()])
    const controller = new AbortController()
    await fetchDirectWebContent('https://example.com', controller.signal, f.dependencies, { timeoutMs: 1 })
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(f.requests[0]?.signal.aborted).toBe(false)
  })
})
