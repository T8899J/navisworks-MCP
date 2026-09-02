import { Check, ChevronLeft, ChevronRight, CircleStop, Gauge, Send, ShieldAlert } from 'lucide-react'
import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  REASONING_EFFORTS,
  REASONING_EFFORT_LABEL,
  localDisplayEffort,
  type ReasoningEffort,
} from '../shared/reasoning'
import type { DesktopSettings, ToolApprovalRequest } from './chatTypes'
import { ConversationColumn } from './ConversationColumn'
import { EffortSlider } from './EffortSlider'
import { pickHeroTitle } from './heroTitles'

const LOCAL_MAX_CONTEXT_TOKENS = 32768

/** Slash commands available from the composer input. */
const SLASH_COMMANDS = [
  { cmd: 'compact', desc: '压缩当前会话上下文' },
] as const

/** Compact context-window label: 8192 → "8K", 1000000 → "1M". */
function formatContextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`
  return `${Math.round(tokens / 1024)}K`
}

/** K-unit usage label: 1500 → "1.5K", 45678 → "45K", 1.2M → "1.2M". */
function formatContextK(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 10240) return `${Math.round(tokens / 1024)}K`
  return `${(tokens / 1024).toFixed(1)}K`
}

interface ComposerProps {
  dockRef: RefObject<HTMLDivElement | null>
  variant?: 'docked' | 'hero'
  draft: string
  busy: boolean
  settings: DesktopSettings
  serviceAvailable: boolean
  /**
   * Token usage of the active session's last reply (context-ring data).
   * `window` is the budget that reply actually ran against, as reported by the
   * runtime; absent until the first reply of the session lands.
   */
  contextUsage?: { used: number; window?: number; cacheHitRate?: number } | null
  approval?: ToolApprovalRequest | null
  approvalResolving?: boolean
  onDraftChange(value: string): void
  onSend(): void
  onStop(): void
  onResolveApproval(decision: 'confirm' | 'cancel'): void
  onModelChange(model: string): void
  /** Switches the active chat model to the API-connected cloud model. */
  onApiModelPick(profileId: string): void
  /** Runs a slash command (e.g. /compact) against the active session. */
  onSlashCommand(cmd: string): void
  onReasoningChange(mode: ReasoningEffort): void
}

export function Composer({
  dockRef,
  variant = 'docked',
  draft,
  busy,
  settings,
  serviceAvailable,
  contextUsage,
  approval,
  approvalResolving = false,
  onDraftChange,
  onSend,
  onStop,
  onResolveApproval,
  onModelChange,
  onApiModelPick,
  onSlashCommand,
  onReasoningChange
}: ComposerProps) {
  // The model actually in effect: either the selected local Ollama model or
  // the API-connected cloud model.
  const activeApiProfile = settings.apiProfiles.find(
    (profile) => profile.id === settings.activeApiProfileId
  )
  // Mirror the main-process routing (ipc.ts resolveChatEndpoint) so the shown
  // model is the one that will actually serve the next run.
  const usingApi = Boolean(
    settings.apiEnabled
    && (settings.preferApiModel || !settings.ollamaEnabled)
    && activeApiProfile?.baseUrl.trim()
    && activeApiProfile.model.trim()
  )
  const activeModel = usingApi ? activeApiProfile!.model : settings.selectedModel
  // Effort slider steps: five for API models, only the two extremes for the
  // local daemon (Low → fast, Max → deep). A middle step persisted from an
  // API run displays as its local equivalent while local is active.
  const effortTicks: readonly ReasoningEffort[] = usingApi
    ? REASONING_EFFORTS
    : (['low', 'max'] as const)
  const activeEffort = usingApi ? settings.reasoningMode : localDisplayEffort(settings.reasoningMode)
  const effortIndex = Math.max(0, effortTicks.indexOf(activeEffort))
  // Context-window budget. The runtime reports the window each finished run
  // actually budgeted against, so the ring measures the real thing rather than
  // assuming a provider window. Before the first reply of a session lands,
  // mirror the runtime's own fallback (agentRuntime.run): the local clamp for
  // Ollama, the configured window for an API endpoint that advertises none —
  // a cloud run is never assumed to be a fixed 1M.
  const fallbackContextTotal = usingApi
    ? Math.max(1024, settings.contextWindowTokens)
    : Math.min(settings.contextWindowTokens, LOCAL_MAX_CONTEXT_TOKENS)
  const reportedWindow = contextUsage?.window
  const contextTotal = reportedWindow !== undefined && reportedWindow > 0
    ? reportedWindow
    : fallbackContextTotal
  const contextLabel = formatContextLabel(contextTotal)
  const usedTokens = contextUsage?.used ?? 0
  const contextPct = usedTokens > 0 ? Math.min(100, (usedTokens / contextTotal) * 100) : 0
  const ringCircumference = 2 * Math.PI * 9
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [isComposing, setIsComposing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * Two views inside the same panel: `'effort'` shows the purple-neon pill
   * with model/mode label and drag handle; `'model'` swaps the pill for a
   * full-bleed model list. Closing the menu resets this back to effort so
   * a fresh open always lands on the pill.
   */
  const [pickerMode, setPickerMode] = useState<'effort' | 'model'>('effort')
  const canSend = serviceAvailable && !busy && draft.trim().length > 0
  // Slash command mode: "/" as the first character opens the command menu
  // above the input (until a space turns the text into a normal message).
  const slashQuery = draft.startsWith('/') && !draft.slice(1).includes(' ')
    ? draft.slice(1).toLowerCase()
    : null
  const slashMatches = slashQuery === null
    ? []
    : SLASH_COMMANDS.filter((command) => command.cmd.startsWith(slashQuery))
  // Greeting is re-drawn whenever the composer docks back into the hero —
  // i.e. per fresh conversation — so repeat visits see different lines.
  const [heroTitle, setHeroTitle] = useState(pickHeroTitle)
  const previousApprovalRef = useRef<ToolApprovalRequest | null>(null)

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

  useEffect(() => {
    if (previousApprovalRef.current && !approval) textareaRef.current?.focus()
    previousApprovalRef.current = approval ?? null
  }, [approval])

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

  // A closed panel must reopen on the effort pill, never mid-model-list.
  useEffect(() => {
    if (!menuOpen) setPickerMode('effort')
  }, [menuOpen])

  const closeMenu = () => {
    setMenuOpen(false)
    setPickerMode('effort')
  }
  // The local daemon only knows two effort steps (Low → fast, Max → deep).
  // Switching to a local model writes the two-step equivalent of any middle
  // step so the persisted value always matches what the runtime applies.
  const pickModel = (model: string) => {
    onModelChange(model)
    const compatible = localDisplayEffort(settings.reasoningMode)
    if (compatible !== settings.reasoningMode) onReasoningChange(compatible)
    closeMenu()
  }
  const pickApiModel = (profileId: string) => {
    onApiModelPick(profileId)
    closeMenu()
  }
  const runSlashCommand = (cmd: string) => {
    onDraftChange('')
    onSlashCommand(cmd)
  }
  const isSlashCommandDraft = slashQuery !== null
    && SLASH_COMMANDS.some((command) => command.cmd === slashQuery.trim())
  const pickEffort = (effort: ReasoningEffort) => {
    if (effort !== settings.reasoningMode) onReasoningChange(effort)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' && event.key !== 'NumpadEnter') return
    if (event.nativeEvent.isComposing || isComposing) return
    if (event.shiftKey) return

    // Enter on an exact slash command runs it instead of sending the text.
    if (isSlashCommandDraft) {
      event.preventDefault()
      if (!busy) {
        onDraftChange('')
        onSlashCommand(slashQuery!.trim())
      }
      return
    }

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
              if (isSlashCommandDraft && !busy) {
                onDraftChange('')
                onSlashCommand(slashQuery!.trim())
                return
              }
              if (canSend) onSend()
            }}>
          {approval ? (
            <ToolApprovalCard
              approval={approval}
              resolving={approvalResolving}
              onResolve={onResolveApproval}
            />
          ) : <>
          <label className="sr-only" htmlFor="composer-input">输入消息</label>
          {slashQuery !== null ? (
            <div className="slash-menu" role="listbox" aria-label="可用指令">
              {slashMatches.map((command) => (
                <button
                  key={command.cmd}
                  type="button"
                  role="option"
                  aria-selected={slashQuery === command.cmd}
                  className="slash-menu-item"
                  onClick={() => runSlashCommand(command.cmd)}>
                  <span className="slash-menu-cmd">/{command.cmd}</span>
                  <span className="slash-menu-desc">{command.desc}</span>
                </button>
              ))}
              {slashMatches.length === 0 ? (
                <div className="slash-menu-empty">没有匹配的指令</div>
              ) : null}
            </div>
          ) : null}
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
              {/* Context-window ring: fills with session usage of the
                  active model's window; hover shows the details panel. */}
              <span
                className={`context-ring${usingApi ? ' api' : ''}`}
                title={reportedWindow !== undefined && reportedWindow > 0
                  ? `上下文窗口 ${contextLabel}（本轮实际预算）`
                  : usingApi
                    ? `上下文窗口 ${contextLabel}（预算回退值，可能低于模型上限）`
                    : `上下文窗口 ${contextLabel}（本地模型最高 32K）`}>
                <svg viewBox="0 0 22 22" aria-hidden="true">
                  <circle className="context-ring-track" cx="11" cy="11" r="9" />
                  {contextPct > 0 ? (
                    <circle
                      className="context-ring-arc"
                      cx="11"
                      cy="11"
                      r="9"
                      strokeDasharray={`${(contextPct / 100) * ringCircumference} ${ringCircumference}`}
                    />
                  ) : null}
                </svg>
                <div className="context-popover" role="presentation">
                  <div className="context-popover-head">
                    <span>上下文容量</span>
                    <span>{contextPct.toFixed(1)}%</span>
                  </div>
                  <div className="context-popover-bar">
                    <span style={{ width: `${contextPct}%` }} />
                  </div>
                  <div className="context-popover-row">
                    <span>已用 / 总量</span>
                    <span>{formatContextK(usedTokens)} / {contextLabel}</span>
                  </div>
                  <div className="context-popover-row">
                    <span>缓存命中率</span>
                    <span>
                      {contextUsage?.cacheHitRate !== undefined
                        ? `${(contextUsage.cacheHitRate * 100).toFixed(1)}%`
                        : usingApi
                          ? '端点未上报'
                          : 'Ollama 未上报'}
                    </span>
                  </div>
                </div>
              </span>
              <button
                type="button"
                className="composer-menu-trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title={`${activeModel} · ${REASONING_EFFORT_LABEL[activeEffort]}`}
                onClick={() => setMenuOpen((open) => !open)}>
                <span className="composer-menu-trigger-model">{activeModel}</span>
                <span className="composer-menu-trigger-sep" aria-hidden="true">·</span>
                <span className="composer-menu-trigger-mode">{REASONING_EFFORT_LABEL[activeEffort]}</span>
              </button>

              <div
                className={`composer-menu-panel${menuOpen ? ' open' : ''}`}
                aria-hidden={!menuOpen}
                ref={panelRef}>
                {pickerMode === 'effort' ? (
                  <div className="composer-picker-effort">
                    <button
                      type="button"
                      className="composer-picker-chip"
                      title={activeModel}
                      onClick={() => setPickerMode('model')}>
                      <span className="composer-picker-chip-name">{activeModel}</span>
                      <span className="composer-picker-chip-sep" aria-hidden="true">·</span>
                      <span className="composer-picker-chip-mode">{REASONING_EFFORT_LABEL[activeEffort]}</span>
                      <ChevronRight aria-hidden="true" size={12} className="composer-picker-chip-chev" />
                    </button>
                    <EffortSlider
                      value={effortIndex}
                      max={Math.max(0, effortTicks.length - 1)}
                      ariaLabel="推理强度"
                      onChange={(next) => {
                        const effort = effortTicks[next]
                        if (effort !== undefined) pickEffort(effort)
                      }}
                    />
                  </div>
                ) : (
                  <div className="composer-model-pane" role="menu" aria-label="可选模型">
                    <div className="composer-model-pane-head">
                      <button
                        type="button"
                        className="composer-model-back"
                        onClick={() => setPickerMode('effort')}>
                        <ChevronLeft aria-hidden="true" size={13} />
                        <span>选择模型</span>
                      </button>
                      <span className="composer-model-count">
                        {((settings.apiEnabled ? settings.apiProfiles.filter((p) => p.baseUrl.trim() && p.model.trim()).length : 0)
                          + (settings.ollamaEnabled ? settings.models.length : 0))}
                      </span>
                    </div>
                    <div className="composer-model-list">
                      {settings.ollamaEnabled ? settings.models.map((model) => (
                        <button
                          key={model}
                          type="button"
                          role="menuitemradio"
                          aria-checked={!settings.preferApiModel && model === settings.selectedModel}
                          className="menu-option"
                          data-selected={!settings.preferApiModel && model === settings.selectedModel}
                          onClick={() => pickModel(model)}>
                          <span className="menu-option-name">{model}</span>
                          <span className="menu-option-tag">本地</span>
                          {!settings.preferApiModel && model === settings.selectedModel ? (
                            <Check aria-hidden="true" size={13} />
                          ) : null}
                        </button>
                      )) : null}
                      {settings.apiEnabled ? settings.apiProfiles
                        .filter((profile) => profile.baseUrl.trim() && profile.model.trim())
                        .map((profile) => (
                        <button
                          key={profile.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={settings.preferApiModel && settings.activeApiProfileId === profile.id}
                          className="menu-option"
                          data-selected={settings.preferApiModel && settings.activeApiProfileId === profile.id}
                          onClick={() => pickApiModel(profile.id)}>
                          <span className="menu-option-name">{profile.name} / {profile.model}</span>
                          <span className="menu-option-tag api">API</span>
                          {settings.preferApiModel && settings.activeApiProfileId === profile.id
                            ? <Check aria-hidden="true" size={13} />
                            : null}
                        </button>
                      )) : null}
                    </div>
                  </div>
                )}
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
          </>}
          <span className="sr-only" id="composer-service-status" aria-live="polite">
            {serviceAvailable ? (busy ? '助手正在生成回复' : '可以发送消息') : '桌面服务未连接'}
          </span>
        </form>
      </ConversationColumn>
    </div>
  )
}

function ToolApprovalCard({
  approval,
  resolving,
  onResolve
}: {
  approval: ToolApprovalRequest
  resolving: boolean
  onResolve(decision: 'confirm' | 'cancel'): void
}) {
  const summary = approvalSummary(approval)
  const cardRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const cancelOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || resolving) return
      event.preventDefault()
      onResolve('cancel')
    }
    document.addEventListener('keydown', cancelOnEscape)
    return () => document.removeEventListener('keydown', cancelOnEscape)
  }, [onResolve, resolving])

  return (
    <section
      ref={cardRef}
      className="tool-approval-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="tool-approval-title"
      aria-describedby="tool-approval-summary"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const focusable = cardRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
        )
        if (!focusable?.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}>
      <div className="tool-approval-copy">
        <ShieldAlert aria-hidden="true" size={20} />
        <div>
          <h2 id="tool-approval-title">操作确认</h2>
          <p id="tool-approval-summary">{summary}</p>
        </div>
      </div>
      <details className="tool-approval-details">
        <summary>查看详细参数</summary>
        <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
      </details>
      <div className="tool-approval-actions">
        <button
          type="button"
          className="secondary-button"
          autoFocus
          disabled={resolving}
          onClick={() => onResolve('cancel')}>
          取消
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={resolving}
          onClick={() => onResolve('confirm')}>
          确认执行
        </button>
      </div>
    </section>
  )
}

function approvalSummary(approval: ToolApprovalRequest): string {
  const args = approval.arguments
  const itemCount = Array.isArray(args.itemIds) ? args.itemIds.length : 0
  if (approval.toolName === 'navisworks_select_items') {
    const action = args.mode === 'add' ? '添加选择'
      : args.mode === 'remove' ? '移除选择'
        : args.mode === 'clear' ? '清空当前选择'
          : '替换当前选择'
    return itemCount > 0 ? `即将${action}，涉及 ${itemCount} 个构件。` : `即将${action}。`
  }
  if (approval.toolName === 'navisworks_set_visibility') {
    const action = args.action === 'hide' ? '隐藏'
      : args.action === 'show' ? '显示'
        : args.action === 'isolate' ? '隔离'
          : '重置模型可见性'
    return itemCount > 0 ? `即将${action} ${itemCount} 个构件。` : `即将${action}。`
  }
  return `即将激活保存视点 ${String(args.viewpointId ?? '') || '（未命名）'}。`
}
