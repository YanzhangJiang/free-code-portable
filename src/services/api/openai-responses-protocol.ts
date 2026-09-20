// Responses wire contract: https://developers.openai.com/api/reference/resources/responses
// Keep provider representations at this boundary; the agent continues to use Messages.
import { nativeItemMetadata, replayNativeContent, type NativeMessageSource } from '../../providers/messages.js'
import { providerStreamError } from './provider-wire-errors.js'

export type WireObject = Record<string, unknown>

export function wireObject(value: unknown, context: string): WireObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`OpenAI Responses: expected ${context} to be an object`)
  }
  return value as WireObject
}

export function wireString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`OpenAI Responses: expected ${context} to be a string`)
  }
  return value
}

function wireArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`OpenAI Responses: expected ${context} to be an array`)
  }
  return value
}

function inputContent(block: WireObject, supportsImages: boolean): WireObject {
  switch (block.type) {
    case 'text':
      return { type: 'input_text', text: wireString(block.text, 'text') }
    case 'image': {
      if (!supportsImages) throw new Error('This provider model does not support images')
      const source = wireObject(block.source, 'image source')
      if (source.type === 'url') {
        return { type: 'input_image', image_url: wireString(source.url, 'image URL'), detail: 'auto' }
      }
      if (source.type === 'base64') {
        const mediaType = wireString(source.media_type, 'image media type')
        const image = wireString(source.data, 'image data')
        return { type: 'input_image', image_url: `data:${mediaType};base64,${image}`, detail: 'auto' }
      }
      throw new Error('OpenAI Responses: unsupported image source')
    }
    default:
      throw new Error(`OpenAI Responses: unsupported input block ${String(block.type)}`)
  }
}

function translateMessages(messages: unknown, supportsImages: boolean, source?: NativeMessageSource): WireObject[] {
  const input: WireObject[] = []
  const grouped: WireObject[] = []
  for (const value of wireArray(messages, 'messages')) {
    const message = wireObject(value, 'message')
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new Error('OpenAI Responses: unsupported message role')
    }
    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : wireArray(message.content, 'message content')
    const previous = grouped.at(-1)
    if (message.role === 'assistant' && previous?.role === 'assistant') {
      (previous.content as unknown[]).push(...content)
    } else grouped.push({ role: message.role, content: [...content] })
  }
  for (const message of grouped) {
    const blocks = (message.content as unknown[]).map(value => wireObject(value, 'content block'))
    let content: WireObject[] = []
    const flush = () => {
      if (content.length > 0) {
        input.push({ role: message.role, content })
        content = []
      }
    }
    for (const entry of replayNativeContent(blocks, message.role === 'assistant' ? source : undefined)) {
      if ('nativeItem' in entry) {
        flush()
        input.push(entry.nativeItem)
        continue
      }
      const block = entry.block
      switch (block.type) {
        case 'thinking':
        case 'redacted_thinking':
          // Provider-specific signatures cannot be replayed through another API.
          break
        case 'tool_use':
          flush()
          input.push({
            type: 'function_call',
            call_id: wireString(block.id, 'tool call ID'),
            name: wireString(block.name, 'tool name'),
            arguments: JSON.stringify(block.input ?? {}),
          })
          break
        case 'tool_result': {
          flush()
          let output: string | WireObject[]
          if (typeof block.content === 'string' || block.content === undefined) {
            output = (block.is_error ? 'Tool error: ' : '') + (block.content ?? '')
          } else {
            output = wireArray(block.content, 'tool result').map(value =>
              inputContent(wireObject(value, 'tool result block'), supportsImages),
            )
            if (block.is_error) output.unshift({ type: 'input_text', text: 'Tool error:' })
          }
          input.push({
            type: 'function_call_output',
            call_id: wireString(block.tool_use_id, 'tool result call ID'),
            output,
          })
          break
        }
        default:
          if (message.role === 'assistant') {
            if (block.type !== 'text') {
              throw new Error(`OpenAI Responses: unsupported assistant block ${String(block.type)}`)
            }
            // History is an EasyInputMessage, not an output message with an API-owned ID.
            content.push({ type: 'input_text', text: wireString(block.text, 'text') })
          } else {
            content.push(inputContent(block, supportsImages))
          }
      }
    }
    flush()
  }
  return input
}

export function responsesRequest(
  request: WireObject,
  capabilities: { supportsImages?: boolean; supportsReasoning?: boolean },
  source?: NativeMessageSource,
): WireObject {
  const body: WireObject = {
    model: wireString(request.model, 'model'),
    input: translateMessages(request.messages, capabilities.supportsImages !== false, source),
    stream: request.stream === true,
    store: false,
  }
  // Include remains accepted for services implementing older Responses versions.
  // https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-across-calls
  if (source) body.include = ['reasoning.encrypted_content']
  if (request.system !== undefined) {
    body.instructions = typeof request.system === 'string'
      ? request.system
      : wireArray(request.system, 'system prompt').map(value => {
          const block = wireObject(value, 'system block')
          if (block.type !== 'text') throw new Error('OpenAI Responses: unsupported system block')
          return wireString(block.text, 'system text')
        }).join('\n\n')
  }
  if (typeof request.max_tokens === 'number') body.max_output_tokens = request.max_tokens
  if (request.tools !== undefined) {
    body.tools = wireArray(request.tools, 'tools').map(value => {
      const tool = wireObject(value, 'tool')
      if (tool.type && tool.type !== 'custom') {
        throw new Error(`OpenAI Responses: unsupported server tool ${String(tool.type)}`)
      }
      return {
        type: 'function',
        name: wireString(tool.name, 'tool name'),
        description: tool.description,
        parameters: wireObject(tool.input_schema, 'tool input schema'),
        // Anthropic tools need not have all properties required/additionalProperties false.
        strict: false,
      }
    })
  }
  if (request.tool_choice !== undefined) {
    const choice = wireObject(request.tool_choice, 'tool choice')
    switch (choice.type) {
      case 'auto': body.tool_choice = 'auto'; break
      case 'any': body.tool_choice = 'required'; break
      case 'none': body.tool_choice = 'none'; break
      case 'tool':
        body.tool_choice = { type: 'function', name: wireString(choice.name, 'chosen tool') }
        break
      default: throw new Error('OpenAI Responses: unsupported tool choice')
    }
    if (typeof choice.disable_parallel_tool_use === 'boolean') {
      body.parallel_tool_calls = !choice.disable_parallel_tool_use
    }
  }
  const outputConfig = request.output_config === undefined ? undefined : wireObject(request.output_config, 'output config')
  if (outputConfig?.format !== undefined) {
    const format = wireObject(outputConfig.format, 'output format')
    if (format.type !== 'json_schema') throw new Error('OpenAI Responses: unsupported output format')
    body.text = {
      format: {
        type: 'json_schema',
        name: 'response',
        schema: wireObject(format.schema, 'output JSON schema'),
        // Keep the supplied schema; strict mode requires a narrower schema dialect.
        strict: false,
      },
    }
  }
  const thinking = request.thinking === undefined ? undefined : wireObject(request.thinking, 'thinking')
  if (capabilities.supportsReasoning && thinking && thinking.type !== 'disabled') {
    const effort = outputConfig?.effort
    body.reasoning = {
      effort: effort === 'max' ? 'high' : effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'medium',
      summary: 'auto',
    }
  } else {
    if (typeof request.temperature === 'number') body.temperature = request.temperature
    if (typeof request.top_p === 'number') body.top_p = request.top_p
  }
  return body
}

export function responsesUsage(value: unknown): WireObject {
  const usage = value == null ? {} : wireObject(value, 'usage')
  const details = usage.input_tokens_details == null ? {} : wireObject(usage.input_tokens_details, 'input usage details')
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
  const cached = typeof details.cached_tokens === 'number' ? details.cached_tokens : 0
  const written = typeof details.cache_write_tokens === 'number' ? details.cache_write_tokens : 0
  return {
    input_tokens: Math.max(0, input - cached - written),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
  }
}

export function responsesStopReason(response: WireObject, hasTools: boolean): string {
  if (response.status === 'failed' || response.error) {
    const error = response.error == null ? {} : wireObject(response.error, 'response error')
    throw providerStreamError(error, 'OpenAI Responses')
  }
  if (response.status === 'incomplete') {
    const details = wireObject(response.incomplete_details, 'incomplete details')
    if (details.reason === 'max_output_tokens') return 'max_tokens'
    if (details.reason === 'content_filter') return 'refusal'
    throw new Error(`OpenAI Responses: response incomplete (${String(details.reason)})`)
  }
  return hasTools ? 'tool_use' : 'end_turn'
}

export function responsesItemBlocks(item: WireObject, preserveEmptyReasoning = false): WireObject[] {
  const content: WireObject[] = []
  switch (item.type) {
    case 'message':
      for (const value of wireArray(item.content, 'output content')) {
        const part = wireObject(value, 'output part')
        if (part.type === 'output_text') content.push({ type: 'text', text: wireString(part.text, 'output text') })
        else if (part.type === 'refusal') content.push({ type: 'text', text: wireString(part.refusal, 'refusal text') })
        else throw new Error(`OpenAI Responses: unsupported output part ${String(part.type)}`)
      }
      break
    case 'function_call':
      content.push({
        type: 'tool_use',
        id: wireString(item.call_id, 'tool call ID'),
        name: wireString(item.name, 'tool name'),
        input: wireObject(JSON.parse(wireString(item.arguments, 'tool arguments')), 'tool arguments'),
      })
      break
    case 'reasoning':
      for (const value of wireArray(item.summary ?? [], 'reasoning summary')) {
        const part = wireObject(value, 'reasoning summary part')
        content.push({ type: 'thinking', thinking: wireString(part.text, 'summary text'), signature: '' })
      }
      if (content.length === 0 && preserveEmptyReasoning) {
        content.push({ type: 'thinking', thinking: '', signature: '' })
      }
      break
    default:
      throw new Error(`OpenAI Responses: unsupported output item ${String(item.type)}`)
  }
  return content
}

export function responsesMessage(response: WireObject, model: string, source?: NativeMessageSource): WireObject {
  const stopReason = responsesStopReason(response, false)
  const content: WireObject[] = []
  wireArray(response.output ?? [], 'response output').forEach((value, outputIndex) => {
    const item = wireObject(value, 'output item')
    const blocks = responsesItemBlocks(item, Boolean(source))
    if (source) {
      const metadata = nativeItemMetadata(source, wireString(response.id, 'response ID'), outputIndex, item, blocks)
      blocks.forEach((block, index) => { block.providerMetadata = metadata[index] })
    }
    content.push(...blocks)
  })
  return {
    id: wireString(response.id, 'response ID'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason === 'end_turn' && content.some(block => block.type === 'tool_use') ? 'tool_use' : stopReason,
    stop_sequence: null,
    usage: responsesUsage(response.usage),
  }
}
