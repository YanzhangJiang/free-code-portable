import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseExternalServicesConfiguration, type ExternalServicesConfiguration } from './config.js'

type CredentialReference = { apiKeyEnv?: string; headers?: Record<string, string> }
type ExternalServices = {
  readonly configPath: string
  readonly configurationLoaded: boolean
  readonly configuration: ExternalServicesConfiguration
}

let runtime: ExternalServices = Object.freeze({ configPath: '', configurationLoaded: false, configuration: Object.freeze({}) })
const credentials = new WeakMap<object, Readonly<{ apiKey?: string; headers?: Record<string, string> }>>()

/** CLI composition root only. Parsing completes before replacing the session snapshot. */
export function initializeExternalServices(options: { configPath?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const env = options.env ?? process.env
  const explicitPath = options.configPath ?? env.FREE_CODE_SERVICES_FILE
  const configPath = resolve(explicitPath ?? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'services.json'))
  let source: string | undefined
  try {
    source = readFileSync(configPath, 'utf8')
  } catch (error) {
    if (explicitPath !== undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Cannot read external services configuration ${configPath}.`)
    }
  }
  let input: unknown = {}
  if (source !== undefined) {
    try { input = JSON.parse(source) } catch {
      throw new Error(`External services configuration ${configPath} must contain valid JSON.`)
    }
  }
  const configuration = parseExternalServicesConfiguration(input)
  for (const service of Object.values(configuration)) {
    const reference = service as CredentialReference
    const apiKey = reference.apiKeyEnv ? env[reference.apiKeyEnv] : undefined
    const headers = reference.headers ? Object.freeze({ ...reference.headers }) : undefined
    if (reference.headers) Object.freeze(reference.headers)
    credentials.set(service, Object.freeze({ apiKey, headers }))
    Object.freeze(service)
  }
  runtime = Object.freeze({ configPath, configurationLoaded: source !== undefined, configuration: Object.freeze(configuration) })
}

/** Read-only retained snapshot. These getters never access disk or environment. */
export function getExternalServices(): ExternalServices { return runtime }
export function getExternalServicesConfig(): ExternalServicesConfiguration { return runtime.configuration }

/** Credentials remain bound to their original immutable service configuration. */
export function resolveExternalServiceCredentials(service: CredentialReference): { apiKey?: string; headers?: Record<string, string> } {
  const retained = credentials.get(service)
  if (!retained) throw new Error('External service configuration is not owned by an initialized session.')
  if (service.apiKeyEnv && !retained.apiKey?.trim()) {
    throw new Error(`External service requires environment variable ${service.apiKeyEnv}. Set it before starting Free Code.`)
  }
  return { apiKey: retained.apiKey, headers: retained.headers ? { ...retained.headers } : undefined }
}
