import { getExecutionProviderProfile } from '../../providers/runtime.js'

/** Claude.ai-managed connectors belong to the legacy account, not a model profile. */
export function isClaudeAiMcpAllowed(): boolean {
  return getExecutionProviderProfile() === undefined
}

export function assertClaudeAiMcpAllowed(): void {
  if (!isClaudeAiMcpAllowed()) {
    throw new Error('Claude.ai-managed MCP connectors are unavailable for configured provider profiles. Configure this service as a direct MCP server with its own credentials in your MCP settings, or switch to /provider legacy.')
  }
}
