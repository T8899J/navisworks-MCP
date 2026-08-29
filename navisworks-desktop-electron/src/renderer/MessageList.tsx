import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  LoaderCircle,
  RotateCcw,
  Wrench,
  X
} from 'lucide-react'
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState
} from 'react'
import type { ChatMessage, ToolCall } from './chatTypes'
import { displayValue } from './chatTypes'
import { ConversationColumn } from './ConversationColumn'

// The local models answer in markdown, but the chat renders plain text.
// Inline-only formatting — **bold** -> <strong>, `code` -> <code> — so the
// asterisks never leak into the UI; headings and lists fall through as
// ordinary characters.
function renderInlineMarkdown(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`\n]+`)/g)
  if (parts.length === 1) return text
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>
    }
    return part
  })
}

interface MessageListProps {
  messages: ChatMessage[]
  sessionTitle?: string
  composerClearance: number
  onRetryLast?(): void
}

function ToolStatusIcon({ tool }: { tool: ToolCall }) {
  switch (tool.status) {
    case 'success':
      return <Check aria-hidden="true" className="tool-status-icon success" size={14} />
    case 'error':
      return <X aria-hidden="true" className="tool-status-icon error" size={14} />
    case 'cancelled':
      return <CircleAlert aria-hidden="true" className="tool-status-icon muted" size={14} />
    default:
      return <LoaderCircle aria-hidden="true" className="tool-status-icon running" size={14} />
  }
}

function statusText(status: ToolCall['status']): string {
  switch (status) {
    case 'queued':
      return '等待执行'
    case 'running':
      return '正在执行'
    case 'success':
      return '已完成'
    case 'error':
      return '执行失败'
    case 'cancelled':
      return '已取消'
  }
}

// Tool calls share the thinking block's streaming silhouette: a small inline
// heading row plus an indented, left-ruled body — no full-width bar, and the
// body never extends past the user bubble's right edge.
function ToolCallCard({ tool }: { tool: ToolCall }) {
  return (
    <details className="tool-block" open={tool.status === 'running'}>
      <summary>
        <Wrench aria-hidden="true" size={13} />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-status-text">{statusText(tool.status)}</span>
        <ToolStatusIcon tool={tool} />
      </summary>
      <div className="tool-block-body">
        {tool.arguments != null ? (
          <div className="tool-detail-row">
            <span className="tool-detail-label">参数</span>
            <pre>{displayValue(tool.arguments)}</pre>
          </div>
        ) : null}
        {tool.result != null ? (
          <div className="tool-detail-row">
            <span className="tool-detail-label">结果</span>
            <pre>{displayValue(tool.result)}</pre>
          </div>
        ) : null}
        {tool.error ? (
          <div className="tool-detail-row error">
            <span className="tool-detail-label">错误</span>
            <pre>{tool.error}</pre>
          </div>
        ) : null}
        {tool.arguments == null && tool.result == null && !tool.error ? (
          <div className="tool-running-copy" role="status">
            工具正在执行…
          </div>
        ) : null}
      </div>
    </details>
  )
}

// Clipboard write with a hidden-textarea fallback: navigator.clipboard is
// unavailable or rejects in non-secure Electron contexts (file:// origin),
// so execCommand('copy') is the reliable backup that always works here.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

function MessageActions({ message, retry }: { message: ChatMessage; retry?: () => void }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  // The copy button belongs only to finished content: while the assistant is
  // streaming or thinking the message is transient, so there is nothing
  // final to copy yet.
  const canCopy = !message.transient

  const copy = async () => {
    const ok = await copyText(message.content)
    if (ok) {
      setCopied(true)
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1800)
    } else {
      setCopied(false)
    }
  }

  return (
    <div className="message-actions" aria-label="消息操作">
      {canCopy ? (
        <button className="message-action-button" type="button" onClick={() => void copy()} aria-label={copied ? '已复制' : '复制消息'} title={copied ? '已复制' : '复制'}>
          {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
        </button>
      ) : null}
      {retry ? (
        <button className="message-action-button" type="button" onClick={retry} aria-label="重新生成" title="重新生成">
          <RotateCcw aria-hidden="true" size={15} />
        </button>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {copied ? '消息已复制' : ''}
      </span>
    </div>
  )
}

function MessageRow({ message, retry }: { message: ChatMessage; retry?: () => void }) {
  const isUser = message.role === 'user'
  const label = isUser ? '你' : message.role === 'assistant' ? '助手' : message.role === 'error' ? '错误' : '系统'

  return (
    <article
      className={`message-row role-${message.role}`}
      data-message-id={message.id}
      aria-label={`${label}的消息`}
    >
      <div className="message-shell">
        <div className="message-body">
          {message.thinking ? (
            <details className="thinking-block" open={message.transient}>
              <summary>
                <span>{message.transient ? '正在思考' : '思考过程'}</span>
                {message.transient ? <LoaderCircle aria-hidden="true" className="running" size={13} /> : null}
              </summary>
              <div>{message.thinking}</div>
            </details>
          ) : null}

          {message.tools.length > 0 ? (
            <div className="message-tool-list" aria-label="工具调用">
              {message.tools.map((tool) => <ToolCallCard key={tool.id} tool={tool} />)}
            </div>
          ) : null}

          {/* Short rule between the agent's stream (thinking + tool calls)
              and the final reply — a small dash, never full-width. */}
          {(message.thinking || message.tools.length > 0) && message.content ? (
            <div className="message-stream-divider" role="presentation" />
          ) : null}

          {message.content ? <div className="message-content">{renderInlineMarkdown(message.content)}</div> : null}
          {message.transient && !message.content && !message.thinking && message.tools.length === 0 ? (
            <div className="message-waiting" role="status">
              <span />
              <span />
              <span />
              <span className="sr-only">助手正在生成</span>
            </div>
          ) : null}
        </div>
        <MessageActions message={message} retry={retry} />
      </div>
    </article>
  )
}

// One conversation turn for the rail's preview: the user prompt (bold dark,
// top) and the agent reply (light, below). Text is whitespace-compacted only
// — the single-line ellipsis in CSS does the truncation.
interface ConversationTurn {
  anchorId: string
  userText: string
  assistantText: string
}

function compactText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

// Collapse the flat message list into user→assistant turns; a leading run of
// assistant/system messages (no user prompt yet) forms its own entry.
function buildConversationTurns(messages: ChatMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  for (const message of messages) {
    const current = turns[turns.length - 1]
    if (message.role === 'user' || !current) {
      turns.push(
        message.role === 'user'
          ? { anchorId: message.id, userText: compactText(message.content), assistantText: '' }
          : { anchorId: message.id, userText: '', assistantText: compactText(message.content ?? message.thinking) }
      )
      continue
    }
    if (message.role === 'assistant' && !current.assistantText) {
      turns[turns.length - 1] = { ...current, assistantText: compactText(message.content ?? message.thinking) }
    }
  }
  return turns
}

// Map each message id to the index of the turn it belongs to, so hovering a
// single bar in the rail can show that turn's preview.
function buildTurnIndexByMessage(messages: ChatMessage[]): Map<string, number> {
  const turnIndexOf = new Map<string, number>()
  let current = -1
  for (const message of messages) {
    if (current < 0 || message.role === 'user') current += 1
    turnIndexOf.set(message.id, current)
  }
  return turnIndexOf
}

// Class for a rail bar given its distance from the hovered crest: the crest
// swells to full length and bars fade away symmetrically on BOTH sides, so
// the wave reads as a ridge centered under the hand. Mirrors
// .message-nav-item.is-lead / .is-step-N in styles.css.
function navItemStepClass(hoveredIndex: number | null, index: number): string {
  if (hoveredIndex == null) return ''
  const distance = Math.abs(index - hoveredIndex)
  if (distance === 0) return ' is-lead'
  if (distance >= 1 && distance <= 5) return ` is-step-${distance}`
  return ''
}

export function MessageList({ messages, sessionTitle, composerClearance, onRetryLast }: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const shouldFollowRef = useRef(true)
  const [showBottomButton, setShowBottomButton] = useState(false)
  const [navHover, setNavHover] = useState<{ id: string; top: number } | null>(null)
  const [isNavDragging, setIsNavDragging] = useState(false)
  const [railHidden, setRailHidden] = useState(false)
  // Tracks the session shown last render so switching sessions (or opening
  // one for the first time) can snap to the bottom instead of animating.
  const prevSessionRef = useRef<string | undefined>(undefined)
  const turns = buildConversationTurns(messages)

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollTo({ top: scroller.scrollHeight, behavior })
    shouldFollowRef.current = true
    setShowBottomButton(false)
  }

  // Jump the scroller to the turn's anchor message; the existing onScroll
  // handler then updates follow-state and the bottom button on its own.
  const scrollToMessage = (id: string) => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const target = scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    if (!target) return
    const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta - 12), behavior: 'smooth' })
  }

  // Pin the preview window to the hovered bar's vertical center, measured
  // against the viewport so it can live outside the rail's clipping box.
  const handleNavItemEnter = (messageId: string) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = event.currentTarget.getBoundingClientRect()
    setNavHover({ id: messageId, top: rect.top - viewport.getBoundingClientRect().top + rect.height / 2 })
  }

  // Press-and-drag on the rail scrubs the conversation: vertical movement
  // maps proportionally onto the scroller's full range, updating immediately
  // so the content glides with the hand. The pointer is captured to the rail
  // itself, so every later pointer event is delivered here by the browser
  // directly — no dependence on the bubble path. A press that barely moves
  // still counts as a click on the pressed bar.
  const beginNavDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const maxScroll = scroller.scrollHeight - scroller.clientHeight
    if (maxScroll <= 0) return
    const nav = event.currentTarget
    const navRect = nav.getBoundingClientRect()
    const navHeight = navRect.height || 1
    const pressedBar = (event.target as HTMLElement).closest<HTMLElement>('.message-nav-item')
    const pressedId = pressedBar?.getAttribute('data-turn-anchor') ?? null
    const startY = event.clientY
    const startTop = scroller.scrollTop
    let moved = false
    setIsNavDragging(true)
    nav.setPointerCapture(event.pointerId)

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientY - startY
      if (Math.abs(delta) > 3) moved = true
      const top = startTop + (delta * maxScroll) / navHeight
      // 'instant', not 'auto': the scroller's CSS scroll-behavior is smooth,
      // and per-frame smooth scrolls would interrupt each other and stall.
      scroller.scrollTo({ top: Math.min(maxScroll, Math.max(0, top)), behavior: 'instant' })
      // Pointer capture freezes :hover during the drag, so track the crest
      // manually: prefer the real bar under the hand; when the cursor roams
      // into the conversation, project its vertical position onto the rail
      // so the wave keeps riding along out there too.
      const bar = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>('.message-nav-item')
      if (bar) {
        const barId = bar.getAttribute('data-turn-anchor')
        if (!barId) return
        setNavHover((prev) => {
          if (prev?.id === barId) return prev
          const viewport = viewportRef.current
          if (!viewport) return prev
          const rect = bar.getBoundingClientRect()
          return { id: barId, top: rect.top - viewport.getBoundingClientRect().top + rect.height / 2 }
        })
        return
      }
      // Cursor is off the rail (out in the conversation): project its height
      // onto the rail's span and crest the turn that ratio lands on.
      const ratio = Math.min(1, Math.max(0, (moveEvent.clientY - navRect.top) / (navRect.height || 1)))
      const projected = turns[Math.floor(ratio * turns.length)] ?? turns[turns.length - 1]
      if (!projected) return
      setNavHover((prev) => {
        if (prev?.id === projected.anchorId) return prev
        return {
          id: projected.anchorId,
          top: navRect.top + ratio * navRect.height - (viewportRef.current?.getBoundingClientRect().top ?? 0)
        }
      })
    }
    const handleUp = (upEvent: PointerEvent) => {
      nav.removeEventListener('pointermove', handleMove)
      nav.removeEventListener('pointerup', handleUp)
      nav.removeEventListener('pointercancel', handleCancel)
      setIsNavDragging(false)
      // Release leaves the pointer wherever the drag ended; drop the ladder
      // unless the cursor is still resting on the rail.
      const stillOnRail = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest('.message-nav')
      if (!stillOnRail) setNavHover(null)
      if (!moved && pressedId) scrollToMessage(pressedId)
    }
    const handleCancel = () => {
      nav.removeEventListener('pointermove', handleMove)
      nav.removeEventListener('pointerup', handleUp)
      nav.removeEventListener('pointercancel', handleCancel)
      setIsNavDragging(false)
    }
    nav.addEventListener('pointermove', handleMove)
    nav.addEventListener('pointerup', handleUp)
    nav.addEventListener('pointercancel', handleCancel)
  }

  // Continuous hover tracking on the rail: the crest fires across the rail's
  // full vertical span — top bar to bottom bar, both ends inclusive — not
  // only when the cursor sits exactly on a bar. The cursor's height is
  // projected onto the span to pick the turn it falls on.
  const handleNavPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isNavDragging) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.height <= 0 || turns.length === 0) return
    const ratio = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    const index = Math.min(turns.length - 1, Math.floor(ratio * turns.length))
    const turn = turns[index]
    if (!turn) return
    setNavHover((prev) => {
      if (prev?.id === turn.anchorId) return prev
      const viewport = viewportRef.current
      if (!viewport) return prev
      const barTop = rect.top + ((index + 0.5) / turns.length) * rect.height
      return { id: turn.anchorId, top: barTop - viewport.getBoundingClientRect().top }
    })
  }

  // navHover.id is a turn's anchor (the user message id that opens the turn);
  // map it back to the turn index for the ladder + preview.
  const turnIndexOfMessage = buildTurnIndexByMessage(messages)
  const hoveredTurnIndex = navHover ? turnIndexOfMessage.get(navHover.id) : undefined
  const activeTurn = hoveredTurnIndex == null ? undefined : turns[hoveredTurnIndex]

  useEffect(() => {
    if (!shouldFollowRef.current) return
    // Snapping into a session (first open or switch) should land at the
    // latest message with no travel; new messages arriving in the same
    // session still smooth-follow. 'instant' overrides the scroller's CSS
    // scroll-behavior: smooth.
    const switched = prevSessionRef.current !== sessionTitle
    prevSessionRef.current = sessionTitle
    scrollToBottom(switched ? 'instant' : 'auto')
  }, [messages, composerClearance, sessionTitle])

  // Hide the rail the instant the conversation column's left edge meets it —
  // a layout collision, not a window-width breakpoint. The rail is absolute
  // (out of flow), so toggling it never shifts the column and never flickers.
  // visibility:hidden keeps the rail measurable so the show condition (column
  // left > rail right) stays knowable while hidden.
  useEffect(() => {
    const scroller = scrollerRef.current
    const nav = navRef.current
    if (!scroller || !nav) return
    const column = scroller.querySelector<HTMLElement>('.message-column')
    if (!column) return
    const check = () => {
      const navRight = nav.getBoundingClientRect().right
      const colLeft = column.getBoundingClientRect().left
      setRailHidden(colLeft <= navRight)
    }
    check()
    window.addEventListener('resize', check)
    const ro = new ResizeObserver(check)
    ro.observe(column)
    ro.observe(scroller)
    return () => {
      window.removeEventListener('resize', check)
      ro.disconnect()
    }
  }, [])

  return (
    <section
      ref={viewportRef}
      className="message-viewport"
      aria-label={sessionTitle ? `会话：${sessionTitle}` : '会话'}
      style={{ '--composer-height': `${composerClearance}px` } as CSSProperties}>
      <div
        ref={scrollerRef}
        className="message-scroller"
        data-message-scroller=""
        role="log"
        aria-relevant="additions"
        tabIndex={0}
        onScroll={(event) => {
          const scroller = event.currentTarget
          const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 64
          shouldFollowRef.current = atBottom
          setShowBottomButton(!atBottom && messages.length > 0)
        }}>
        <ConversationColumn className="message-column">
          {/* Rendered only with at least one message: the empty state lives in
              the composer hero variant now. */}
          <div className="message-list">
            {messages.map((message, index) => (
              <MessageRow
                key={message.id}
                message={message}
                retry={message.role === 'assistant' && index === messages.length - 1 ? onRetryLast : undefined}
              />
            ))}
          </div>
        </ConversationColumn>
      </div>

      {/* Outline rail in the viewport's left gutter: one bar per message.
          Hovering a bar lengthens it and steps the bars below it down from
          long to short; a preview window shows that turn (user ≤5 chars on
          top, agent ≤15 chars below). Click jumps to it. Hidden on narrow
          viewports via CSS. */}
      {messages.length > 1 && turns.length > 0 ? (
        <>
          <div
            ref={navRef}
            className={
              isNavDragging ? 'message-nav is-dragging' : railHidden ? 'message-nav is-hidden' : 'message-nav'
            }
            role="navigation"
            aria-label="对话导航"
            onPointerDown={beginNavDrag}
            onPointerMove={handleNavPointerMove}
            onMouseLeave={() => setNavHover(null)}
          >
            {turns.map((turn, index) => (
              <button
                key={turn.anchorId}
                type="button"
                className={`message-nav-item${navItemStepClass(hoveredTurnIndex ?? null, index)}`}
                data-turn-anchor={turn.anchorId}
                aria-label={`跳转到第 ${index + 1} 轮对话`}
                onMouseEnter={handleNavItemEnter(turn.anchorId)}
              />
            ))}
          </div>

          {/* Outside the rail so the rail's overflow box can't clip it. */}
          {navHover && activeTurn && !railHidden ? (
            <div className="message-nav-preview" style={{ top: `${navHover.top}px` }} role="status">
              {activeTurn.userText ? (
                <span className="message-nav-preview-user">{activeTurn.userText}</span>
              ) : null}
              {activeTurn.assistantText ? (
                <span className="message-nav-preview-assistant">{activeTurn.assistantText}</span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {showBottomButton ? (
        <button
          className="scroll-bottom-button"
          type="button"
          onClick={() => scrollToBottom()}
          aria-label="回到最新消息">
          <ChevronDown aria-hidden="true" size={18} />
        </button>
      ) : null}
    </section>
  )
}
