import type { CodexTokens } from './codex-client.js'

/** One source owns and joins refresh work for a session's shared Codex account. */
export function createCodexTokenSource(dependencies: {
  read: () => CodexTokens | null
  write: (tokens: CodexTokens) => void
  refresh: (refreshToken: string) => Promise<CodexTokens>
  now: () => number
}): () => Promise<CodexTokens> {
  const pendingRefreshes = new Map<string, Promise<CodexTokens>>()
  return async () => {
    const tokens = dependencies.read()
    if (!tokens?.accessToken) {
      throw new Error('Codex requires OAuth login. Run /login and choose OpenAI Codex, or configure an API-key provider.')
    }
    if (tokens.expiresAt > dependencies.now() + 60_000) return tokens
    if (!tokens.refreshToken) throw new Error('The Codex login has expired. Run /login again.')
    let pendingRefresh = pendingRefreshes.get(tokens.refreshToken)
    if (!pendingRefresh) {
      pendingRefresh = dependencies.refresh(tokens.refreshToken).then(refreshed => {
        // A completed refresh must not overwrite an account changed by /login.
        if (dependencies.read()?.refreshToken === tokens.refreshToken) dependencies.write(refreshed)
        return refreshed
      }).finally(() => { pendingRefreshes.delete(tokens.refreshToken) })
      pendingRefreshes.set(tokens.refreshToken, pendingRefresh)
    }
    return pendingRefresh
  }
}
