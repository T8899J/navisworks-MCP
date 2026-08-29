import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../chatTypes'
import { splitSessionList } from '../sessionList'

function summary(partial: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'updatedAt'>): SessionSummary {
  return {
    title: `会话 ${partial.id}`,
    preview: '',
    ...partial
  }
}

describe('splitSessionList', () => {
  const now = new Date('2026-08-27T15:00:00')

  it('leads with pinned sessions regardless of recency', () => {
    const pinnedOld = summary({ id: 'p1', updatedAt: '2026-08-01T09:00:00', pinnedAt: '2026-08-01T10:00:00' })
    const freshToday = summary({ id: 'a', updatedAt: '2026-08-27T14:00:00' })

    const result = splitSessionList([freshToday, pinnedOld], now)

    expect(result.pinned.map((session) => session.id)).toEqual(['p1'])
    expect(result.groups[0]?.label).toBe('今天')
    expect(result.groups[0]?.sessions.map((session) => session.id)).toEqual(['a'])
  })

  it('buckets unpinned sessions into 今天/昨天/最近 by local calendar day', () => {
    const today = summary({ id: 't1', updatedAt: '2026-08-27T00:05:00' })
    const yesterday = summary({ id: 'y1', updatedAt: '2026-08-26T23:55:00' })
    const earlier = summary({ id: 'e1', updatedAt: '2026-08-20T12:00:00' })
    const anotherToday = summary({ id: 't0', updatedAt: '2026-08-27T15:00:00' })

    const result = splitSessionList([yesterday, earlier, anotherToday, today], now)

    expect(result.groups.map((group) => group.label)).toEqual(['今天', '昨天', '最近'])
    expect(result.groups[0]?.sessions.map((session) => session.id)).toEqual(['t0', 't1'])
    expect(result.groups[1]?.sessions.map((session) => session.id)).toEqual(['y1'])
    expect(result.groups[2]?.sessions.map((session) => session.id)).toEqual(['e1'])
  })

  it('drops empty buckets and keeps nothing pinned empty-safe', () => {
    const earlier = summary({ id: 'e1', updatedAt: '2026-08-20T12:00:00' })

    const result = splitSessionList([earlier], now)

    expect(result.pinned).toEqual([])
    expect(result.groups.map((group) => group.label)).toEqual(['最近'])
  })

  it('keeps unpinned recency order inside each bucket', () => {
    const older = summary({ id: 'old', updatedAt: '2026-08-27T08:00:00' })
    const newer = summary({ id: 'new', updatedAt: '2026-08-27T12:00:00' })

    const result = splitSessionList([older, newer], now)

    expect(result.groups[0]?.sessions.map((session) => session.id)).toEqual(['new', 'old'])
  })
})
