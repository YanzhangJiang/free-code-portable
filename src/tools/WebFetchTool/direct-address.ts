import { Resolver } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export type PublicAddress = { address: string; family: 4 | 6 }

// Conservatively exclude special-use space, including embedded IPv4 and
// transition mechanisms. Source: IANA IPv4/IPv6 Special-Purpose registries.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const excluded = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) excluded.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) excluded.addSubnet(address, prefix, 'ipv6')
const globalIPv6 = new BlockList()
globalIPv6.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !excluded.check(address, 'ipv4')
  if (family === 6) return globalIPv6.check(address, 'ipv6') && !excluded.check(address, 'ipv6')
  return false
}

export function parseDirectWebURL(input: string): URL {
  if (input.length > 2000) throw new Error('WebFetch URL exceeds 2000 characters.')
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('WebFetch requires an HTTP(S) URL without credentials.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (
    hostname === 'localhost' || /\.(localhost|local|internal|home|lan|test|invalid)$/.test(hostname) ||
    (!isIP(hostname) && !hostname.includes('.')) ||
    (isIP(hostname) && !isPublicAddress(hostname))
  ) throw new Error('WebFetch can only access public internet addresses.')
  // Keep the legacy tool's HTTPS upgrade, including before redirect comparison.
  if (url.protocol === 'http:') url.protocol = 'https:'
  url.hash = ''
  return url
}

/** The call owns its DNS resolver; cancellation completes both outstanding queries. */
export async function resolvePublicAddresses(hostname: string, signal: AbortSignal): Promise<PublicAddress[]> {
  signal.throwIfAborted()
  const literal = hostname.replace(/^\[|\]$/g, '')
  const family = isIP(literal)
  if (family === 4 || family === 6) {
    if (!isPublicAddress(literal)) throw new Error('WebFetch blocked a non-public IP address.')
    return [{ address: literal, family }]
  }
  const resolver = new Resolver({ timeout: 5000, tries: 2 })
  const cancel = () => resolver.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)])
    signal.throwIfAborted()
    const addresses: PublicAddress[] = []
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        for (const address of result.value) addresses.push({ address, family: index === 0 ? 4 : 6 })
      } else if (!['ENODATA', 'ENOTFOUND'].includes(result.reason?.code)) {
        throw new Error(`WebFetch could not safely resolve ${hostname}.`, { cause: result.reason })
      }
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error('WebFetch blocked a hostname resolving to a non-public or missing IP address.')
    }
    return addresses
  } finally {
    signal.removeEventListener('abort', cancel)
    resolver.cancel()
  }
}
