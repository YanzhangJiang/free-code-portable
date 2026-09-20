import { createHash } from 'node:crypto'

export type MessageRecord = Record<string, unknown>
export type NativeMessageSource = {
  api: 'openai-responses' | 'openai-completions' | 'anthropic'
  identity: string
}

const namespace = 'free-code/native'

type NativeItem = {
  version: 1
  api: NativeMessageSource['api']
  source: string
  responseId: string
  outputIndex: number
  blockIndex: number
  contentHashes: string[]
  item?: MessageRecord
}

export type ProviderMetadata = { [namespace]: NativeItem }

function record(value: unknown): MessageRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as MessageRecord : undefined
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  const object = record(value)
  return object
    ? Object.fromEntries(Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => [key, canonical(object[key])]))
    : value
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

/** Stable across resume, without storing credentials or endpoint details in history. */
export function createNativeMessageSource(
  api: NativeMessageSource['api'],
  identity: { provider: string; endpoint: string; model: string; account?: string },
): NativeMessageSource {
  return { api, identity: digest({ api, ...identity }) }
}

function contentHash(block: MessageRecord): string {
  const { providerMetadata: _metadata, cache_control: _cache, ...content } = block
  return digest(content)
}

/**
 * Metadata travels in the serialized transcript, never in portable prompt text.
 * Hashes bind the native item to its complete visible projection: compaction or
 * tool-input edits must not silently resurrect removed content on the next turn.
 */
export function nativeItemMetadata(
  source: NativeMessageSource,
  responseId: string,
  outputIndex: number,
  item: MessageRecord,
  blocks: MessageRecord[],
): ProviderMetadata[] {
  const contentHashes = blocks.map(contentHash)
  return blocks.map((_block, blockIndex) => ({
    [namespace]: {
      version: 1, api: source.api, source: source.identity,
      responseId, outputIndex, blockIndex, contentHashes,
      ...(blockIndex === 0 ? { item } : {}),
    },
  }))
}

/** Parse only our namespace; never copy arbitrary provider response properties. */
export function readProviderMetadata(value: unknown): ProviderMetadata | undefined {
  const metadata = record(value)
  const item = record(metadata?.[namespace])
  if (!item || item.version !== 1 ||
      (item.api !== 'openai-responses' && item.api !== 'openai-completions' && item.api !== 'anthropic') ||
      typeof item.source !== 'string' || !/^[a-f0-9]{64}$/.test(item.source) ||
      typeof item.responseId !== 'string' ||
      !Number.isSafeInteger(item.outputIndex) || Number(item.outputIndex) < 0 ||
      !Number.isSafeInteger(item.blockIndex) || Number(item.blockIndex) < 0 ||
      !Array.isArray(item.contentHashes) || item.contentHashes.length === 0 ||
      item.contentHashes.length > 1024 || Number(item.blockIndex) >= item.contentHashes.length ||
      !item.contentHashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) ||
      (item.item !== undefined && !record(item.item))) return undefined
  return { [namespace]: item as NativeItem }
}

/**
 * Claude's orphan/trailing-thinking rules do not apply to other protocols.
 * This only preserves transcript state; adapters still verify source and content
 * before replay, and native cloud boundaries discard all foreign private state.
 */
export function isNativeReasoningBlock(value: unknown): boolean {
  const block = record(value)
  if (block?.type !== 'thinking' && block?.type !== 'redacted_thinking') return false
  const metadata = readProviderMetadata(block.providerMetadata)?.[namespace]
  return metadata !== undefined && metadata.api !== 'anthropic'
}

export type ReplayedContent = { nativeItem: MessageRecord } | { block: MessageRecord }

/**
 * Accept only complete, unmodified item projections from this exact source.
 * Consecutive assistant fragments may arrive out of order with parallel tools;
 * response output indices restore the provider's original item ordering.
 */
export function replayNativeContent(blocks: MessageRecord[], source?: NativeMessageSource): ReplayedContent[] {
  if (!source) return blocks.map(block => ({ block }))
  const groups = new Map<string, { metadata: NativeItem; entries: { index: number; blockIndex: number }[] }>()
  blocks.forEach((block, index) => {
    const metadata = readProviderMetadata(block.providerMetadata)?.[namespace]
    if (!metadata || metadata.api !== source.api || metadata.source !== source.identity) return
    const key = JSON.stringify([metadata.responseId, metadata.outputIndex])
    let group = groups.get(key)
    if (!group) {
      group = { metadata, entries: [] }
      groups.set(key, group)
    }
    if (metadata.blockIndex === 0) group.metadata = metadata
    group.entries.push({ index, blockIndex: metadata.blockIndex })
  })
  const valid = new Map<number, { metadata: NativeItem; first: boolean }>()
  for (const { metadata, entries } of groups.values()) {
    if (!metadata.item || entries.length !== metadata.contentHashes.length) continue
    entries.sort((left, right) => left.blockIndex - right.blockIndex)
    if (!entries.every((entry, index) => entry.blockIndex === index &&
      contentHash(blocks[entry.index]!) === metadata.contentHashes[index])) continue
    for (const entry of entries) valid.set(entry.index, { metadata, first: entry.blockIndex === 0 })
  }
  const result: ReplayedContent[] = []
  let pending: NativeItem[] = []
  const flush = () => {
    // Never reorder across different responses or portable history blocks.
    while (pending.length) {
      const responseId = pending[0]!.responseId
      const boundary = pending.findIndex(item => item.responseId !== responseId)
      const batch = pending.splice(0, boundary < 0 ? pending.length : boundary)
      batch.sort((left, right) => left.outputIndex - right.outputIndex)
      result.push(...batch.map(item => ({ nativeItem: item.item! })))
    }
  }
  blocks.forEach((block, index) => {
    const native = valid.get(index)
    if (native) {
      if (native.first) pending.push(native.metadata)
    } else {
      flush()
      result.push({ block })
    }
  })
  flush()
  return result
}

/** Do not forward internal transcript metadata to a provider wire schema. */
export function withoutProviderMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProviderMetadata)
  const object = record(value)
  if (!object) return value
  const { providerMetadata: _metadata, ...result } = object
  // Tool inputs are user data: a tool may legitimately name a property
  // providerMetadata. Only message/content envelopes belong to this protocol.
  if (Array.isArray(result.content)) result.content = result.content.map(withoutProviderMetadata)
  return result
}

/**
 * Native cloud/legacy clients have no transcript adapter. Strip private state
 * before SDK serialization/signing, while preserving portable text and tools.
 */
export function preparePortableMessages<Message>(messages: readonly Message[]): Message[] {
  return messages.flatMap(value => {
    const message = record(value)
    if (!message) return [value]
    if (!Array.isArray(message.content)) return [withoutProviderMetadata(message) as Message]
    const content = message.content.filter(value => {
      const block = record(value)
      return !block || block.providerMetadata === undefined ||
        (block.type !== 'thinking' && block.type !== 'redacted_thinking')
    })
    if (message.role === 'assistant' && content.length === 0) return []
    return [withoutProviderMetadata({ ...message, content }) as Message]
  })
}
