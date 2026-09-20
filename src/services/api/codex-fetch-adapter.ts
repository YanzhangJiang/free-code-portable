/** Codex OAuth routing; protocol conversion is shared with Responses providers. */
import { Buffer } from 'node:buffer'
import { createOpenAIResponsesFetch } from './openai-responses-fetch.js'

export const CODEX_MODELS = [
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', description: 'Agentic coding model' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Codex coding model' },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'Codex coding model' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', description: 'Fast Codex model' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', description: 'Codex coding model' },
  { id: 'gpt-5.4', label: 'GPT-5.4', description: 'GPT model' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Fast GPT model' },
  { id: 'gpt-5.2', label: 'GPT-5.2', description: 'GPT model' },
] as const

export const DEFAULT_CODEX_MODEL = 'gpt-5.2-codex'

/** Legacy Claude aliases remain usable; explicit remote model IDs stay exact. */
export function mapClaudeModelToCodex(model: string | null): string {
  if (!model) return DEFAULT_CODEX_MODEL
  const lower = model.toLowerCase()
  if (!/^(claude|opus|sonnet|haiku)(?:-|\[|$)/.test(lower)) return model
  if (lower.includes('opus')) return 'gpt-5.1-codex-max'
  if (lower.includes('haiku')) return 'gpt-5.1-codex-mini'
  return DEFAULT_CODEX_MODEL
}

/** Recognizes the model family without using a stale allowlist to rewrite IDs. */
export function isCodexModel(model: string): boolean {
  return /^(gpt-|codex(?:-|$))/i.test(model)
}

function extractAccountId(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) throw new Error('Invalid token')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id
    if (typeof accountId !== 'string' || !accountId) throw new Error('Missing account ID')
    return accountId
  } catch {
    throw new Error('The Codex access token has no valid account ID. Sign in to Codex again.')
  }
}

/**
 * Captures the token for one client. The client factory owns credential refresh;
 * requests never read a different account/token from global authentication state.
 */
export function createCodexFetch(
  accessToken: string,
  fetchOverride?: typeof globalThis.fetch,
  providerId = 'legacy-codex',
): typeof globalThis.fetch {
  const accountId = extractAccountId(accessToken)
  const responsesFetch = createOpenAIResponsesFetch({
    baseURL: 'https://chatgpt.com/backend-api/codex',
    apiKey: accessToken,
    headers: {
      'chatgpt-account-id': accountId,
      originator: 'free-code',
      'OpenAI-Beta': 'responses=experimental',
    },
    codex: true,
    nativeIdentity: { provider: providerId, account: accountId },
    supportsReasoning: true,
    fetch: fetchOverride,
  })
  const codexFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (!new URL(request.url).pathname.endsWith('/messages')) return responsesFetch(request)
    request.signal.throwIfAborted()
    const body = await request.json() as Record<string, unknown>
    if (typeof body.model === 'string') body.model = mapClaudeModelToCodex(body.model)
    return responsesFetch(new Request(request, { body: JSON.stringify(body) }))
  }
  return codexFetch as typeof globalThis.fetch
}
