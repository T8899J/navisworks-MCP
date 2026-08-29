import { Check, ChevronLeft, ChevronRight, ChevronUp, CircleStop, Gauge, Send, Sparkles } from 'lucide-react'
import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DesktopSettings } from './chatTypes'
import { ConversationColumn } from './ConversationColumn'
import { pickHeroTitle } from './heroTitles'

const REASONING_LABEL = { fast: '快速', deep: '深度' } as const

interface ComposerProps {
  dockRef: RefObject<HTMLDivElement | null>
  variant?: 'docked' | 'hero'
  draft: string
  busy: boolean
  settings: DesktopSettings
  serviceAvailable: boolean
  onDraftChange(value: string): void
  onSend(): void
  onStop(): void
  onModelChange(model: string): void
  onReasoningChange(mode: 'fast' | 'deep'): void
}

export function Composer({
  dockRef,
  variant = 'docked',
  draft,
  busy,
  settings,
  serviceAvailable,
  onDraftChange,
  onSend,
  onStop,
  onModelChange,
  onReasoningChange
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [isComposing, setIsComposing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [expanded, setExpanded] = useState<'model' | 'reasoning' | null>(null)
  // The option list cascades sideways; it opens to the right only when the
  // panel sits too close to the window's left edge for a left cascade.
  const [cascadeSide, setCascadeSide] = useState<'left' | 'right'>('left')
  const canSend = serviceAvailable && !busy && draft.trim().length > 0
  // Greeting is re-drawn whenever the composer docks back into the hero —
  // i.e. per fresh conversation — so repeat visits see different lines.
  const [heroTitle, setHeroTitle] = useState(pickHeroTitle)

  useEffect(() => {
    if (variant === 'hero') setHeroTitle(pickHeroTitle())
  }, [variant])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 48), 156)}px`
  }, [draft])

  // The hero variant is the first thing on screen for a brand-new draft, so
  // the input should already own focus; docking back must never steal it.
  useEffect(() => {
    if (variant === 'hero') textareaRef.current?.focus()
  }, [variant])

  // Close the merged menu on any press outside the controls or on Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  // Pick the cascade direction once per expansion: the submenu (~216px wide)
  // opens left by default, right when the panel hugs the window's left edge.
  useEffect(() => {
    if (!menuOpen || !expanded) return
    const panel = panelRef.current
    if (!panel) return
    const left = panel.getBoundingClientRect().left
    setCascadeSide(left < 240 ? 'right' : 'left')
  }, [menuOpen, expanded])

  // A menu closed without picking anything must not resurrect its last-hovered
  // cascade card on reopen; section expansion lives only while the panel is open.
  useEffect(() => {
    if (!menuOpen) setExpanded(null)
  }, [menuOpen])

  const closeMenu = () => {
    setMenuOpen(false)
    setExpanded(null)
  }
  const pickModel = (model: string) => {
    onModelChange(model)
    closeMenu()
  }
  const pickReasoning = (mode: 'fast' | 'deep') => {
    onReasoningChange(mode)
    closeMenu()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' && event.key !== 'NumpadEnter') return
    if (event.nativeEvent.isComposing || isComposing) return
    if (event.shiftKey) return

    event.preventDefault()
    if (!event.repeat && canSend) onSend()
  }

  return (
    <div
      className={`composer-dock${variant === 'hero' ? ' composer-dock--hero' : ''}`}
      ref={dockRef}>
      <ConversationColumn className="composer-column">
        {variant === 'hero' ? (
          <header className="composer-hero-heading">
            <h2>{heroTitle}</h2>
          </header>
        ) : null}
        <form
            className="composer-surface"
            aria-label="消息输入"
            onSubmit={(event) => {
              event.preventDefault()
              if (canSend) onSend()
            }}>
          <label className="sr-only" htmlFor="composer-input">输入消息</label>
          <textarea
            ref={textareaRef}
            id="composer-input"
            rows={1}
            value={draft}
            placeholder="输入消息，按 Enter 发送"
            aria-describedby="composer-shortcut composer-service-status"
            spellCheck="true"
            disabled={!serviceAvailable}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={(event) => {
              setIsComposing(false)
              if (event.currentTarget.value !== draft) onDraftChange(event.currentTarget.value)
            }}
            onKeyDown={handleKeyDown}
          />

          <div className="composer-toolbar">
            <div className="composer-meta">
              <Gauge aria-hidden="true" size={15} />
              <span id="composer-shortcut">Enter 发送 · Shift+Enter 换行</span>
            </div>

            <div className="composer-controls" ref={controlsRef}>
              <button
                type="button"
                className="composer-menu-trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={busy}
                title={`${settings.selectedModel} · ${REASONING_LABEL[settings.reasoningMode]}`}
                onClick={() => setMenuOpen((open) => !open)}>
                <Sparkles aria-hidden="true" size={13} />
                <span className="composer-menu-trigger-model">{settings.selectedModel}</span>
                <span className="composer-menu-trigger-sep" aria-hidden="true">·</span>
                <span className="composer-menu-trigger-mode">{REASONING_LABEL[settings.reasoningMode]}</span>
                <ChevronUp aria-hidden="true" size={13} className={menuOpen ? 'flipped' : undefined} />
              </button>

              <div
                className={`composer-menu-panel${menuOpen ? ' open' : ''}`}
                role="menu"
                aria-hidden={!menuOpen}
                ref={panelRef}>
                <div
                  className={`menu-section${cascadeSide === 'right' ? ' cascade-right' : ''}`}
                  data-expanded={expanded === 'model'}
                  onMouseEnter={() => setExpanded('model')}>
                  <button
                    type="button"
                    className="menu-section-header"
                    aria-expanded={expanded === 'model'}
                    onClick={() => setExpanded((current) => current === 'model' ? null : 'model')}>
                    <span className="menu-section-label">模型</span>
                    <span className="menu-section-value">{settings.selectedModel}</span>
                    {cascadeSide === 'right'
                      ? <ChevronRight aria-hidden="true" size={13} />
                      : <ChevronLeft aria-hidden="true" size={13} />}
                  </button>
                  <div className="menu-section-list">
                    <div className="menu-options model-options">
                      {settings.models.map((model) => (
                        <button
                          key={model}
                          type="button"
                          role="menuitemradio"
                          aria-checked={model === settings.selectedModel}
                          className="menu-option"
                          data-selected={model === settings.selectedModel}
                          onClick={() => pickModel(model)}>
                          <span className="menu-option-name">{model}</span>
                          {model === settings.selectedModel ? <Check aria-hidden="true" size={13} /> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div
                  className={`menu-section${cascadeSide === 'right' ? ' cascade-right' : ''}`}
                  data-expanded={expanded === 'reasoning'}
                  onMouseEnter={() => setExpanded('reasoning')}>
                  <button
                    type="button"
                    className="menu-section-header"
                    aria-expanded={expanded === 'reasoning'}
                    onClick={() => setExpanded((current) => current === 'reasoning' ? null : 'reasoning')}>
                    <span className="menu-section-label">思考程度</span>
                    <span className="menu-section-value">{REASONING_LABEL[settings.reasoningMode]}</span>
                    {cascadeSide === 'right'
                      ? <ChevronRight aria-hidden="true" size={13} />
                      : <ChevronLeft aria-hidden="true" size={13} />}
                  </button>
                  <div className="menu-section-list">
                    <div className="menu-options">
                      {(['fast', 'deep'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          role="menuitemradio"
                          aria-checked={mode === settings.reasoningMode}
                          className="menu-option"
                          data-selected={mode === settings.reasoningMode}
                          onClick={() => pickReasoning(mode)}>
                          <span className="menu-option-name">{REASONING_LABEL[mode]}</span>
                          <span className="menu-option-hint">
                            {mode === 'fast' ? '直接回答，速度优先' : '先推理再回答，更严谨'}
                          </span>
                          {mode === settings.reasoningMode ? <Check aria-hidden="true" size={13} /> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {busy ? (
                <button className="send-button stop" type="button" onClick={onStop} aria-label="停止生成" title="停止生成">
                  <CircleStop aria-hidden="true" size={18} />
                </button>
              ) : (
                <button className="send-button" type="submit" disabled={!canSend} aria-label="发送消息" title="发送">
                  <Send aria-hidden="true" size={18} />
                </button>
              )}
            </div>
          </div>
          <span className="sr-only" id="composer-service-status" aria-live="polite">
            {serviceAvailable ? (busy ? '助手正在生成回复' : '可以发送消息') : '桌面服务未连接'}
          </span>
        </form>
      </ConversationColumn>
    </div>
  )
}
