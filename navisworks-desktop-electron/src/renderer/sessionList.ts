import type { SessionSummary } from './chatTypes'

const DAY_MS = 24 * 60 * 60 * 1000

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Sidebar ordering: pinned sessions first, then most recently touched. */
function orderSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    const pinOrder = Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt))
    if (pinOrder !== 0) return pinOrder
    const leftTime = timestamp(left.pinnedAt ?? left.updatedAt)
    const rightTime = timestamp(right.pinnedAt ?? right.updatedAt)
    return rightTime - leftTime
  })
}

/** Title filter shared by the sidebar and the chat-search overlay. */
export function visibleSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const needle = query.trim().toLocaleLowerCase()
  const ordered = orderSessions(sessions)
  if (!needle) return ordered
  return ordered.filter((session) => session.title.toLocaleLowerCase().includes(needle))
}

/** Calendar-day bucket for a session's timestamp, in local time. */
function dayBucket(timestampMs: number, todayStartMs: number): 'today' | 'yesterday' | 'earlier' {
  if (timestampMs >= todayStartMs) return 'today'
  if (timestampMs >= todayStartMs - DAY_MS) return 'yesterday'
  return 'earlier'
}

export interface SessionDayGroup {
  label: '今天' | '昨天' | '最近'
  sessions: SessionSummary[]
}

/**
 * Splits the sidebar list into date-labelled groups. Pinned sessions stay
 * separate (they always lead the list); everything else lands in 今天 /
 * 昨天 / 最近 buckets by its updatedAt calendar day.
 */
export function splitSessionList(
  sessions: SessionSummary[],
  now: Date = new Date()
): { pinned: SessionSummary[]; groups: SessionDayGroup[] } {
  const ordered = orderSessions(sessions)
  const pinned = ordered.filter((session) => Boolean(session.pinnedAt))
  const rest = ordered.filter((session) => !session.pinnedAt)

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const byBucket = new Map<'today' | 'yesterday' | 'earlier', SessionSummary[]>([
    ['today', []],
    ['yesterday', []],
    ['earlier', []]
  ])
  for (const session of rest) {
    byBucket.get(dayBucket(timestamp(session.updatedAt), todayStart))?.push(session)
  }

  // orderSessions already sorts the unpinned tail newest-first, so pushing in
  // encounter order keeps each bucket sorted too.
  const labels: Array<{ key: 'today' | 'yesterday' | 'earlier'; label: SessionDayGroup['label'] }> = [
    { key: 'today', label: '今天' },
    { key: 'yesterday', label: '昨天' },
    { key: 'earlier', label: '最近' }
  ]
  return {
    pinned,
    groups: labels
      .map(({ key, label }) => ({ label, sessions: byBucket.get(key) ?? [] }))
      .filter((group) => group.sessions.length > 0)
  }
}
