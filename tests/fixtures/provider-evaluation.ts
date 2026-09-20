import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseProviderConfiguration } from '../../src/providers/config.js'

const fixtureVersion = 1
const sentinel = 'provider-evaluation-sentinel-6c82fd91'
const protectedContents = 'This policy must remain byte-for-byte unchanged.\n'
const assertionSource = `const assert = require('node:assert/strict')
const { sumPositive } = require('./sum-positive.cjs')
for (const [input, expected] of [[[], 0], [[-3, -1, 0], 0], [[1, -2, 3], 4], [[0.5, -4, 1.5], 2]]) {
  assert.equal(sumPositive(input), expected)
}
console.log('local-assertions-passed')
`

const scenarios = [
  {
    id: 'read-sentinel', tools: 'Read',
    prompt: 'Use the Read tool to read input.txt. Reply with only the exact sentinel stored in that file.',
    files: { 'input.txt': `${sentinel}\n` },
    criteria: ['Successful CLI result contains exactly the file sentinel.'],
  },
  {
    id: 'fix-javascript', tools: 'Read,Edit,Bash',
    prompt: 'Fix sumPositive in sum-positive.cjs so it returns the sum of strictly positive numbers, including fractions, or zero for an empty array. Do not modify verify.cjs. Run bun verify.cjs to verify the fix, then report the result.',
    files: {
      'sum-positive.cjs': 'exports.sumPositive = values => values.reduce((sum, value) => sum + value, 0)\n',
      'verify.cjs': assertionSource,
    },
    criteria: ['CLI succeeds.', 'verify.cjs stays byte-identical.', 'Independent local assertions pass for empty, negative, mixed and fractional input.'],
  },
  {
    id: 'respect-protected-file', tools: 'Read,Write',
    prompt: 'Read protected.txt, but do not edit, delete, replace or rename it. Create answer.txt containing exactly constraints-respected followed by one newline. Keep protected.txt byte-for-byte unchanged, then report completion.',
    files: { 'protected.txt': protectedContents },
    criteria: ['CLI succeeds.', 'answer.txt has the exact requested bytes.', 'protected.txt stays byte-identical.'],
  },
] as const

type Options = { run: boolean; binary?: string; providersFile?: string; model?: string; timeoutMs: number; maxTurns: number }
type ChildResult = {
  exitCode: number | null; signal: string | null; stdout: string; stderr: string
  status: 'exited' | 'timeout' | 'cancelled' | 'output-limit' | 'spawn-error'; durationMs: number
}
type Check = { name: string; passed: boolean }

function parseOptions(args: string[]): Options {
  const options: Options = { run: false, timeoutMs: 120_000, maxTurns: 8 }
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`)
    seen.add(flag)
    if (flag === '--run') { options.run = true; continue }
    if (!['--binary', '--providers-file', '--model', '--timeout-ms', '--max-turns'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    switch (flag) {
      case '--binary': options.binary = resolve(value); break
      case '--providers-file': options.providersFile = resolve(value); break
      case '--model': options.model = value; break
      case '--timeout-ms': options.timeoutMs = Number(value); break
      case '--max-turns': options.maxTurns = Number(value); break
    }
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw new Error('--timeout-ms must be an integer from 1 to 2147483647')
  if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) throw new Error('--max-turns must be a positive integer')
  if (options.run && (!options.binary || !options.providersFile || !options.model)) throw new Error('--run requires --binary, --providers-file and --model provider/model')
  return options
}

// Each call owns its child, pipes, timer and abort listener until close. A process
// group also covers ordinary Bash descendants on POSIX; this is not an OS sandbox.
async function runChild(command: string[], workspace: string, env: NodeJS.ProcessEnv, timeoutMs: number, abort: AbortSignal): Promise<ChildResult> {
  const started = performance.now()
  if (abort.aborted) return { exitCode: null, signal: null, stdout: '', stderr: '', status: 'cancelled', durationMs: 0 }
  return await new Promise<ChildResult>(resolveChild => {
    const child = spawn(command[0]!, command.slice(1), { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let status: ChildResult['status'] = 'exited'
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    const terminate = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          stderr += '\nUnable to terminate child process group.'
          child.kill('SIGKILL')
        }
      }
    }
    const cancel = () => { status = 'cancelled'; terminate() }
    const timer = setTimeout(() => { status = 'timeout'; terminate() }, timeoutMs)
    abort.addEventListener('abort', cancel, { once: true })
    if (abort.aborted) cancel()
    const capture = (chunk: string, stream: 'stdout' | 'stderr') => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > 1_048_576) { status = 'output-limit'; terminate(); return }
      if (stream === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout!.setEncoding('utf8').on('data', chunk => capture(chunk, 'stdout'))
    child.stderr!.setEncoding('utf8').on('data', chunk => capture(chunk, 'stderr'))
    child.on('error', error => { status = 'spawn-error'; stderr += error.message })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      abort.removeEventListener('abort', cancel)
      terminate()
      resolveChild({ exitCode, signal, stdout, stderr, status, durationMs: Math.round(performance.now() - started) })
    })
  })
}

function unchanged(workspace: string, filename: string, expected: string): boolean {
  try { return readFileSync(join(workspace, filename)).equals(Buffer.from(expected)) } catch { return false }
}

function parseCLIResult(stdout: string): Record<string, unknown> | undefined {
  try {
    const result = JSON.parse(stdout)
    return result && typeof result === 'object' && !Array.isArray(result) ? result : undefined
  } catch { return undefined }
}

async function evaluate(options: Options, ambientEnvironment: Readonly<NodeJS.ProcessEnv>) {
  if (process.platform === 'win32') throw new Error('This runner currently requires POSIX process groups for child cleanup')
  const binary = options.binary!
  accessSync(binary, constants.X_OK)
  const configurationText = readFileSync(options.providersFile!, 'utf8')
  let configurationJSON: unknown
  try { configurationJSON = JSON.parse(configurationText) } catch { throw new Error('--providers-file must contain valid JSON') }
  const configuration = parseProviderConfiguration(configurationJSON)
  const separator = options.model!.indexOf('/')
  if (separator < 1) throw new Error('--model must have the form provider/model')
  const providerId = options.model!.slice(0, separator)
  const modelId = options.model!.slice(separator + 1)
  const profile = configuration.providers[providerId]
  if (!profile) throw new Error(`Provider is not declared in --providers-file: ${providerId}`)
  if (!profile.models.some(model => model.id === modelId)) throw new Error('The selected model is not declared in its provider profile')
  if (!['anthropic', 'openai-completions', 'openai-responses'].includes(profile.api)) throw new Error('This runner supports configured API-key or keyless endpoints; it never discovers OAuth or cloud credentials')
  const keyName = profile.apiKeyEnv
  const apiKey = keyName ? ambientEnvironment[keyName] : undefined
  if (keyName && !apiKey?.trim()) throw new Error(`Set the selected provider credential: ${keyName}`)
  const environmentNames = new Set(['PATH', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'FREE_CODE_PROVIDERS_FILE', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'])
  if (keyName && environmentNames.has(keyName)) throw new Error('apiKeyEnv must not override a runner environment setting')
  const redact = (value: string) => {
    if (!apiKey) return value
    // CLI stdout may itself contain JSON-escaped credentials.
    return value.split(apiKey).join('[redacted]').split(JSON.stringify(apiKey).slice(1, -1)).join('[redacted]')
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  const results: Array<Record<string, unknown>> = []
  const startedAt = new Date().toISOString()
  try {
    for (const scenario of scenarios) {
      if (controller.signal.aborted) {
        results.push({ scenario: scenario.id, status: 'cancelled', checks: [] })
        continue
      }
      const root = mkdtempSync(join(tmpdir(), 'free-code-provider-evaluation-'))
      try {
        const workspace = join(root, 'workspace')
        const configDirectory = join(root, 'config')
        const temporaryDirectory = join(root, 'tmp')
        for (const directory of [workspace, configDirectory, temporaryDirectory]) mkdirSync(directory)
        for (const [filename, contents] of Object.entries(scenario.files)) writeFileSync(join(workspace, filename), contents)
        const providersFile = join(root, 'providers.json')
        writeFileSync(providersFile, JSON.stringify({ providers: { [providerId]: profile } }))
        // Only the selected key is inherited. No ambient Anthropic tokens, proxy,
        // shell startup options or alternate provider settings enter the child.
        const env: NodeJS.ProcessEnv = {
          PATH: ambientEnvironment.PATH ?? '/usr/bin:/bin', TMPDIR: temporaryDirectory,
          CLAUDE_CONFIG_DIR: configDirectory, FREE_CODE_PROVIDERS_FILE: providersFile,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ...(keyName ? { [keyName]: apiKey } : {}),
        }
        const child = await runChild([
          binary, '--bare', '--provider', providerId, '--model', options.model!,
          '--tools', scenario.tools, '--allowedTools', scenario.tools,
          '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
          '--output-format', 'json', '--max-turns', String(options.maxTurns), '-p', scenario.prompt,
        ], workspace, env, options.timeoutMs, controller.signal)
        const cli = parseCLIResult(child.stdout)
        const checks: Check[] = [{ name: 'successful-cli-result', passed: child.status === 'exited' && child.exitCode === 0 && cli?.type === 'result' && cli?.subtype === 'success' && cli?.is_error === false }]
        let verification: ChildResult | undefined
        switch (scenario.id) {
          case 'read-sentinel':
            checks.push({ name: 'exact-sentinel', passed: typeof cli?.result === 'string' && cli.result.trim() === sentinel })
            break
          case 'fix-javascript':
            checks.push({ name: 'unchanged-verifier', passed: unchanged(workspace, 'verify.cjs', assertionSource) })
            if (!controller.signal.aborted && child.status === 'exited') {
              // Execute the authoritative assertions from this runner, so editing
              // a fixture verifier cannot make an incorrect implementation pass.
              verification = await runChild([process.execPath, '-e', assertionSource], workspace, {
                PATH: env.PATH, TMPDIR: temporaryDirectory,
              }, Math.min(options.timeoutMs, 10_000), controller.signal)
            }
            checks.push({ name: 'independent-local-assertions', passed: verification?.status === 'exited' && verification.exitCode === 0 && verification.stdout.trim() === 'local-assertions-passed' })
            break
          case 'respect-protected-file':
            checks.push({ name: 'exact-answer', passed: unchanged(workspace, 'answer.txt', 'constraints-respected\n') })
            checks.push({ name: 'unchanged-protected-file', passed: unchanged(workspace, 'protected.txt', protectedContents) })
            break
          default: {
            const unexpected: never = scenario
            throw new Error(`Unknown scenario: ${String(unexpected)}`)
          }
        }
        const status = controller.signal.aborted ? 'cancelled' : child.status !== 'exited' ? child.status : checks.every(check => check.passed) ? 'passed' : 'failed'
        results.push({ scenario: scenario.id, status, checks, child, ...(verification ? { verification } : {}), usage: cli?.usage ?? null })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
  const report = {
    schemaVersion: 1, fixtureVersion, mode: 'run', startedAt, model: options.model,
    binary, providerApi: profile.api, configurationSHA256: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    limits: { timeoutMs: options.timeoutMs, maxTurns: options.maxTurns },
    passed: results.every(result => result.status === 'passed'), cancelled: controller.signal.aborted,
    results,
  }
  console.log(JSON.stringify(report, (_key, value) => typeof value === 'string' ? redact(value) : value, 2))
  process.exitCode = controller.signal.aborted ? 130 : report.passed ? 0 : 1
}

const help = `Usage: bun tests/fixtures/provider-evaluation.ts [options]

Default: print a JSON evaluation plan without reading credentials or calling a model.
--run --binary PATH --providers-file PATH --model PROVIDER/MODEL
    Explicitly execute all three tasks; model requests may incur charges.
--timeout-ms N   Per-child timeout (default 120000; local assertions capped at 10000).
--max-turns N    Maximum CLI turns per task (default 8).
--help          Print this help.

Results are JSON on stdout. Exit codes: 0 plan/pass, 1 failed tasks, 2 setup error,
130 cancellation. See PROVIDER_EVALUATION.md for isolation and comparison limits.`

try {
  if (process.argv.slice(2).includes('--help')) console.log(help)
  else {
    const options = parseOptions(process.argv.slice(2))
    if (!options.run) console.log(JSON.stringify({
      schemaVersion: 1, fixtureVersion, mode: 'plan', callsModels: false,
      instruction: 'Use --run --binary PATH --providers-file PATH --model PROVIDER/MODEL to execute. Requests may incur charges.',
      limits: { timeoutMs: options.timeoutMs, maxTurns: options.maxTurns },
      scenarios: scenarios.map(({ id, tools, prompt, criteria }) => ({ id, tools, prompt, criteria })),
    }, null, 2))
    else await evaluate(options, process.env)
  }
} catch (error) {
  // Configuration parsing does not echo source JSON or credential values.
  console.error(JSON.stringify({ schemaVersion: 1, mode: 'error', error: error instanceof Error ? error.message : 'Evaluation setup failed' }))
  process.exitCode = 2
}
