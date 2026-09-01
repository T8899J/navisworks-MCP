import { describe, expect, it } from 'vitest'
import { VerifiedFactStore, extractVerifiedFacts } from '../facts'

const ctx = (documentInstanceId = 'doc-A', sourceToolCallId = 'call-1') => ({
  documentInstanceId,
  sourceToolCallId,
  now: () => 1000,
})

describe('extractVerifiedFacts — deterministic, tool-only (Invariants A/C)', () => {
  it('lifts item refs + a count from a find_items result', () => {
    const facts = extractVerifiedFacts('navisworks_find_items', {
      items: [{ id: 'i-1', name: 'Pump-A' }, { id: 'i-2', name: 'Pump-B' }],
      total: 2,
    }, ctx())
    const itemFacts = facts.filter((fact) => fact.type === 'item')
    expect(itemFacts.map((fact) => fact.key)).toEqual(['item:i-1', 'item:i-2'])
    const countFact = facts.find((fact) => fact.type === 'count')
    expect(countFact?.value).toBe(2)
    // Every fact is traceable to a real tool call and the current document instance.
    for (const fact of facts) {
      expect(fact.sourceToolCallId).toBe('call-1')
      expect(fact.documentInstanceId).toBe('doc-A')
      expect(fact.observedAt).toBe(1000)
    }
  })

  it('marks current selection as volatile (§P2-4)', () => {
    const [selection] = extractVerifiedFacts('navisworks_get_selection', {
      items: [{ id: 'i-1' }],
    }, ctx())
    expect(selection?.type).toBe('selection')
    expect(selection?.volatility).toBe('volatile')
  })

  it('returns nothing for unknown tools (§P2-5: no fact from non-tool input)', () => {
    expect(extractVerifiedFacts('agent_made_up_tool', { items: [] }, ctx())).toEqual([])
  })

  it('cannot extract facts from free summary text — a summary is not a tool result', () => {
    // The agent might try to "remember" facts from an LLM summary; feeding that string to
    // the extractor yields nothing, so a summary can never become a VerifiedFact.
    expect(extractVerifiedFacts('navisworks_find_items', '以下是本任务早期过程的压缩摘要', ctx())).toEqual([])
    expect(extractVerifiedFacts('navisworks_find_items', null, ctx())).toEqual([])
  })
})

describe('VerifiedFactStore — document isolation + invalidation', () => {
  it('drops only the stale document facts when the instance changes', () => {
    const store = new VerifiedFactStore()
    store.addAll('doc-A', extractVerifiedFacts('navisworks_find_items', { items: [{ id: 'a1' }] }, ctx('doc-A')))
    store.addAll('doc-B', extractVerifiedFacts('navisworks_find_items', { items: [{ id: 'b1' }] }, ctx('doc-B')))
    expect(store.list('doc-A')).toHaveLength(1)
    expect(store.list('doc-B')).toHaveLength(1)

    store.invalidate({ documentInstanceId: 'doc-A' })
    expect(store.list('doc-A')).toEqual([])
    expect(store.list('doc-B')).toHaveLength(1) // other document survives
  })
})
