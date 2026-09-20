import { z } from 'zod'
import { apiKeyEnvironmentSchema, externalEndpointSchema } from './config-values.js'
import { voiceConfigurationSchema } from './voice-config.js'

export const webSearchConfigurationSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('brave'),
    baseURL: externalEndpointSchema.default('https://api.search.brave.com'),
    apiKeyEnv: apiKeyEnvironmentSchema.default('BRAVE_SEARCH_API_KEY'),
    timeoutMs: z.number().int().min(1).max(120_000).default(20_000),
    maxResults: z.number().int().min(1).max(20).default(10),
  }).strict(),
  z.object({
    provider: z.literal('searxng'),
    baseURL: externalEndpointSchema,
    timeoutMs: z.number().int().min(1).max(120_000).default(20_000),
    maxResults: z.number().int().min(1).max(20).default(10),
  }).strict(),
])

const externalServicesConfigurationSchema = z.object({
  webSearch: webSearchConfigurationSchema.optional(),
  webFetch: z.object({ mode: z.enum(['direct', 'legacy']) }).strict().optional(),
  voice: voiceConfigurationSchema.optional(),
}).strict()

export type WebSearchConfiguration = z.infer<typeof webSearchConfigurationSchema>
export type ExternalServicesConfiguration = z.infer<typeof externalServicesConfigurationSchema>

export function parseExternalServicesConfiguration(input: unknown): ExternalServicesConfiguration {
  const result = externalServicesConfigurationSchema.safeParse(input)
  if (!result.success) {
    // Do not echo external configuration values: users sometimes paste keys in it.
    const locations = result.error.issues.map(issue => issue.path.join('.') || 'root')
    throw new Error(`Invalid external services configuration at: ${[...new Set(locations)].join(', ')}. Check services.json field names and values.`)
  }
  return result.data
}
