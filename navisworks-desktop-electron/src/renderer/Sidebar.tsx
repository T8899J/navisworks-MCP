import { MessageSquarePlus, PanelLeftClose, Pin, PinOff, Search, Settings2, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { SessionSummary } from './chatTypes'

interface SidebarProps {
  sessions: SessionSummary[]
  activeSessionId?: string
  open: boolean
  busy?: boolean
  onClose(): void
  onCreate(): void
  onOpenSettings(): void
  onSelect(sessionId: string): void
  onTogglePinned(sessionId: string): void
  onDelete(sessionId: string): void
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function Sidebar({
  sessions,
  activeSessionId,
  open,
  busy,
  onClose,
  onCreate,
  onOpenSettings,
  onSelect,
  onTogglePinned,
  onDelete
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return sessions
      .filter((session) => {
        if (!needle) return true
        return session.title.toLocaleLowerCase().includes(needle)
      })
      .sort((left, right) => {
        const pinOrder = Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt))
        if (pinOrder !== 0) return pinOrder
        const leftTime = timestamp(left.pinnedAt ?? left.updatedAt)
        const rightTime = timestamp(right.pinnedAt ?? right.updatedAt)
        return rightTime - leftTime
      })
  }, [query, sessions])

  return (
    <>
      <aside
        id="conversation-sidebar"
        className="sidebar"
        data-open={open}
        aria-hidden={!open}
        aria-label="会话导航">
        <div className="sidebar-header">
          <div>
            <div className="app-kicker">NAVISWORKS MCP</div>
            <div className="app-name">Desktop Agent</div>
          </div>
          <button className="icon-button sidebar-close" type="button" aria-label="收起会话栏" onClick={onClose}>
            <PanelLeftClose aria-hidden="true" size={18} />
          </button>
        </div>

        <button className="new-session-button" type="button" onClick={onCreate} disabled={busy}>
          <MessageSquarePlus aria-hidden="true" size={17} />
          新建会话
        </button>

        <label className="session-search">
          <span className="sr-only">搜索会话</span>
          <Search aria-hidden="true" size={15} />
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索会话" />
        </label>

        <div className="session-list" role="list" aria-label="会话列表">
          {filtered.length === 0 ? (
            <div className="session-empty">{query ? '没有匹配的会话' : '还没有会话'}</div>
          ) : (
            filtered.map((session) => {
              const active = session.id === activeSessionId
              return (
                <article className="session-row" data-active={active} key={session.id} role="listitem">
                  <button
                    className="session-select"
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelect(session.id)}>
                    <span className="session-title-line">
                      {session.pinnedAt ? <Pin aria-label="已固定" size={12} /> : null}
                      <span className="session-title">{session.title || '新会话'}</span>
                    </span>
                  </button>
                  <div className="session-actions" aria-label={`${session.title} 操作`}>
                    <button
                      className="mini-icon-button"
                      type="button"
                      aria-label={session.pinnedAt ? '取消固定会话' : '固定会话'}
                      title={session.pinnedAt ? '取消固定' : '固定'}
                      onClick={() => onTogglePinned(session.id)}>
                      {session.pinnedAt ? <PinOff aria-hidden="true" size={13} /> : <Pin aria-hidden="true" size={13} />}
                    </button>
                    <button
                      className="mini-icon-button danger"
                      type="button"
                      aria-label="删除会话"
                      title="删除"
                      onClick={() => onDelete(session.id)}>
                      <Trash2 aria-hidden="true" size={13} />
                    </button>
                  </div>
                </article>
              )
            })
          )}
        </div>

        <div className="sidebar-footer">
          <button
            className="icon-button"
            type="button"
            aria-label="打开设置"
            aria-haspopup="dialog"
            title="设置"
            onClick={onOpenSettings}>
            <Settings2 aria-hidden="true" size={18} />
          </button>
        </div>
      </aside>
      {open ? <button className="sidebar-backdrop" type="button" aria-label="关闭会话栏" onClick={onClose} /> : null}
    </>
  )
}
