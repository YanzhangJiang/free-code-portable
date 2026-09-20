import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { ownRecordingProcess } from './recording-process.js'

function recorderFixture() {
  const signals: string[] = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill(signal: string) {
      signals.push(signal)
      child.emit('close')
      return true
    },
  })
  let chunks = 0
  let endings = 0
  const errors: Error[] = []
  const owner = ownRecordingProcess(child as unknown as ChildProcess, {
    onData: () => { chunks++ }, onEnd: () => { endings++ }, onError: error => { errors.push(error) },
  })
  return { child, owner, signals, errors, get chunks() { return chunks }, get endings() { return endings } }
}

test('recorder cancellation releases streams and never ends a successor recording', () => {
  const fixture = recorderFixture()
  fixture.child.stdout.emit('data', Buffer.alloc(2))
  expect(fixture.chunks).toBe(1)
  fixture.owner.close()
  fixture.owner.close()
  fixture.child.stdout.emit('data', Buffer.alloc(2))
  expect(fixture.chunks).toBe(1)
  expect(fixture.endings).toBe(0)
  expect(fixture.signals).toEqual(['SIGTERM'])
  expect(fixture.child.stdout.listenerCount('data')).toBe(0)
  expect(fixture.child.stderr.listenerCount('data')).toBe(0)
})

test('natural recorder completion and failed initialization report completion once', () => {
  for (const fail of [false, true]) {
    const fixture = recorderFixture()
    const failure = new Error('audio device unavailable')
    if (fail) fixture.child.emit('error', failure)
    fixture.child.emit('close')
    fixture.owner.close()
    expect(fixture.endings).toBe(1)
    expect(fixture.errors).toEqual(fail ? [failure] : [])
    expect(fixture.signals).toEqual([])
    expect(fixture.child.stdout.listenerCount('data')).toBe(0)
    expect(fixture.child.stderr.listenerCount('data')).toBe(0)
  }
})
