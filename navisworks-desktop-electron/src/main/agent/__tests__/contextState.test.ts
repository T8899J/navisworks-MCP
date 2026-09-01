import { describe, expect, it } from 'vitest'
import { ContextState, renderReferenceSetBlock } from '../contextState'

describe('ContextState — observe + ingest + invalidate (P2 integration)', () => {
  it('mines facts and an ordered reference set from a find_items result', () => {
    const state = new ContextState()
    state.observe({ documentInstanceId: 'doc-A', bridgeSessionId: 'b1' })
    state.ingestToolResult(
      'navisworks_find_items',
      { items: [{ id: 'idA' }, { id: 'idB' }, { id: 'idC' }] },
      'call-1',
    )
    const set = state.lastRelevantReferenceSet()
    expect(set?.orderedRefs).toEqual(['idA', 'idB', 'idC'])
    // "第一个" / "第三个" resolve to the machine-tracked ids, not chat re-reading (§P2-1).
    expect(state.referenceSets.resolveOrdinal(set!, 1)).toBe('idA')
    expect(state.referenceSets.resolveOrdinal(set!, 3)).toBe('idC')
    expect(state.factsForCurrentDocument().some((fact) => fact.key === 'item:idB')).toBe(true)
  })

  it('a document switch clears the previous document facts and sets', () => {
    const state = new ContextState()
    state.observe({ documentInstanceId: 'doc-A' })
    state.ingestToolResult('navisworks_find_items', { items: [{ id: 'idA' }] }, 'call-1')
    expect(state.lastRelevantReferenceSet()).toBeDefined()
    expect(state.factsForCurrentDocument().length).toBeGreaterThan(0)

    state.observe({ documentInstanceId: 'doc-B' })
    // Same-path-close-and-reopen or a switch both produce a new id; old state is gone.
    expect(state.lastRelevantReferenceSet()).toBeUndefined()
    expect(state.factsForCurrentDocument()).toEqual([])
  })

  it('self-observes the document instance from a navisworks_status tool result', () => {
    const state = new ContextState()
    // Before any poll, the agent's own status call carries the identity.
    state.ingestToolResult(
      'navisworks_status',
      { connected: true, documentInstanceId: 'doc-from-status', bridgeSessionId: 'b9' },
      'call-0',
    )
    expect(state.documentInstanceId).toBe('doc-from-status')
    // A later result attributes to that instance without another observe.
    state.ingestToolResult('navisworks_find_items', { items: [{ id: 'x' }] }, 'call-1')
    expect(state.lastRelevantReferenceSet()?.documentInstanceId).toBe('doc-from-status')
  })

  it('is inert with no document active (never fabricates a store key)', () => {
    const state = new ContextState()
    state.ingestToolResult('navisworks_find_items', { items: [{ id: 'orphan' }] }, 'call-1')
    expect(state.factsForCurrentDocument()).toEqual([])
    expect(state.lastRelevantReferenceSet()).toBeUndefined()
  })
})

describe('ContextState.recallLatestToolResult — P3 internal recall (no LLM-visible tool)', () => {
  it('indexes persisted messages and returns the latest result for a tool, resolving refs', async () => {
    const state = new ContextState()
    state.observe({ documentInstanceId: 'doc-A' })
    state.ingestConversationMessages('sess-1', [
      { id: 'm1', createdAt: '2026-08-31T10:00:00.000Z', tools: [
        { id: 't1', name: 'navisworks_find_items', status: 'success', result: { items: [{ id: 'old' }] } },
      ] },
      { id: 'm2', createdAt: '2026-08-31T10:09:00.000Z', tools: [
        { id: 't2', name: 'navisworks_find_items', status: 'success', result: { items: [{ id: 'new' }] } },
      ] },
    ])
    const latest = await state.recallLatestToolResult('sess-1', 'navisworks_find_items')
    expect(latest).toEqual({ items: [{ id: 'new' }] })

    // A resolver that expands externalized refs is applied transparently.
    const externalized = await state.recallLatestToolResult(
      'sess-1', 'navisworks_find_items',
      async (value) => ({ ...value as object, resolved: true }),
    )
    expect(externalized).toMatchObject({ resolved: true })

    // forgetSession drops the entries.
    state.forgetSession('sess-1')
    expect(await state.recallLatestToolResult('sess-1', 'navisworks_find_items')).toBeUndefined()
  })

  it('returns undefined for an unknown tool / session', async () => {
    const state = new ContextState()
    expect(await state.recallLatestToolResult('nope', 'navisworks_status')).toBeUndefined()
  })
})

describe('renderReferenceSetBlock', () => {
  it('renders an ordered, 1-based list and truncates long sets with a total note', () => {
    const block = renderReferenceSetBlock({
      id: 'rs', documentInstanceId: 'doc', sourceToolCallId: 'c', kind: 'items',
      orderedRefs: Array.from({ length: 60 }, (_, i) => `id${i}`),
      createdAt: 0,
    })
    expect(block).toContain('1. id0')
    expect(block).toContain('50. id49')
    expect(block).not.toContain('id59')
    expect(block).toContain('共 60 项')
  })

  it('returns empty for no set', () => {
    expect(renderReferenceSetBlock(undefined)).toBe('')
    expect(renderReferenceSetBlock(null)).toBe('')
  })
})
