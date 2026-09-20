import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stub = (path: string, exports: Record<string, unknown>) => {
  mock.module(new URL(`../../src/${path}`, import.meta.url).pathname, () => exports)
}
const unexpectedAuth = () => { throw new Error('Configured voice must never read Anthropic auth') }
stub('utils/auth.ts', {
  checkAndRefreshOAuthTokenIfNeeded: unexpectedAuth,
  getClaudeAIOAuthTokens: unexpectedAuth,
  isAnthropicAuthEnabled: unexpectedAuth,
})
stub('constants/oauth.ts', { getOauthConfig: unexpectedAuth })
stub('utils/debug.ts', { logForDebugging: () => {} })
stub('utils/log.ts', { logError: () => {} })
stub('utils/http.ts', { getUserAgent: () => 'test' })
stub('utils/mtls.ts', { getWebSocketTLSOptions: () => ({}) })
stub('utils/proxy.ts', {
  getWebSocketProxyAgent: () => undefined,
  getWebSocketProxyUrl: () => undefined,
  getProxyFetchOptions: () => ({}),
})
stub('utils/slowOperations.ts', { jsonParse: JSON.parse, jsonStringify: JSON.stringify })
stub('services/analytics/growthbook.ts', { getFeatureValue_CACHED_MAY_BE_STALE: () => true })
stub('utils/envUtils.ts', { isEnvTruthy: () => false, isRunningOnHomespace: () => false })
stub('utils/platform.ts', { getPlatform: () => 'macos' })

const nativeAvailable = true
let nativeStarts = 0
let nativeStops = 0
let nativeOnData: ((chunk: Buffer) => void) | undefined
let nativeOnEnd: (() => void) | undefined
mock.module('audio-capture-napi', () => ({
  isNativeAudioAvailable: () => nativeAvailable,
  isNativeRecordingActive: () => false,
  startNativeRecording(onData: (chunk: Buffer) => void, onEnd: () => void) {
    nativeStarts++
    nativeOnData = onData
    nativeOnEnd = onEnd
    return true
  },
  stopNativeRecording() { nativeStops++ },
}))
const directory = mkdtempSync(join(tmpdir(), 'portable-voice-'))
try {
  const configPath = join(directory, 'services.json')
  writeFileSync(configPath, JSON.stringify({ voice: {
    api: 'openai-transcription', baseURL: 'http://127.0.0.1:9000/v1', model: 'whisper-local', apiKeyEnv: 'VOICE_TEST_KEY',
  } }))
  const { initializeExternalServices } = await import('../../src/services/external/runtime.js')
  initializeExternalServices({ configPath, env: { VOICE_TEST_KEY: 'voice-key' } })
  const { hasVoiceAuth } = await import('../../src/voice/voiceModeEnabled.js')
  assert.equal(hasVoiceAuth(), true)
  const { isVoiceStreamAvailable, connectVoiceStream } = await import('../../src/services/voiceStreamSTT.js')
  assert.equal(isVoiceStreamAvailable(), true)
  let uploads = 0
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    uploads++
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer voice-key')
    return Response.json({ text: 'portable' })
  }) as typeof fetch
  let transcript = ''
  let ready = false
  const connection = await connectVoiceStream({
    onReady: () => { ready = true },
    onTranscript: text => { transcript = text },
    onError: error => { throw new Error(error) },
    onClose: () => {},
  })
  assert.equal(ready, true)
  connection!.send(Buffer.alloc(2))
  await connection!.finalize()
  assert.equal(transcript, 'portable')
  assert.equal(uploads, 1)
  initializeExternalServices({ configPath, env: {} })
  await assert.rejects(connectVoiceStream({
    onReady: () => { throw new Error('missing credential must fail before recording') },
    onTranscript: () => {}, onError: () => {}, onClose: () => {},
  }), /VOICE_TEST_KEY/)
  assert.equal(uploads, 1)

  const { startRecording, stopRecording } = await import('../../src/services/voice.js')
  let chunks = 0
  let ended = 0
  const preflight = new AbortController()
  const cancelledStart = startRecording(() => { chunks++ }, () => { ended++ }, { signal: preflight.signal })
  preflight.abort()
  assert.equal(await cancelledStart, false)
  assert.equal(nativeStarts, 0)
  const active = new AbortController()
  assert.equal(await startRecording(() => { chunks++ }, () => { ended++ }, { signal: active.signal }), true)
  nativeOnData!(Buffer.alloc(2))
  assert.equal(chunks, 1)
  const priorEnd = nativeOnEnd!
  active.abort()
  nativeOnData!(Buffer.alloc(2))
  assert.equal(chunks, 1)
  assert.equal(nativeStops, 1)
  assert.equal(ended, 0)
  assert.equal(await startRecording(() => {}, () => { ended++ }), true)
  priorEnd()
  stopRecording()
  assert.equal(nativeStops, 2)
  console.log('portable voice checks passed')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
