import { describe, expect, it } from 'vitest'
import { ToolResultIndex } from '../toolResultIndex'

const sessionMessages = [
  { id: 'm1', createdAt: '2026-08-31T10:00:00.000Z', tools: [
    { id: 't1', name: 'navisworks_find_items', status: 'success', result: { items: [{ id: 'a' }] } },
  ] },
  { id: 'm2', createdAt: '2026-08-31T10:05:00.000Z', tools: [
    { id: 't2', name: 'navisworks_get_selection', status: 'success', result: { items: [{ id: 'z' }] } },
    { id: 't3', name: 'navisworks_find_items', status: 'success', result: { items: [{ id: 'b' }] } },
  ] },
]

describe('ToolResultIndex — reuse persisted sessions, no second store', () => {
  it('indexes by tool-call id and resolves the latest by tool name', () => {
    const index = new ToolResultIndex()
    index.replaceSession('s1', sessionMessages)
    expect(index.get('s1', 't1')?.toolName).toBe('navisworks_find_items')
    expect(index.get('s1', 't1')?.result).toEqual({ items: [{ id: 'a' }] })
    // latest find_items is t3 (newer createdAt).
    expect(index.getLatestByTool('s1', 'navisworks_find_items')?.toolCallId).toBe('t3')
  })

  it('getReferenceSetSource returns the raw payload a reference set was built from', () => {
    const index = new ToolResultIndex()
    index.replaceSession('s1', sessionMessages)
    expect(index.getReferenceSetSource('s1', 't2')).toEqual({ items: [{ id: 'z' }] })
  })

  it('isolates sessions and drops them on delete', () => {
    const index = new ToolResultIndex()
    index.replaceSession('s1', sessionMessages)
    index.replaceSession('s2', [{ id: 'm9', createdAt: '2026-08-31T11:00:00.000Z', tools: [
      { id: 't9', name: 'navisworks_find_items', result: { items: [] } },
    ] }])
    expect(index.getBySession('s2')).toHaveLength(1)
    index.deleteSession('s2')
    expect(index.getBySession('s2')).toEqual([])
    expect(index.get('s2', 't9')).toBeUndefined()
    // s1 untouched
    expect(index.get('s1', 't1')).toBeDefined()
  })

  it('returns the LAST persisted entry when timestamps tie (real store stamps all msgs equally)', () => {
    const sameTime = '2026-08-31T10:00:00.000Z'
    const index = new ToolResultIndex()
    index.replaceSession('s1', [
      { id: 'm1', createdAt: sameTime, tools: [{ id: 'first', name: 'navisworks_find_items', result: 1 }] },
      { id: 'm2', createdAt: sameTime, tools: [{ id: 'last', name: 'navisworks_find_items', result: 2 }] },
    ])
    // A naive Date.parse comparison would tie and wrongly keep 'first'.
    expect(index.getLatestByTool('s1', 'navisworks_find_items')?.toolCallId).toBe('last')
  })

  it('replaceSession is idempotent (no duplicate entries on re-ingest)', () => {
    const index = new ToolResultIndex()
    index.replaceSession('s1', sessionMessages)
    const firstSize = index.size
    index.replaceSession('s1', sessionMessages)
    expect(index.size).toBe(firstSize)
  })
})
