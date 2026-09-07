import { describe, expect, it } from 'vitest'
import { eventSchemas, requestSchemas } from '../ipc/schemas'

const doneBase = {
  runId: 'r1',
  sessionId: 's1',
  turnId: 't1',
  messageId: 'm1',
  kind: 'done' as const,
  content: 'hi',
}

describe('chat.done usage field — the REAL event schema (§61)', () => {
  const doneSchema = eventSchemas['chat.done']

  it('accepts a usage object', () => {
    const parsed = doneSchema.safeParse({
      ...doneBase,
      contextTokensUsed: 1_200,
      usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 500 },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts partial usage — absent fields mean NOT REPORTED, and must survive', () => {
    const parsed = doneSchema.safeParse({ ...doneBase, usage: { inputTokens: 7 } })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.usage).toEqual({ inputTokens: 7 })
  })

  it('still accepts legacy done events WITHOUT usage (old payloads stay valid)', () => {
    const parsed = doneSchema.safeParse({ ...doneBase, contextTokensUsed: 5, cacheHitRate: 0 })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.usage).toBeUndefined()
  })

  it('rejects invented fields inside usage (strictObject — no silent drift)', () => {
    const parsed = doneSchema.safeParse({ ...doneBase, usage: { input: 5 } })
    expect(parsed.success).toBe(false)
  })

  it('rejects negative counters', () => {
    const parsed = doneSchema.safeParse({ ...doneBase, usage: { inputTokens: -1 } })
    expect(parsed.success).toBe(false)
  })
})

describe('model.info.get route (§40)', () => {
  it('exists with an empty input and the modelInfoSchema output', () => {
    const route = requestSchemas['model.info.get']
    expect(route).toBeDefined()
    expect(route.input.safeParse(undefined).success).toBe(true)
    const valid = route.output.safeParse({
      ref: { providerId: 'api:abc', modelId: 'glm-5.3-flash' },
      displayName: 'glm-5.3-flash',
      provider: { id: 'api:abc', displayName: '云端', kind: 'openai-compatible' },
      capabilities: { tools: true },
      limits: {},
      reasoning: { modes: ['low', 'medium', 'high', 'xhigh', 'max'] },
      metadataSource: 'profile',
    })
    expect(valid.success).toBe(true)
  })

  it('rejects a ModelInfo carrying an API key or other invented fields (secret boundary §45)', () => {
    const route = requestSchemas['model.info.get']
    const bad = route.output.safeParse({
      ref: { providerId: 'ollama', modelId: 'm' },
      displayName: 'm',
      provider: { id: 'ollama', displayName: 'Ollama', kind: 'ollama' },
      capabilities: {},
      limits: {},
      reasoning: { modes: [] },
      metadataSource: 'local',
      apiKey: 'sk-nope',
    })
    expect(bad.success).toBe(false)
  })
})
