import { describe, expect, it } from 'vitest'
import {
  apiProfileProviderId,
  calculateCacheHitRate,
  formatModelRef,
  modelRefEquals,
  totalUsedTokens,
  type ModelUsage,
} from '../model'
import { nearestReasoningEffort } from '../reasoning'

describe('ModelRef identity (P5)', () => {
  it('formats for display without becoming parseable identity', () => {
    expect(formatModelRef({ providerId: 'api:abc123', modelId: 'glm-5.3-flash' }))
      .toBe('api:abc123/glm-5.3-flash')
  })

  it('two profiles with the same model name get DIFFERENT provider ids', () => {
    const a = { providerId: apiProfileProviderId('A'), modelId: 'model-x' }
    const b = { providerId: apiProfileProviderId('B'), modelId: 'model-x' }
    expect(modelRefEquals(a, b)).toBe(false)
    expect(a.providerId).toBe('api:A')
    expect(b.providerId).toBe('api:B')
  })
})

describe('totalUsedTokens (P6)', () => {
  it('sums input + output only — reasoning tokens are NOT added again', () => {
    const usage: ModelUsage = {
      inputTokens: 12_000,
      outputTokens: 1_000,
      reasoningTokens: 500,
      cacheReadTokens: 8_000,
    }
    // Most providers fold reasoning INTO output; blindly adding it double-counts.
    expect(totalUsedTokens(usage)).toBe(13_000)
  })

  it('treats absent sides as zero and undefined usage as 0 total', () => {
    expect(totalUsedTokens({ inputTokens: 100 })).toBe(100)
    expect(totalUsedTokens({ outputTokens: 40 })).toBe(40)
    expect(totalUsedTokens({})).toBe(0)
    expect(totalUsedTokens(undefined)).toBe(0)
  })
})

describe('calculateCacheHitRate — unknown ≠ 0 (P6)', () => {
  it('Case A: 8000/12000 → 0.6667', () => {
    expect(calculateCacheHitRate({ inputTokens: 12_000, cacheReadTokens: 8_000 }))
      .toBeCloseTo(0.666667, 5)
  })

  it('Case B: reported 0 cache → 0 (NOT undefined)', () => {
    expect(calculateCacheHitRate({ inputTokens: 12_000, cacheReadTokens: 0 })).toBe(0)
  })

  it('Case C: unreported cache → undefined (never 0%)', () => {
    expect(calculateCacheHitRate({ inputTokens: 12_000 })).toBeUndefined()
    expect(calculateCacheHitRate({})).toBeUndefined()
    expect(calculateCacheHitRate(undefined)).toBeUndefined()
  })

  it('guards against nonsense denominators and clamps over-reports', () => {
    expect(calculateCacheHitRate({ inputTokens: 0, cacheReadTokens: 5 })).toBeUndefined()
    expect(calculateCacheHitRate({ inputTokens: 10, cacheReadTokens: 999 })).toBe(1)
  })
})

describe('nearestReasoningEffort (P7)', () => {
  it('xhigh against the local low/max steps snaps to max (§63)', () => {
    expect(nearestReasoningEffort('xhigh', ['low', 'max'])).toBe('max')
  })

  it('medium against low/max takes the closer step (low)', () => {
    expect(nearestReasoningEffort('medium', ['low', 'max'])).toBe('low')
  })

  it('legal steps pass through unchanged', () => {
    expect(nearestReasoningEffort('high', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('high')
    expect(nearestReasoningEffort('max', ['low', 'max'])).toBe('max')
  })

  it('empty allowed set → undefined (no selector to send)', () => {
    expect(nearestReasoningEffort('high', [])).toBeUndefined()
  })
})
