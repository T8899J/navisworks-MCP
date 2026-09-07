import { describe, expect, it } from 'vitest'
import { eventSchemas, requestSchemas } from '../../shared/ipc/schemas'

/**
 * §16 — these assert against the REAL eventSchemas/requestSchemas objects
 * (the ones the IPC layer validates with at runtime). A type-only test would
 * not have caught the historical chat.done drift; these would.
 */
const VALID_REQUEST = {
  requestId: '11111111-2222-3333-4444-555555555555',
  runId: 'r1',
  sessionId: 's1',
  turnId: 't1',
  messageId: 'm1',
  toolCallId: 'tc1',
  source: 'tool',
  questions: [{
    question: '你希望在哪个范围查找？',
    kind: 'single',
    options: [{ label: '整个模型' }, { label: '当前选择' }],
    required: true,
  }],
  createdAt: 1_725_000_000_000,
}

describe('question.requested — the REAL event schema', () => {
  const schema = eventSchemas['question.requested']

  it('accepts a well-formed request (what ChatRunRegistry emits)', () => {
    const parsed = schema.safeParse(VALID_REQUEST)
    expect(parsed.success).toBe(true)
  })

  it('accepts a doom-loop source without turn/message ids', () => {
    const parsed = schema.safeParse({
      ...VALID_REQUEST,
      source: 'doom-loop',
      turnId: undefined,
      messageId: undefined,
      toolCallId: undefined,
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects invented fields (strictObject — no silent drift)', () => {
    expect(schema.safeParse({ ...VALID_REQUEST, resolver: 'fn' }).success).toBe(false)
  })

  it('rejects a text question carrying options (schema-level superRefine)', () => {
    const parsed = schema.safeParse({
      ...VALID_REQUEST,
      questions: [{ question: 'q', kind: 'text', options: [{ label: 'a' }, { label: 'b' }] }],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('question invoke routes — the REAL request schemas', () => {
  it('question.answer accepts positional answers', () => {
    const route = requestSchemas['question.answer']
    expect(route.input.safeParse({
      requestId: VALID_REQUEST.requestId,
      answers: [{ questionIndex: 0, values: ['当前选择'] }],
    }).success).toBe(true)
    expect(route.output.safeParse({ resolved: true }).success).toBe(true)
  })

  it('question.answer rejects a 5th question (min 1 max 4)', () => {
    const items = Array.from({ length: 5 }, (_, index) => ({ questionIndex: index, values: ['x'] }))
    expect(requestSchemas['question.answer'].input.safeParse({
      requestId: VALID_REQUEST.requestId,
      answers: items,
    }).success).toBe(false)
  })

  it('question.reject needs only the requestId', () => {
    expect(requestSchemas['question.reject'].input.safeParse({ requestId: 'x' }).success).toBe(true)
  })

  it('question.pending.list accepts empty input and returns requests', () => {
    const route = requestSchemas['question.pending.list']
    expect(route.input.safeParse({}).success).toBe(true)
    expect(route.input.safeParse({ sessionId: 's1' }).success).toBe(true)
    expect(route.output.safeParse([VALID_REQUEST]).success).toBe(true)
  })
})
