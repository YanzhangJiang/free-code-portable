/**
 * The operations needed by an agent, independent of any provider SDK. Request,
 * message and event representations are consumer-owned; adapters translate them.
 */
export type ProviderRequestOptions = {
  signal?: AbortSignal | null
  timeout?: number
  headers?: Record<string, string | null | undefined>
}

export type ProviderResponse<Value> = {
  data: Value
  response: Response
  requestId: string | null
}

/** The caller owns this stream and aborts it on early return or cancellation. */
export type ProviderEventStream<Event> = AsyncIterable<Event> & {
  controller: AbortController
}

export interface ProviderClient<Request, Message, Event, TokenRequest, TokenCount> {
  createMessage(request: Request, options?: ProviderRequestOptions): Promise<ProviderResponse<Message>>
  streamMessages(request: Request, options?: ProviderRequestOptions): Promise<ProviderResponse<ProviderEventStream<Event>>>
  countTokens(request: TokenRequest, options?: ProviderRequestOptions): Promise<ProviderResponse<TokenCount>>
}
