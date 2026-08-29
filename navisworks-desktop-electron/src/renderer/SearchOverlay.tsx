import { Pin, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionSummary } from './chatTypes'
import { visibleSessions } from './sessionList'

interface SearchOverlayProps {
  sessions: SessionSummary[]
  activeSessionId?: string
  onClose(): void
  onSelect(sessionId: string): void
}

export function SearchOverlay({ sessions, activeSessionId, onSelect, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('')
  const results = useMemo(() => visibleSessions(sessions, query), [query, sessions])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="search-overlay" role="presentation" onClick={onClose}>
      <div
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="搜索聊天"
        onClick={(event) => event.stopPropagation()}>
        <label className="search-dialog-bar">
          <span className="sr-only">搜索聊天</span>
          <Search aria-hidden="true" size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索聊天"
            autoFocus
          />
        </label>

        <div className="search-dialog-list" role="list" aria-label="聊天列表">
          {results.length === 0 ? (
            <div className="session-empty">{query ? '没有匹配的会话' : '还没有会话'}</div>
          ) : (
            results.map((session) => {
              const active = session.id === activeSessionId
              return (
                <article className="session-row" data-active={active} key={session.id} role="listitem">
                  <button
                    className="session-select"
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      onSelect(session.id)
                      onClose()
                    }}>
                    <span className="session-title-line">
                      {session.pinnedAt ? <Pin aria-label="已固定" size={12} /> : null}
                      <span className="session-title">{session.title || '新会话'}</span>
                    </span>
                  </button>
                </article>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
