import { describe, expect, test } from 'bun:test'
import {
  calculateContextBudget,
  calculateRestorationBudget,
  getProfileDefaultOutputTokens,
} from './context-budget.js'

describe('profile context budgets', () => {
  test.each([16_384, 32_768])('small %i-token windows keep useful input and recovery room', contextWindow => {
    const budget = calculateContextBudget({ contextWindow, maxOutputTokens: 4096, adaptive: true })
    expect(budget.autoCompactThreshold).toBeGreaterThan(contextWindow / 2)
    expect(budget.summaryOutputTokens).toBe(contextWindow / 8)
    expect(budget.autoCompactThreshold).toBeLessThan(budget.effectiveContextWindow)
    expect(budget.effectiveContextWindow).toBe(contextWindow - 4096)
    expect(budget.autoCompactThreshold - budget.warningBufferTokens).toBeGreaterThan(0)
  })

  test('a model capability equal to its window does not reserve all input', () => {
    const budget = calculateContextBudget({ contextWindow: 16_384, maxOutputTokens: 16_384, adaptive: true })
    expect(budget.defaultOutputTokens).toBe(4096)
    expect(budget.summaryOutputTokens).toBe(2048)
    expect(budget.effectiveContextWindow).toBe(12_288)
    expect(budget.autoCompactThreshold).toBe(11_305)
  })

  test('an explicit output allowance reserves the tokens the API actually receives', () => {
    const budget = calculateContextBudget({ contextWindow: 16_384, maxOutputTokens: 16_384, requestedOutputTokens: 8192, adaptive: true })
    expect(budget.defaultOutputTokens).toBe(4096)
    expect(budget.effectiveContextWindow).toBe(8192)
  })

  test.each([1, 2, 3, 8, 512, 4096, 8192, 16_384, 32_768, 128_000, 200_000, 1_000_000])('boundaries remain finite for %i tokens', contextWindow => {
    const budget = calculateContextBudget({ contextWindow, maxOutputTokens: contextWindow, adaptive: true })
    for (const value of Object.values(budget)) {
      expect(Number.isSafeInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    expect(budget.autoCompactThreshold).toBeGreaterThan(0)
    expect(budget.summaryOutputTokens).toBeLessThanOrEqual(contextWindow)
    expect(budget.defaultOutputTokens).toBeLessThanOrEqual(contextWindow)
    expect(budget.autoCompactThreshold).toBeLessThanOrEqual(budget.effectiveContextWindow)
    expect(budget.warningBufferTokens).toBeLessThan(budget.autoCompactThreshold)
  })

  test('large profiles cap recovery buffers and summaries', () => {
    const budget = calculateContextBudget({ contextWindow: 1_000_000, maxOutputTokens: 64_000, adaptive: true })
    expect(budget.summaryOutputTokens).toBe(20_000)
    expect(budget.effectiveContextWindow - budget.autoCompactThreshold).toBe(13_000)
    expect(budget.warningBufferTokens).toBe(20_000)
    expect(budget.blockingBufferTokens).toBe(3000)
  })

  test('window and percentage overrides only lower valid thresholds', () => {
    const budget = calculateContextBudget({ contextWindow: 32_768, maxOutputTokens: 4096, adaptive: true, compactWindow: 8192, autoCompactPercent: 50 })
    expect(budget.defaultOutputTokens).toBe(2048)
    expect(budget.effectiveContextWindow).toBe(6144)
    expect(budget.autoCompactThreshold).toBe(3072)
    const base = { contextWindow: 16_384, maxOutputTokens: 4096, adaptive: true }
    for (const invalid of [NaN, Infinity, -1, 0]) {
      expect(calculateContextBudget({ ...base, compactWindow: invalid, autoCompactPercent: invalid })).toEqual(calculateContextBudget(base))
    }
    expect(calculateContextBudget({ ...base, autoCompactPercent: 0.00001 }).autoCompactThreshold).toBe(1)
  })

  test.each([0, -1, 1.5, NaN, Infinity])('rejects invalid token limits %s', value => {
    expect(() => calculateContextBudget({ contextWindow: value, maxOutputTokens: 4096, adaptive: true })).toThrow(RangeError)
    expect(() => getProfileDefaultOutputTokens(16_384, value)).toThrow(RangeError)
  })

  test.each([200_000, 1_000_000])('preserves legacy %i-token thresholds', contextWindow => {
    const budget = calculateContextBudget({ contextWindow, maxOutputTokens: 32_000, adaptive: false })
    expect(budget.effectiveContextWindow).toBe(contextWindow - 20_000)
    expect(budget.autoCompactThreshold).toBe(contextWindow - 33_000)
    expect(budget.warningBufferTokens).toBe(20_000)
    expect(budget.blockingBufferTokens).toBe(3000)
  })
})

describe('post-compaction restoration', () => {
  const budget = calculateContextBudget({ contextWindow: 16_384, maxOutputTokens: 4096, adaptive: true })

  test('files and skills share only the space left by required context', () => {
    const restored = calculateRestorationBudget(budget, 4000)
    expect(restored.files + restored.skills).toBe(budget.postCompactTargetTokens - 4000)
    expect(restored.perFile).toBeLessThanOrEqual(restored.files)
    expect(restored.perSkill).toBeLessThanOrEqual(restored.skills)
  })

  test('no optional I/O or text budget remains when required context fills target', () => {
    for (const occupied of [budget.postCompactTargetTokens, 100_000]) {
      expect(calculateRestorationBudget(budget, occupied)).toEqual({ files: 0, skills: 0, perFile: 0, perSkill: 0 })
    }
  })

  test('large windows retain per-file and total restoration caps', () => {
    const large = calculateContextBudget({ contextWindow: 1_000_000, maxOutputTokens: 4096, adaptive: true })
    expect(calculateRestorationBudget(large, 1000)).toEqual({ files: 50_000, skills: 25_000, perFile: 5000, perSkill: 5000 })
  })

  test('invalid occupancy fails at the boundary', () => {
    for (const occupied of [-1, NaN, Infinity]) expect(() => calculateRestorationBudget(budget, occupied)).toThrow(RangeError)
  })
})
