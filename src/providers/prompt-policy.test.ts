import { describe, expect, test } from 'bun:test'
import { createProviderPromptPolicy } from './prompt-policy.js'
import type { ProviderModel } from './config.js'

const textModel: ProviderModel = {
  id: 'claude-opus-4-6',
  contextWindow: 16_384,
  maxOutputTokens: 2048,
  vision: false,
  reasoning: false,
}

describe('provider prompt policy', () => {
  test('does not infer identity or services from a Claude-like remote ID', () => {
    const policy = createProviderPromptPolicy('local/claude-opus-4-6', textModel, new Set(['Read', 'Bash']))
    const text = Object.values(policy).join('\n')
    expect(policy.identity).toContain('independent agent harness')
    expect(policy.modelDescription).toContain('local/claude-opus-4-6')
    expect(policy.modelDescription).toContain('16384 tokens')
    expect(text).not.toContain("Anthropic's official")
    expect(text).not.toContain('latest and most capable Claude')
    expect(text).not.toContain('/fast')
    expect(text).not.toContain('unlimited context')
    expect(text).not.toContain('WebSearch')
    expect(text).not.toContain('WebFetch')
    expect(text).toContain('configured for text input')
    expect(text).toContain('read bounded file regions')
  })

  test('describes only supplied tools and their real editing contract', () => {
    const policy = createProviderPromptPolicy('service/model', textModel, new Set(['Edit', 'WebSearch', 'Agent']))
    expect(policy.toolInstructions).toContain('exact text replacement')
    expect(policy.toolInstructions).toContain('old_string')
    expect(policy.toolInstructions).toContain('Use WebSearch')
    expect(policy.toolInstructions).toContain('through Agent')
    expect(policy.toolInstructions).not.toContain('Use Read')
    expect(policy.toolInstructions).not.toContain('Use Bash')
    expect(policy.toolInstructions).not.toContain('Use Write')
    expect(policy.toolInstructions).not.toContain('Use Skill')
  })

  test('image capability and context guidance use configuration, not model family', () => {
    const model = { ...textModel, vision: true, contextWindow: 128_000 }
    const policy = createProviderPromptPolicy('service/same-model', model, new Set(['Read', 'Write', 'Skill', 'WebFetch', 'Glob']))
    expect(policy.toolInstructions).toContain('configured to accept images')
    expect(policy.toolInstructions).not.toContain('configured for text input')
    expect(policy.toolInstructions).not.toContain('read bounded file regions')
    expect(policy.toolInstructions).toContain('Use WebFetch')
    expect(policy.toolInstructions).toContain('Use Skill')
    expect(policy.toolInstructions).toContain('Use Write')
    expect(policy.toolInstructions).toContain('file search tools')
  })

  test('empty tool sets do not promise filesystem, search, or shell access', () => {
    const policy = createProviderPromptPolicy('service/model', textModel, new Set())
    for (const tool of ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent', 'Skill']) {
      expect(policy.toolInstructions).not.toContain(`Use ${tool}`)
    }
  })

  test('the small-window boundary is inclusive and names cannot add prompt lines', () => {
    const atBoundary = createProviderPromptPolicy('service/model', { ...textModel, contextWindow: 32_768, name: 'name\nnew line' }, new Set())
    const aboveBoundary = createProviderPromptPolicy('service/model', { ...textModel, contextWindow: 32_769 }, new Set())
    expect(atBoundary.toolInstructions).toContain('read bounded file regions')
    expect(aboveBoundary.toolInstructions).not.toContain('read bounded file regions')
    expect(atBoundary.modelDescription).toContain('name\\nnew line')
    expect(atBoundary.modelDescription.split('\n')).toHaveLength(1)
  })
})
