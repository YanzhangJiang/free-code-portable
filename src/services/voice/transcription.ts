import type { VoiceConfiguration } from '../external/voice-config.js'
import type {
  FinalizeSource,
  VoiceStreamCallbacks,
  VoiceStreamConnection,
} from './connection.js'

const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2
const MAX_RESPONSE_BYTES = 1_048_576

/** Owns a copy of microphone PCM as a mono, 16 kHz, signed little-endian WAV. */
export function encodeRecordingWav(chunks: readonly Buffer[]): Buffer {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  if (length % BYTES_PER_SAMPLE !== 0) {
    throw new Error('Voice recording ended with an incomplete 16-bit audio sample.')
  }
  const wav = Buffer.alloc(44 + length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + length, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(SAMPLE_RATE, 24)
  wav.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28)
  wav.writeUInt16LE(BYTES_PER_SAMPLE, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(length, 40)
  let offset = 44
  for (const chunk of chunks) {
    chunk.copy(wav, offset)
    offset += chunk.length
  }
  return wav
}

async function readTranscript(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error('Voice transcription returned an empty response.')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let completed = false
  try {
    signal.throwIfAborted()
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      length += value.length
      if (length > MAX_RESPONSE_BYTES) {
        throw new Error('Voice transcription response exceeded 1 MiB.')
      }
      chunks.push(value)
    }
    completed = true
    let transcript: unknown
    try {
      transcript = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('Voice transcription returned invalid JSON.')
    }
    if (!transcript || typeof transcript !== 'object' ||
        !('text' in transcript) || typeof transcript.text !== 'string') {
      throw new Error('Voice transcription response must contain a text string.')
    }
    return transcript.text
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!completed) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

type TranscriptionOptions = {
  configuration: VoiceConfiguration
  credentials: { apiKey?: string; headers?: Record<string, string> }
  fetch: typeof fetch
  language?: string
  keyterms?: readonly string[]
  signal?: AbortSignal
}

/**
 * The caller owns this recording until close() or finalize() completes.
 * send() copies borrowed PCM; finalize() uploads once and emits one final
 * transcript. close()/signal cancellation discard audio and abort the upload.
 * Expected HTTP/protocol failures reject finalize(); recording-limit failures
 * call onError(fatal). No microphone, filesystem, or credentials are acquired here.
 */
export function createTranscriptionConnection(
  callbacks: VoiceStreamCallbacks,
  options: TranscriptionOptions,
): VoiceStreamConnection {
  const { configuration, credentials } = options
  const controller = new AbortController()
  let state: 'recording' | 'finalizing' | 'closed' = 'recording'
  const chunks: Buffer[] = []
  let byteLength = 0
  let completion: Promise<FinalizeSource> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let timeoutExpired = false
  let acceptingAudio = true
  const abortFromCaller = () => connection.close()

  function release(): void {
    state = 'closed'
    chunks.length = 0
    byteLength = 0
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = undefined
    options.signal?.removeEventListener('abort', abortFromCaller)
  }

  async function transcribe(): Promise<FinalizeSource> {
    try {
      // Flush queued native microphone callbacks just like CloseStream in the
      // legacy implementation, while retaining one owned cancellable timer.
      await new Promise<void>(resolve => {
        deadline = setTimeout(resolve, 0)
      })
      deadline = undefined
      acceptingAudio = false
      if (controller.signal.aborted) return 'transcription_cancelled'
      if (byteLength === 0) return 'transcription_complete'
      const wav = encodeRecordingWav(chunks)
      chunks.length = 0
      const form = new FormData()
      form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'recording.wav')
      form.set('model', configuration.model)
      form.set('response_format', 'json')
      const language = configuration.language ?? options.language
      if (language) form.set('language', language)
      const prompt = options.keyterms?.slice(0, 50).join(', ').slice(0, 512)
      if (prompt) form.set('prompt', prompt)
      const headers = new Headers(credentials.headers)
      // The multipart boundary belongs to fetch, even if an unrelated content
      // type was present in user headers. Never forward ambient model headers.
      headers.delete('content-type')
      if (credentials.apiKey) headers.set('authorization', `Bearer ${credentials.apiKey}`)
      deadline = setTimeout(() => {
        timeoutExpired = true
        controller.abort()
      }, configuration.timeoutMs)
      // OpenAI file transcription wire contract (also implemented by Whisper
      // servers): https://developers.openai.com/api/docs/guides/speech-to-text
      const response = await options.fetch(
        `${configuration.baseURL.replace(/\/+$/, '')}/audio/transcriptions`,
        { method: 'POST', headers, body: form, signal: controller.signal, redirect: 'error' },
      )
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Voice transcription failed (HTTP ${response.status}). Check the configured voice endpoint, model, and credential.`)
      }
      const transcript = await readTranscript(response, controller.signal)
      if (!controller.signal.aborted && transcript.trim()) callbacks.onTranscript(transcript, true)
      return 'transcription_complete'
    } catch (error) {
      if (timeoutExpired) throw new Error(`Voice transcription timed out after ${configuration.timeoutMs} ms.`)
      if (controller.signal.aborted) return 'transcription_cancelled'
      throw error
    } finally {
      const notifyClose = state !== 'closed'
      release()
      if (notifyClose) callbacks.onClose()
    }
  }

  const connection: VoiceStreamConnection = {
    send(chunk) {
      // Permit queued final chunks until the deferred upload starts.
      if (state === 'closed' || !acceptingAudio) return
      const maxBytes = configuration.maxRecordingSeconds * SAMPLE_RATE * BYTES_PER_SAMPLE
      if (byteLength + chunk.length > maxBytes) {
        connection.close()
        callbacks.onError(`Voice recording exceeded ${configuration.maxRecordingSeconds} seconds. Use shorter recordings.`, { fatal: true })
        return
      }
      chunks.push(Buffer.from(chunk))
      byteLength += chunk.length
    },
    finalize() {
      if (completion) return completion
      if (state === 'closed') return Promise.resolve('transcription_cancelled')
      state = 'finalizing'
      completion = transcribe()
      return completion
    },
    close() {
      if (state === 'closed') return
      // Do not clear the zero-delay finalize timer: its promise must settle.
      if (state === 'finalizing') {
        controller.abort()
        chunks.length = 0
        state = 'closed'
        options.signal?.removeEventListener('abort', abortFromCaller)
      } else {
        controller.abort()
        release()
      }
      callbacks.onClose()
    },
    isConnected: () => state === 'recording',
  }
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (options.signal?.aborted) connection.close()
  else callbacks.onReady(connection)
  return connection
}
