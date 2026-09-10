import { describe, it, expect } from 'vitest'
import { normalizeSession } from '../chatTypes'
import { sessionSchema } from '../../shared/ipc'

describe('durable context usage', () => {
  const session = { id: 's', title: '标题', preview: '', updatedAt: '2026-09-09', messages: [] }
  it('retains completed usage and model identity through IPC and renderer normalization', () => {
    const contextUsage = { used: 1200, window: 1000000, source: 'model' as const, modelRef: { providerId: 'api:test', modelId: 'glm' }, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 } }
    expect(normalizeSession(sessionSchema.parse({ ...session, contextUsage })).contextUsage).toEqual(contextUsage)
  })
  it('does not invent completed-round usage for old or new sessions', () => {
    expect(normalizeSession(session).contextUsage).toBeUndefined()
    expect(normalizeSession({ ...session, contextUsage: { used: -1 } }).contextUsage).toBeUndefined()
  })
})
