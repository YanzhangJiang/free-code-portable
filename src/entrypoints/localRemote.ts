import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createLocalSession } from '../services/localRemote/session.js'
import { startLocalRemoteServer } from '../services/localRemote/server.js'
import { isInBundledMode } from '../utils/bundledMode.js'

export const LOCAL_REMOTE_HELP = `Usage: free-code local-remote [--port 8080] [--cwd directory] [--token-env NAME] [-- CLI options]

Serve a persistent local CLI session at http://127.0.0.1:8080.
No Anthropic account or hosted relay is required. Open the printed URL and enter
the access token. For another machine, use an SSH tunnel to this loopback port.

The token defaults to FREE_CODE_REMOTE_TOKEN, or a random token printed once.
Keep it private: it grants access to this session and its tool permissions.
CLI options after -- configure the child (for example --provider local --model
local/qwen --providers-file /path/providers.json). Ordinary tool approvals remain
enabled and appear in the browser. Stop this server with Ctrl-C.

Authenticated API: GET /status, GET /events?after=0 (SSE), POST /prompt {prompt},
POST /cancel {}, POST /permission {requestId,allow}, DELETE /session.
Use Authorization: Bearer TOKEN and Content-Type: application/json for POST.
`

export function parseLocalRemoteArgs(args: string[]): { port: number; cwd?: string; tokenEnv: string; cliArgs: string[] } {
  let port = 8080
  let cwd: string | undefined
  let tokenEnv = 'FREE_CODE_REMOTE_TOKEN'
  let cliArgs: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') { cliArgs = args.slice(index + 1); break }
    const [name, ...suffix] = arg.split('=')
    if (!['--port', '--cwd', '--token-env'].includes(name!)) throw new Error(`Unknown local-remote option: ${name}`)
    const value = suffix.length ? suffix.join('=') : args[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`)
    if (name === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('Port must be an integer from 0 to 65535.')
      port = Number(value)
    } else if (name === '--cwd') cwd = value
    else tokenEnv = value
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('Invalid token environment variable name.')
  const reserved = new Set(['--', '-p', '--print', '--input-format', '--output-format', '--sdk-url', '--permission-prompt-tool', '--verbose', '--include-partial-messages', '--replay-user-messages'])
  for (const arg of cliArgs) {
    if (reserved.has(arg.split('=')[0]!)) throw new Error(`local-remote manages ${arg.split('=')[0]} itself.`)
  }
  return { port, cwd, tokenEnv, cliArgs }
}

export async function localRemoteMain(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(LOCAL_REMOTE_HELP); return }
  const options = parseLocalRemoteArgs(args)
  const cwd = resolve(options.cwd ?? process.cwd())
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${cwd}`)
  const configuredToken = process.env[options.tokenEnv]
  const token = configuredToken ?? randomBytes(32).toString('hex')
  const childEnv = { ...process.env }
  delete childEnv[options.tokenEnv]
  const scriptArgs = isInBundledMode() || !process.argv[1] ? [] : [process.argv[1]]
  const session = createLocalSession({
    newId: randomUUID,
    terminate: (child, signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    },
    spawn: () => spawn(process.execPath, [...scriptArgs, ...options.cliArgs, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'], {
      cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    }),
  })
  let server: Awaited<ReturnType<typeof startLocalRemoteServer>> | undefined
  try {
    server = await startLocalRemoteServer({ session, token, port: options.port })
    process.stdout.write(`Local Remote: ${server.url}\nWorkspace: ${cwd}\n`)
    process.stdout.write(configuredToken ? `Access token: read from ${options.tokenEnv}\n` : `Access token: ${token}\n`)
    process.stdout.write('Use an SSH tunnel for remote access. Press Ctrl-C to stop.\n')
    let stop: () => void = () => {}
    const stopped = new Promise<void>(resolve => { stop = resolve })
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    try { await stopped; await server.close() } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
  } finally {
    if (server) await server.close()
    else await session.close()
  }
}
