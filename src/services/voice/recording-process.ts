import type { ChildProcess } from 'node:child_process'

export type RecordingProcess = { close: () => void }

/** Owns one recorder process and its streams until close. Explicit close is
 * cancellation; natural completion reports onEnd once. A stubborn process is
 * killed after one second, and its close event releases the escalation timer. */
export function ownRecordingProcess(
  child: ChildProcess,
  callbacks: { onData: (chunk: Buffer) => void; onEnd: () => void; onError: (error: Error) => void },
): RecordingProcess {
  let closed = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  const onData = (chunk: Buffer) => { if (!closed) callbacks.onData(chunk) }
  const drainErrorOutput = () => {}
  const release = () => {
    child.stdout?.off('data', onData)
    child.stderr?.off('data', drainErrorOutput)
    if (escalation !== undefined) clearTimeout(escalation)
    escalation = undefined
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', drainErrorOutput)
  child.once('close', () => {
    release()
    if (closed) return
    closed = true
    callbacks.onEnd()
  })
  child.once('error', error => {
    release()
    if (closed) return
    closed = true
    callbacks.onError(error)
    callbacks.onEnd()
  })
  return {
    close() {
      if (closed) return
      closed = true
      // Retain stderr draining until close to avoid preventing process exit.
      child.stdout?.off('data', onData)
      escalation = setTimeout(() => child.kill('SIGKILL'), 1_000)
      child.kill('SIGTERM')
    },
  }
}
