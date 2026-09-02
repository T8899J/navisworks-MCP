import { describe, expect, it } from 'vitest'
import {
  REASONING_EFFORTS,
  REASONING_EFFORT_LABEL,
  localDisplayEffort,
  localThinkForEffort,
  normalizeReasoningEffort,
} from '../reasoning'

describe('reasoning effort mapping', () => {
  it('normalizes unknown and legacy two-step values onto the five-step scale', () => {
    expect(normalizeReasoningEffort('fast')).toBe('low')
    expect(normalizeReasoningEffort('deep')).toBe('max')
    expect(normalizeReasoningEffort(undefined)).toBe('low')
    expect(normalizeReasoningEffort(null)).toBe('low')
    expect(normalizeReasoningEffort('nonsense')).toBe('low')
    for (const effort of REASONING_EFFORTS) {
      expect(normalizeReasoningEffort(effort)).toBe(effort)
    }
  })

  it('maps effort steps onto the local think flag', () => {
    expect(localThinkForEffort('low')).toBe(false)
    expect(localThinkForEffort('medium')).toBe(false)
    expect(localThinkForEffort('high')).toBe(true)
    expect(localThinkForEffort('xhigh')).toBe(true)
    expect(localThinkForEffort('max')).toBe(true)
  })

  it('collapses middle steps onto the two local extremes for display', () => {
    expect(localDisplayEffort('low')).toBe('low')
    expect(localDisplayEffort('medium')).toBe('low')
    expect(localDisplayEffort('high')).toBe('max')
    expect(localDisplayEffort('xhigh')).toBe('max')
    expect(localDisplayEffort('max')).toBe('max')
  })

  it('labels every step', () => {
    expect(Object.keys(REASONING_EFFORT_LABEL)).toEqual([...REASONING_EFFORTS])
  })
})
