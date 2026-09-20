import Anthropic from '@anthropic-ai/sdk'
import type { ResolvedProviderModel } from '../../providers/runtime.js'
import { resolveProviderCredentials } from '../../providers/runtime.js'
import { createOpenAICompatibleFetch } from './openai-compatible-fetch.js'
import { createOpenAIResponsesFetch } from './openai-responses-fetch.js'
import { createAnthropicProfileHistory } from './anthropic-profile-history.js'
import type { ProviderProfile } from '../../providers/config.js'
import { createNativeMessageSource } from '../../providers/messages.js'
import { invalidProviderRequest } from './provider-wire-errors.js'

// Runtime profiles are immutable credential snapshots. Weak keys keep history
// owned by that session/configuration even though SDK clients are recreated.
const profileHistories = new WeakMap<ProviderProfile, Map<string, ReturnType<typeof createAnthropicProfileHistory>>>()

function getProfileHistory(profile: ProviderProfile, modelId: string) {
  let models = profileHistories.get(profile)
  if (!models) {
    models = new Map()
    profileHistories.set(profile, models)
  }
  let history = models.get(modelId)
  if (!history) {
    history = createAnthropicProfileHistory(createNativeMessageSource('anthropic', {
      provider: profile.id, endpoint: profile.baseURL!.replace(/\/+$/, ''), model: modelId,
    }))
    models.set(modelId, history)
  }
  return history
}

type ProfileClientOptions = {
  maxRetries: number
  fetch?: typeof globalThis.fetch
}

/** Capture the selected model and credentials once for the lifetime of a request. */
export function createProfileClient(
  resolved: ResolvedProviderModel,
  options: ProfileClientOptions,
): Anthropic {
  const { profile, model } = resolved
  const credentials = resolveProviderCredentials(profile)
  const baseURL = profile.baseURL!
  const transportOptions = {
    baseURL,
    ...credentials,
    supportsImages: model.vision,
    supportsReasoning: model.reasoning,
    nativeIdentity: { provider: profile.id },
    fetch: options.fetch,
  }
  let transport: typeof globalThis.fetch
  switch (profile.api) {
    case 'openai-completions':
      transport = createOpenAICompatibleFetch({ ...transportOptions, maxTokensField: profile.maxTokensField })
      break
    case 'openai-responses':
      transport = createOpenAIResponsesFetch({ ...transportOptions, nativeIdentity: { provider: profile.id } })
      break
    case 'anthropic':
      transport = options.fetch ?? globalThis.fetch
      break
    default:
      throw new Error(`Provider "${profile.id}" requires its native authentication client`)
  }

  return new Anthropic({
    // Explicit values prevent the SDK from inheriting unrelated Anthropic secrets.
    apiKey: credentials.apiKey ?? 'local-no-key',
    authToken: null,
    baseURL: profile.api === 'anthropic' ? baseURL : 'https://messages.invalid',
    defaultHeaders: credentials.headers,
    maxRetries: options.maxRetries,
    fetch: bindProfileRequest(resolved, transport, Boolean(credentials.apiKey)),
  })
}

/** The internal model identity stays qualified until it crosses the API boundary. */
export function bindProfileRequest(
  { profile, model }: ResolvedProviderModel,
  transport: typeof globalThis.fetch,
  hasApiKey = true,
): typeof globalThis.fetch {
  const history = profile.api === 'anthropic' ? getProfileHistory(profile, model.id) : undefined
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.delete('authorization')
    if (!hasApiKey) headers.delete('x-api-key')
    // Configured endpoints must not inherit OAuth betas, account IDs, or client
    // attribution. The profile explicitly supplies any gateway-specific headers.
    headers.delete('anthropic-beta')
    let body = init?.body
    try {
      if (typeof body === 'string') {
        const request = JSON.parse(body)
        request.model = model.id
        delete request.metadata
        if (typeof request.max_tokens === 'number') {
          request.max_tokens = Math.min(request.max_tokens, model.maxOutputTokens)
        }
        if (!model.reasoning) delete request.thinking
        if (!model.vision && (request.messages ?? []).some((message: { content: unknown }) => containsImage(message.content))) {
          throw new Error(`Model "${model.id}" does not support images in its provider configuration`)
        }
        if (profile.api === 'anthropic') {
          delete request.context_management
          if (request.output_config) {
            // Effort is a Claude model-specific capability; keep an explicitly
            // requested structured output format instead of silently discarding it.
            delete request.output_config.effort
            if (Object.keys(request.output_config).length === 0) delete request.output_config
          }
          if (request.thinking?.type === 'enabled') {
            if (request.max_tokens <= 1024) delete request.thinking
            else request.thinking.budget_tokens = Math.min(
              Math.max(request.thinking.budget_tokens ?? 1024, 1024), request.max_tokens - 1,
            )
          }
          request.messages = history!.prepareMessages(request.messages ?? [])
          const lastAssistant = request.messages.findLast((message: { role: string }) => message.role === 'assistant')
          if (Array.isArray(lastAssistant?.content) &&
              lastAssistant.content.some((block: { type: string }) => block.type === 'tool_use') &&
              !lastAssistant.content.some((block: { type: string }) => block.type === 'thinking' || block.type === 'redacted_thinking')) {
            // A foreign tool continuation has no signature valid at this endpoint.
            // Resume it without thinking, then enable thinking on the next turn.
            delete request.thinking
          }
        }
        body = JSON.stringify(request)
      }
    } catch (error) {
      return invalidProviderRequest(error)
    }
    const response = await transport(input, { ...init, headers, body, redirect: 'error' })
    return history ? history.observeResponse(response, init?.signal) : response
  }) as typeof globalThis.fetch
}

function containsImage(content: unknown): boolean {
  return Array.isArray(content) && content.some(block =>
    block?.type === 'image' || (block?.type === 'tool_result' && containsImage(block.content)),
  )
}
