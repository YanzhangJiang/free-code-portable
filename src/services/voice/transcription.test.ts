import { describe, expect, test } from 'bun:test'
import { voiceConfigurationSchema } from '../external/voice-config.js'
import type { VoiceStreamCallbacks, VoiceStreamConnection } from './connection.js'
import { createTranscriptionConnection, encodeRecordingWav } from './transcription.js'

function configuration(overrides = {}) {
  return voiceConfigurationSchema.parse({
    api: 'openai-transcription', baseURL: 'http://127.0.0.1:9000/v1', model: 'whisper-local', ...overrides,
  })
}

function observer() {
  const transcripts: string[] = []
  const errors: string[] = []
  let ready: VoiceStreamConnection | undefined
  let closed = 0
  const callbacks: VoiceStreamCallbacks = {
    onTranscript(text, final) { expect(final).toBe(true); transcripts.push(text) },
    onError(error, options) { expect(options?.fatal).toBe(true); errors.push(error) },
    onReady(connection) { ready = connection },
    onClose() { closed++ },
  }
  return { callbacks, transcripts, errors, get ready() { return ready }, get closed() { return closed } }
}

function transport(send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return send as typeof fetch
}

describe('portable voice transcription', () => {
  test('uploads owned chunks in one 16 kHz PCM WAV with only voice credentials', async () => {
    const observed = observer()
    let requests = 0
    const connection = createTranscriptionConnection(observed.callbacks, {
      configuration: configuration(),
      credentials: { apiKey: 'voice-only-key', headers: { 'x-service': 'voice', 'content-type': 'wrong' } },
      language: 'zh', keyterms: ['TypeScript', 'worktree'],
      fetch: transport(async (input, init) => {
        requests++
        expect(String(input)).toBe('http://127.0.0.1:9000/v1/audio/transcriptions')
        expect(init?.method).toBe('POST')
        expect(init?.redirect).toBe('error')
        const headers = new Headers(init?.headers)
        expect(headers.get('authorization')).toBe('Bearer voice-only-key')
        expect(headers.get('x-api-key')).toBeNull()
        expect(headers.get('anthropic-beta')).toBeNull()
        expect(headers.get('content-type')).toBeNull()
        const request = new Request(String(input), init)
        expect(request.headers.get('content-type')).toContain('multipart/form-data; boundary=')
        const form = await request.formData()
        expect(form.get('model')).toBe('whisper-local')
        expect(form.get('language')).toBe('zh')
        expect(form.get('response_format')).toBe('json')
        expect(form.get('prompt')).toBe('TypeScript, worktree')
        const file = form.get('file') as File
        expect(file.name).toBe('recording.wav')
        // Bun canonicalizes the WAV media type while parsing multipart.
        expect(['audio/wav', 'audio/x-wav']).toContain(file.type)
        const wav = Buffer.from(await file.arrayBuffer())
        expect(wav.subarray(0, 4).toString()).toBe('RIFF')
        expect(wav.subarray(8, 16).toString()).toBe('WAVEfmt ')
        expect(wav.readUInt32LE(4)).toBe(42)
        expect(wav.readUInt16LE(20)).toBe(1)
        expect(wav.readUInt16LE(22)).toBe(1)
        expect(wav.readUInt32LE(24)).toBe(16000)
        expect(wav.readUInt32LE(28)).toBe(32000)
        expect(wav.readUInt16LE(34)).toBe(16)
        expect(wav.readUInt32LE(40)).toBe(6)
        expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6])
        return Response.json({ text: '修改这个文件。' })
      }),
    })
    expect(observed.ready).toBe(connection)
    const borrowed = Buffer.from([1, 2, 3])
    connection.send(borrowed)
    borrowed.fill(0)
    connection.send(Buffer.from([4]))
    const completion = connection.finalize()
    // Native microphone callbacks already queued on release are flushed once.
    connection.send(Buffer.from([5, 6]))
    expect(connection.finalize()).toBe(completion)
    expect(await completion).toBe('transcription_complete')
    expect(observed.transcripts).toEqual(['修改这个文件。'])
    expect(observed.closed).toBe(1)
    expect(connection.isConnected()).toBe(false)
    connection.close()
    connection.send(Buffer.from([7, 8]))
    expect(requests).toBe(1)
    expect(observed.closed).toBe(1)
  })

  test('supports keyless local service and configured language', async () => {
    const observed = observer()
    const connection = createTranscriptionConnection(observed.callbacks, {
      configuration: configuration({ language: 'zh' }), credentials: {}, language: 'en',
      fetch: transport(async (_input, init) => {
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        expect((init?.body as FormData).get('language')).toBe('zh')
        return Response.json({ text: '' })
      }),
    })
    connection.send(Buffer.alloc(2))
    await connection.finalize()
    expect(observed.transcripts).toEqual([])
    expect(observed.errors).toEqual([])
  })

  test('empty recording and cancellation before finalize never upload', async () => {
    for (const cancel of [false, true]) {
      const observed = observer()
      const connection = createTranscriptionConnection(observed.callbacks, {
        configuration: configuration(), credentials: {},
        fetch: transport(async () => { throw new Error('unexpected upload') }),
      })
      if (cancel) { connection.send(Buffer.alloc(2)); connection.close() }
      expect(await connection.finalize()).toBe(cancel ? 'transcription_cancelled' : 'transcription_complete')
      expect(observed.closed).toBe(1)
    }
  })

  test('aborting the deferred upload settles its completion and emits no callbacks late', async () => {
    const observed = observer()
    const controller = new AbortController()
    const connection = createTranscriptionConnection(observed.callbacks, {
      configuration: configuration(), credentials: {}, signal: controller.signal,
      fetch: transport(async () => { throw new Error('unexpected upload') }),
    })
    connection.send(Buffer.alloc(2))
    const completion = connection.finalize()
    controller.abort()
    expect(await completion).toBe('transcription_cancelled')
    expect(observed.transcripts).toEqual([])
    expect(observed.closed).toBe(1)
  })

  test('abort cancels an in-flight fetch without reporting a spurious failure', async () => {
    const observed = observer()
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    let aborted = false
    const connection = createTranscriptionConnection(observed.callbacks, {
      configuration: configuration(), credentials: {},
      fetch: transport(async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
        started()
      })),
    })
    connection.send(Buffer.alloc(2))
    const completion = connection.finalize()
    await startedPromise
    connection.close()
    expect(await completion).toBe('transcription_cancelled')
    expect(aborted).toBe(true)
    expect(observed.errors).toEqual([])
    expect(observed.closed).toBe(1)
  })

  test('cancels a response reader when caller aborts midway through JSON', async () => {
    const observed = observer()
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"text":"partial')); started() },
      cancel() { cancelled = true },
    })
    const connection = createTranscriptionConnection(observed.callbacks, {
      configuration: configuration(), credentials: {}, fetch: transport(async () => new Response(body)),
    })
    connection.send(Buffer.alloc(2))
    const completion = connection.finalize()
    await startedPromise
    await Bun.sleep(10)
    connection.close()
    expect(await completion).toBe('transcription_cancelled')
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
    expect(observed.transcripts).toEqual([])
  })

  test.each([
    [401, '{"error":{"message":"denied"}}', 'HTTP 401'],
    [500, 'upstream down', 'HTTP 500'],
    [200, 'not json', 'invalid JSON'],
    [200, '{"text":42}', 'text string'],
  ])('surfaces status/protocol failure %d', async (status, body, message) => {
    const observed = observer()
    const connection = createTranscriptionConnection(observed.callbacks, {
      configuration: configuration(), credentials: {}, fetch: transport(async () => new Response(body, { status })),
    })
    connection.send(Buffer.alloc(2))
    await expect(connection.finalize()).rejects.toThrow(message)
    expect(observed.transcripts).toEqual([])
    expect(observed.closed).toBe(1)
  })

  test('bounded deadline aborts and reports timeout', async () => {
    const observed = observer()
    const connection = createTranscriptionConnection(observed.callbacks, {
      configuration: configuration({ timeoutMs: 5 }), credentials: {},
      fetch: transport(async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })),
    })
    connection.send(Buffer.alloc(2))
    await expect(connection.finalize()).rejects.toThrow('timed out after 5 ms')
    expect(observed.closed).toBe(1)
  })

  test('rejects oversized responses and releases their reader', async () => {
    const observed = observer()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1_048_577)) },
      cancel() { cancelled = true },
    })
    const connection = createTranscriptionConnection(observed.callbacks, {
      configuration: configuration(), credentials: {}, fetch: transport(async () => new Response(body)),
    })
    connection.send(Buffer.alloc(2))
    await expect(connection.finalize()).rejects.toThrow('exceeded 1 MiB')
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
    expect(observed.transcripts).toEqual([])
    expect(observed.closed).toBe(1)
  })

  test('transport errors and incomplete audio complete without a transcript', async () => {
    for (const incomplete of [false, true]) {
      const observed = observer()
      const connection = createTranscriptionConnection(observed.callbacks, {
        configuration: configuration(), credentials: {},
        fetch: transport(async () => { throw new Error('service unreachable') }),
      })
      connection.send(Buffer.alloc(incomplete ? 1 : 2))
      await expect(connection.finalize()).rejects.toThrow(incomplete ? 'incomplete 16-bit' : 'service unreachable')
      expect(observed.transcripts).toEqual([])
      expect(observed.closed).toBe(1)
    }
  })

  test('bounds recording memory and rejects partial audio samples', async () => {
    const observed = observer()
    const connection = createTranscriptionConnection(observed.callbacks, {
      configuration: configuration({ maxRecordingSeconds: 1 }), credentials: {},
      fetch: transport(async () => { throw new Error('unexpected upload') }),
    })
    connection.send(Buffer.alloc(32_000))
    expect(observed.errors).toEqual([])
    connection.send(Buffer.alloc(2))
    expect(observed.errors[0]).toContain('exceeded 1 seconds')
    expect(await connection.finalize()).toBe('transcription_cancelled')
    expect(() => encodeRecordingWav([Buffer.alloc(1)])).toThrow('incomplete 16-bit')
  })

  test('already-aborted owner never becomes ready', async () => {
    const observed = observer()
    const connection = createTranscriptionConnection(observed.callbacks, {
      configuration: configuration(), credentials: {}, signal: AbortSignal.abort(),
      fetch: transport(async () => { throw new Error('unexpected upload') }),
    })
    expect(observed.ready).toBeUndefined()
    expect(await connection.finalize()).toBe('transcription_cancelled')
    expect(observed.closed).toBe(1)
  })
})
