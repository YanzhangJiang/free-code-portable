import { z } from 'zod'

export type ProviderModel = {
  id: string
  name?: string
  contextWindow: number
  maxOutputTokens: number
  vision: boolean
  reasoning: boolean
  /** Explicit Messages-protocol cache markers; other APIs manage caching themselves. */
  promptCaching?: 'disabled' | 'ephemeral'
  cost?: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
  }
}

export type ProviderProfile = {
  id: string
  name?: string
  api:
    | 'anthropic'
    | 'openai-completions'
    | 'openai-responses'
    | 'codex'
    | 'bedrock'
    | 'vertex'
    | 'foundry'
  baseURL?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  models: ProviderModel[]
  defaultModel: string
  smallModel?: string
}

export type ProviderConfiguration = {
  defaultProvider?: string
  providers: Record<string, Omit<ProviderProfile, 'id'>>
}

const providerIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, 'Use 1–64 letters, digits, hyphens, or underscores, beginning with a letter or digit')
  .refine(value => value !== 'legacy', 'The provider ID "legacy" is reserved')

const modelIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\s\x00-\x1f\x7f]+$/, 'Model IDs must not contain whitespace or control characters')

const tokenCountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const priceSchema = z.number().nonnegative().finite()

const modelSchema = z.object({
  id: modelIdSchema,
  name: z.string().min(1).optional(),
  contextWindow: tokenCountSchema.default(128_000),
  maxOutputTokens: tokenCountSchema.default(8192),
  vision: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  promptCaching: z.enum(['disabled', 'ephemeral']).optional(),
  // All costs use dollars per million tokens, matching the existing cost UI.
  cost: z.object({
    input: priceSchema,
    output: priceSchema,
    cacheRead: priceSchema.optional(),
    cacheWrite: priceSchema.optional(),
  }).strict().optional(),
}).strict().refine(model => model.maxOutputTokens <= model.contextWindow, {
  message: 'maxOutputTokens must not exceed contextWindow',
  path: ['maxOutputTokens'],
})

function isAllowedBaseURL(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return false
    if (url.protocol === 'https:') return true
    const isLoopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)
    return url.protocol === 'http:' && isLoopback
  } catch {
    return false
  }
}

const headersSchema = z.record(
  z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'Use a valid HTTP header name'),
  z.string().regex(/^[^\r\n\x00]*$/, 'Header values must not contain CR, LF, or NUL'),
).superRefine((headers, context) => {
  const credentialHeaders = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie'])
  for (const name of Object.keys(headers)) {
    if (credentialHeaders.has(name.toLowerCase())) {
      context.addIssue({ code: 'custom', path: [name], message: 'Configure credentials with apiKeyEnv instead of authentication headers' })
    }
  }
})

const profileSchema = z.object({
  name: z.string().min(1).optional(),
  api: z.enum(['anthropic', 'openai-completions', 'openai-responses', 'codex', 'bedrock', 'vertex', 'foundry']),
  baseURL: z.string().refine(isAllowedBaseURL, 'Use HTTPS, or HTTP on loopback, without URL credentials, query, or fragment').optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use an environment variable name').optional(),
  headers: headersSchema.optional(),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  models: z.array(modelSchema).min(1),
  defaultModel: modelIdSchema,
  smallModel: modelIdSchema.optional(),
}).strict().superRefine((profile, context) => {
  const usesConfiguredEndpoint = profile.api === 'anthropic' || profile.api === 'openai-completions' || profile.api === 'openai-responses'
  if (usesConfiguredEndpoint && !profile.baseURL) {
    context.addIssue({ code: 'custom', path: ['baseURL'], message: 'baseURL is required for this API' })
  }
  if (!usesConfiguredEndpoint) {
    for (const field of ['baseURL', 'apiKeyEnv', 'headers'] as const) {
      if (profile[field] !== undefined) {
        context.addIssue({ code: 'custom', path: [field], message: 'This API uses existing OAuth or cloud credentials and does not accept endpoint, key, or header overrides' })
      }
    }
  }
  if (profile.maxTokensField && profile.api !== 'openai-completions') {
    context.addIssue({ code: 'custom', path: ['maxTokensField'], message: 'maxTokensField applies only to openai-completions' })
  }
  const modelIds = new Set<string>()
  for (const [index, model] of profile.models.entries()) {
    if (model.promptCaching === 'ephemeral' && !['anthropic', 'bedrock', 'vertex', 'foundry'].includes(profile.api)) {
      context.addIssue({ code: 'custom', path: ['models', index, 'promptCaching'], message: 'Explicit ephemeral cache markers require a Messages-protocol API; other APIs manage caching themselves' })
    }
    if (modelIds.has(model.id)) {
      context.addIssue({ code: 'custom', path: ['models', index, 'id'], message: 'Model IDs must be unique within a provider' })
    }
    modelIds.add(model.id)
  }
  for (const field of ['defaultModel', 'smallModel'] as const) {
    if (profile[field] !== undefined && !modelIds.has(profile[field])) {
      context.addIssue({ code: 'custom', path: [field], message: 'Select an ID declared in this provider’s models' })
    }
  }
})

const configurationSchema = z.object({
  defaultProvider: providerIdSchema.optional(),
  providers: z.record(providerIdSchema, profileSchema),
}).strict().superRefine((configuration, context) => {
  if (configuration.defaultProvider && !Object.hasOwn(configuration.providers, configuration.defaultProvider)) {
    context.addIssue({ code: 'custom', path: ['defaultProvider'], message: 'Select a provider declared in providers' })
  }
})

/** Pure validation: input is cloned and defaults are applied without reading files or environment. */
export function parseProviderConfiguration(input: unknown): ProviderConfiguration {
  const result = configurationSchema.safeParse(input)
  if (!result.success) {
    // Do not attach the raw JSON: it may contain accidentally pasted credentials.
    const issue = result.error.issues[0]
    const path = issue.path.length ? issue.path.join('.') : '(root)'
    throw new Error(`Invalid provider configuration at ${path}: ${issue.message}`)
  }
  return result.data
}
