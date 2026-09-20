import { z } from 'zod'

// Service endpoints are user configuration, never URLs chosen by the model.
export const externalEndpointSchema = z.string().url().refine(value => {
  const url = new URL(value)
  if (url.username || url.password || value.includes('?') || value.includes('#')) return false
  return url.protocol === 'https:' || (
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
}, 'Use HTTPS, or HTTP on loopback, without credentials, query, or fragment')

export const apiKeyEnvironmentSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)

export const serviceHeadersSchema = z.record(z.string(), z.string()).superRefine((headers, context) => {
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      context.addIssue({ code: 'custom', message: 'Invalid service header' })
    }
    if (/^(authorization|proxy-authorization|x-api-key|x-subscription-token|cookie|host|content-length)$/i.test(name)) {
      context.addIssue({ code: 'custom', message: 'Authentication and transport headers cannot be configured; use apiKeyEnv' })
    }
  }
})
