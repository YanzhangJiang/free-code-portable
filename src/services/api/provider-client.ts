import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  MessageCreateParams as BetaMessageCreateParams,
  MessageCountTokensParams as BetaMessageCountTokensParams,
  BetaMessageTokensCount,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ProviderClient } from '../../providers/client.js'
import { preparePortableMessages } from '../../providers/messages.js'

/** Compatibility vocabulary stays at the adapter boundary during migration. */
export type AgentProviderClient = ProviderClient<
  BetaMessageCreateParams,
  BetaMessage,
  BetaRawMessageStreamEvent,
  BetaMessageCountTokensParams,
  BetaMessageTokensCount
>

/**
 * No SDK object escapes this adapter. SDK retries/error causes are preserved;
 * caller cancellation reaches the transport and owns the returned event stream.
 */
export function adaptMessagesClient(
  client: Anthropic,
  options: { preserveNativeHistory?: boolean } = {},
): AgentProviderClient {
  const messages = <Message,>(history: Message[]): Message[] => options.preserveNativeHistory
    ? history : preparePortableMessages(history)
  return {
    async createMessage(request, options) {
      const { data, response, request_id } = await client.beta.messages.create(
        { ...request, messages: messages(request.messages), stream: false }, options,
      ).withResponse()
      return { data, response, requestId: request_id ?? null }
    },
    async streamMessages(request, options) {
      const { data, response, request_id } = await client.beta.messages.create(
        { ...request, messages: messages(request.messages), stream: true }, options,
      ).withResponse()
      return { data, response, requestId: request_id ?? null }
    },
    async countTokens(request, options) {
      const { data, response, request_id } = await client.beta.messages.countTokens(
        { ...request, messages: messages(request.messages) }, options,
      ).withResponse()
      return { data, response, requestId: request_id ?? null }
    },
  }
}
