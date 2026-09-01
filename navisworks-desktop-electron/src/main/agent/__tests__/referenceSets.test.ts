import { describe, expect, it } from 'vitest'
import { DocumentScopeRegistry } from '../documentScope'
import { VerifiedFactStore, extractVerifiedFacts } from '../facts'
import {
  ReferenceSetStore,
  extractReferenceSet,
  parseOrdinal,
} from '../referenceSets'

describe('referenceSets — ordinals resolve from the machine-side order (§P2-1)', () => {
  it('maps 第一个 / 第三个 back to the correct item ids in result order', () => {
    const store = new ReferenceSetStore()
    const set = extractReferenceSet('navisworks_find_items', {
      items: [{ id: 'idA', name: 'Pump-A' }, { id: 'idB', name: 'Pump-B' }, { id: 'idC', name: 'Pump-C' }],
    }, { documentInstanceId: 'doc-A', sourceToolCallId: 'call-1', now: () => 1 })!
    store.add(set)

    const last = store.lastRelevantSet('doc-A')!
    expect(store.resolveOrdinal(last, parseOrdinal('第一个')!)).toBe('idA')
    expect(store.resolveOrdinal(last, parseOrdinal('第三个')!)).toBe('idC')
    expect(store.resolveOrdinal(last, parseOrdinal('第2个')!)).toBe('idB')
  })

  it('never fabricates: out-of-range and unparseable ordinals yield nothing', () => {
    const set = extractReferenceSet('navisworks_get_selection', {
      items: [{ id: 'idA' }],
    }, { documentInstanceId: 'doc-A', sourceToolCallId: 'call-1' })!
    const store = new ReferenceSetStore()
    store.add(set)
    expect(store.resolveOrdinal(set, parseOrdinal('第二个')!)).toBeNull()
    expect(store.resolveOrdinal(set, 0)).toBeNull()
    expect(store.resolveOrdinal(set, -1)).toBeNull()
  })

  it('parseOrdinal reads CJK + digit forms and rejects anything else', () => {
    expect(parseOrdinal('隐藏它们')).toBeNull()
    expect(parseOrdinal('第10项')).toBe(10)
    expect(parseOrdinal('第 三 个')).toBe(3)
  })
})

describe('referenceSets + documentScope — reopen / switch invalidates (§P2-2, §P2-3)', () => {
  it('a new document instance fully isolates facts and reference sets', () => {
    const registry = new DocumentScopeRegistry()
    const facts = new VerifiedFactStore()
    const sets = new ReferenceSetStore()
    registry.onInvalidate((previous) => { facts.invalidate(previous); sets.invalidate(previous) })

    // Document A: search → set + facts.
    registry.observe({ documentInstanceId: 'doc-A', bridgeSessionId: 'b1' })
    facts.addAll('doc-A', extractVerifiedFacts('navisworks_find_items', { items: [{ id: 'a1' }] }, { documentInstanceId: 'doc-A', sourceToolCallId: 'c1' }))
    const setA = extractReferenceSet('navisworks_find_items', { items: [{ id: 'a1' }] }, { documentInstanceId: 'doc-A', sourceToolCallId: 'c1' })!
    sets.add(setA)

    // Same path reopened → the plugin minted a NEW documentInstanceId (doc-A2). Old ids
    // must not be usable for modifying calls, and old references must be gone.
    registry.observe({ documentInstanceId: 'doc-A2', bridgeSessionId: 'b1' })
    expect(registry.canUseDocumentReference('doc-A')).toBe(false)
    expect(facts.list('doc-A')).toEqual([])
    expect(sets.get('doc-A', setA.id)).toBeUndefined()
    expect(sets.lastRelevantSetId('doc-A')).toBeUndefined()
  })
})
