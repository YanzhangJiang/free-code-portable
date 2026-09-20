import { z } from 'zod'
import {
  apiKeyEnvironmentSchema,
  externalEndpointSchema,
  serviceHeadersSchema,
} from './config-values.js'

// This service has its own credential reference; selecting a language model
// must never send that model's credentials to an audio service.
export const voiceConfigurationSchema = z.object({
  api: z.literal('openai-transcription'),
  baseURL: externalEndpointSchema,
  model: z.string().trim().min(1).max(256),
  apiKeyEnv: apiKeyEnvironmentSchema.optional(),
  headers: serviceHeadersSchema.optional(),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
  timeoutMs: z.number().int().min(1).max(300_000).default(60_000),
  maxRecordingSeconds: z.number().int().min(1).max(600).default(300),
}).strict()

export type VoiceConfiguration = z.infer<typeof voiceConfigurationSchema>
