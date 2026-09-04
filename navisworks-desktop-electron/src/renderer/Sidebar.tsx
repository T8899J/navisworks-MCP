import { ArrowLeft, PanelLeftClose, Pin, PinOff, Search, Settings, SquarePen, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import type { SessionSummary } from './chatTypes'
import { splitSessionList } from './sessionList'
import { SETTINGS_PAGES, type SettingsPageId } from './SettingsPanel'

interface SidebarProps {
  sessions: SessionSummary[]
  activeSessionId?: string
  open: boolean
  busy?: boolean
  /** Renders the settings category list instead of the session list. */
  settingsMode?: boolean
  activeSettingsPage?: SettingsPageId
  onSettingsPageChange?(page: SettingsPageId): void
  onExitSettings?(): void
  onClose(): void
  onCreate(): void
  onOpenSearch(): void
  onOpenSettings(): void
  onSelect(sessionId: string): void
  onTogglePinned(sessionId: string): void
  onDelete(sessionId: string): void
}

export function Sidebar({
  sessions,
  activeSessionId,
  open,
  busy,
  settingsMode = false,
  activeSettingsPage = 'appearance',
  onSettingsPageChange,
  onExitSettings,
  onClose,
  onCreate,
  onOpenSearch,
  onOpenSettings,
  onSelect,
  onTogglePinned,
  onDelete
}: SidebarProps) {
  const list = useMemo(() => splitSessionList(sessions), [sessions])

  const renderRow = (session: SessionSummary): ReactNode => {
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
  }

  const renderGroup = (label: string, rows: SessionSummary[]): ReactNode => {
    if (rows.length === 0) return null
    return (
      <div className="session-group" key={label}>
        <div className="session-group-label">{label}</div>
        {rows.map(renderRow)}
      </div>
    )
  }

  return (
    <>
      <aside
        id="conversation-sidebar"
        className="sidebar"
        data-open={open}
        aria-hidden={!open}
        aria-label="会话导航">
        {settingsMode ? (
          <>
            <div className="session-row settings-category-row">
              <button
                type="button"
                className="session-select settings-category-item"
                onClick={() => onExitSettings?.()}>
                <span className="session-title-line">
                  <ArrowLeft aria-hidden="true" size={13} />
                  <span className="session-title">返回工作区</span>
                </span>
              </button>
            </div>
            <nav className="session-list settings-category-list" aria-label="设置分类">
              {SETTINGS_PAGES.map((page) => {
                const NavIcon = page.icon
                const active = page.id === activeSettingsPage
                return (
                  <div
                    key={page.id}
                    className="session-row"
                    data-active={active}>
                    <button
                      type="button"
                      className="session-select settings-category-item"
                      aria-current={active ? 'page' : undefined}
                      onClick={() => onSettingsPageChange?.(page.id)}>
                      <span className="session-title-line">
                        <NavIcon aria-hidden="true" size={13} />
                        <span className="session-title">{page.label}</span>
                      </span>
                    </button>
                  </div>
                )
              })}
            </nav>
          </>
        ) : (
          <>
            <div className="sidebar-header">
              <span className="app-name">Curi</span>
              <div className="sidebar-title-actions">
                <button
                  className="icon-button sidebar-search-toggle"
                  type="button"
                  aria-label="搜索聊天"
                  aria-haspopup="dialog"
                  title="搜索聊天"
                  onClick={onOpenSearch}>
                  <Search aria-hidden="true" size={22} />
                </button>
                <button className="icon-button sidebar-close" type="button" aria-label="收起会话栏" onClick={onClose}>
                  <PanelLeftClose aria-hidden="true" size={18} />
                </button>
              </div>
            </div>

            <button className="new-session-button" type="button" onClick={onCreate} disabled={busy}>
              <SquarePen aria-hidden="true" size={15} />
              新对话
            </button>

            <div className="session-list" role="list" aria-label="会话列表">
              {sessions.length === 0 ? (
                <div className="session-empty">还没有会话</div>
              ) : (
                <>
                  {renderGroup('置顶', list.pinned)}
                  {list.groups.map((group) => renderGroup(group.label, group.sessions))}
                </>
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
                <Settings aria-hidden="true" size={18} />
              </button>
            </div>
          </>
        )}
      </aside>
      {open ? <button className="sidebar-backdrop" type="button" aria-label="关闭会话栏" onClick={onClose} /> : null}
    </>
  )
}
