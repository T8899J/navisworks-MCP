import { ArrowLeft, ArrowRight, PanelLeft, X } from 'lucide-react'
import { desktopGateway } from './desktop'

interface TitleBarProps {
  /** Mirrors the sidebar's open state so the color seam follows its collapse. */
  sidebarOpen?: boolean
  onToggleSidebar?(): void
}

/**
 * Frameless-window title bar in a classic menu-bar shape: sidebar toggle,
 * back/forward, and the 文件/编辑/视图/帮助 menus share one pill-hover style;
 * window controls dock right. The left strip takes the sidebar color up to
 * the window buttons, the closing strip matches the content background.
 *
 * Minimize/maximize glyphs are pure CSS (a solid bar and an outlined square)
 * instead of stroked icon-font shapes: at caption-button size the stroked
 * icons read as faint smudges, while solid geometry keeps the Windows
 * caption-button shape legible in both themes.
 */
export function TitleBar({ sidebarOpen = true, onToggleSidebar }: TitleBarProps) {
  return (
    <div className="title-bar" data-sidebar-closed={!sidebarOpen}>
      <div className="title-bar-menu">
        <button
          className="title-bar-item title-bar-icon"
          type="button"
          aria-label={sidebarOpen ? '收起会话栏' : '打开会话栏'}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}>
          <PanelLeft aria-hidden="true" size={14} />
        </button>
        <button className="title-bar-item title-bar-icon" type="button" aria-label="后退" disabled>
          <ArrowLeft aria-hidden="true" size={14} />
        </button>
        <button className="title-bar-item title-bar-icon" type="button" aria-label="前进" disabled>
          <ArrowRight aria-hidden="true" size={14} />
        </button>
        <button className="title-bar-item" type="button">文件</button>
        <button className="title-bar-item" type="button">编辑</button>
        <button className="title-bar-item" type="button">视图</button>
        <button className="title-bar-item" type="button">帮助</button>
      </div>
      <div className="title-bar-drag" />
      <div className="title-bar-controls">
        <button
          className="title-bar-button"
          type="button"
          aria-label="最小化"
          onClick={() => void desktopGateway.windowControl('minimize')}>
          <span className="glyph-minimize" aria-hidden="true" />
        </button>
        <button
          className="title-bar-button"
          type="button"
          aria-label="最大化/还原"
          onClick={() => void desktopGateway.windowControl('toggle-maximize')}>
          <span className="glyph-maximize" aria-hidden="true" />
        </button>
        <button
          className="title-bar-button title-bar-close"
          type="button"
          aria-label="关闭窗口"
          onClick={() => void desktopGateway.windowControl('close')}>
          <X aria-hidden="true" size={14} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  )
}
