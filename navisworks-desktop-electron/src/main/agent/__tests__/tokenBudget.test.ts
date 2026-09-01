import { describe, expect, it } from 'vitest'
import { computeContextBudget, estimateTokens } from '../tokenBudget'

describe('estimateTokens — conservative, never under-counts', () => {
  it('is zero for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('counts CJK at roughly one token per character', () => {
    // 8 CJK characters → ~8 tokens, comfortably under a naive /4 ASCII heuristic.
    expect(estimateTokens('构件名称属性查询视点选择')).toBeGreaterThanOrEqual(8)
  })

  it('counts ASCII at roughly one token per four characters', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10)
  })

  it('is monotonic in length', () => {
    expect(estimateTokens('hello world')).toBeLessThan(estimateTokens('hello world hello world'))
  })
})

describe('computeContextBudget — reserves subtracted, floored at 0', () => {
  it('subtracts output, provider and safety reserves from the window', () => {
    expect(computeContextBudget({
      effectiveContextWindow: 32768,
      outputReserve: 2048,
      providerOverhead: 512,
      safetyMargin: 1024,
    })).toBe(32768 - 2048 - 512 - 1024)
  })

  it('never goes negative', () => {
    expect(computeContextBudget({
      effectiveContextWindow: 1000,
      outputReserve: 2048,
      providerOverhead: 0,
      safetyMargin: 0,
    })).toBe(0)
  })
})
