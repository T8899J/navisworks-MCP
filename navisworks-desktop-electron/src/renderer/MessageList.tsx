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
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState
} from 'react'
import type { ChatMessage, ToolCall } from './chatTypes'
import { displayValue } from './chatTypes'
import { ConversationColumn } from './ConversationColumn'
import {
  NAV_ANCHOR_OFFSET_PX,
  interpolateScrollTop,
  navDragReducer,
  nearestStopIndexFromClientY,
  type NavDragState,
  type NavScrubStop,
} from './messageNavScrub'

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

// The scrub cursor must follow the pointer everywhere — pointer capture keeps
// the gesture alive outside the rail — so it lives on <body>, not the rail,
// for exactly the gesture's lifetime.
function setNavScrubbingCursor(active: boolean): void {
  document.body.classList.toggle('message-nav-scrubbing', active)
}

// Lightweight bar centers for hover: the client-Y center of each rendered
// bar, DOM order = turn order. Reads only, so it can run on every hover
// pointermove and stays current under resize or gap changes.
function measureRailStops(nav: HTMLDivElement): Array<{ railY: number }> {
  return Array.from(nav.querySelectorAll<HTMLElement>('.message-nav-item')).map((item) => {
    const rect = item.getBoundingClientRect()
    return { railY: rect.top + rect.height / 2 }
  })
}

// Full anchor stops for a gesture, measured at pointerdown: each rail bar's
// client-Y center plus the REAL conversation scrollTop that brings its turn's
// anchor message to the top of the viewport (minus the same breathing gap the
// click jump uses), clamped to the scrollable range. Turns are unevenly sized,
// so these stops are deliberately not evenly spaced in scroll space — they are
// what the drag interpolates between.
function measureNavScrubStops(
  turns: ConversationTurn[],
  nav: HTMLDivElement,
  scroller: HTMLDivElement,
  maxScroll: number,
): NavScrubStop[] {
  const items = nav.querySelectorAll<HTMLElement>('.message-nav-item')
  if (items.length !== turns.length) return []
  const scrollerRect = scroller.getBoundingClientRect()
  return turns.map((turn, index): NavScrubStop => {
    const rect = items[index]?.getBoundingClientRect()
    const target = scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(turn.anchorId)}"]`)
    const raw = target
      ? scroller.scrollTop + target.getBoundingClientRect().top - scrollerRect.top - NAV_ANCHOR_OFFSET_PX
      : 0
    return {
      index,
      anchorId: turn.anchorId,
      railY: rect ? rect.top + rect.height / 2 : 0,
      scrollTop: Math.min(maxScroll, Math.max(0, raw)),
    }
  })
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
  // True from drag-start until the gesture ends, so unmount mid-gesture (a
  // session switch emptying the rail, say) can still strip the scrub-only
  // cursor class and instant-scroll flag.
  const navScrubActiveRef = useRef(false)
  const turns = buildConversationTurns(messages)
  // Rail density: the gap between bars compresses (7 → 4 → 2px) as turns
  // pile up, so the whole ladder still fits the max-height box — the rail
  // itself never scrolls (overflow is hidden; it is the scrubber already).
  const navGap = turns.length > 40 ? '2px' : turns.length > 24 ? '4px' : '7px'

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
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta - NAV_ANCHOR_OFFSET_PX), behavior: 'smooth' })
  }

  // Crest the wave + preview on one turn, deduped so unchanged turns never
  // re-render. railY is the bar's client-Y center; hover and drag both feed
  // this with the SAME bar they resolved, so the two can never disagree.
  const crestHoverTo = (anchorId: string, railY: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    setNavHover((prev) => {
      if (prev?.id === anchorId) return prev
      return { id: anchorId, top: railY - viewport.getBoundingClientRect().top }
    })
  }

  // Press anywhere inside the rail's box and drag. ANCHOR-BASED SCRUB: the
  // pressed bar (or, on padding/gaps, the bar nearest the press) becomes the
  // gesture's anchor turn, and every bar's REAL conversation scroll position
  // is measured from the DOM at that moment. The first move past the
  // threshold snaps the conversation straight to the anchor turn's position —
  // where the viewport happened to be is irrelevant — and later moves
  // interpolate piecewise between the measured stops, so bars map to turns,
  // never to document percentages. The gesture state machine (threshold,
  // click vs drag, cancel) is the tested pure reducer in messageNavScrub.ts;
  // this handler only wires it to the DOM: pointer capture so the drag
  // survives leaving the rail, one requestAnimationFrame coalescing
  // pointermove into a single scrollTop write per frame, and smooth scroll
  // explicitly disabled for the gesture via data-nav-scrubbing. A press that
  // stays under the threshold releases as a smooth click jump to the anchor.
  const beginNavDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const scroller = scrollerRef.current
    const nav = event.currentTarget
    if (!scroller) return
    const maxScroll = scroller.scrollHeight - scroller.clientHeight
    if (maxScroll <= 0 || turns.length === 0) return
    const stops = measureNavScrubStops(turns, nav, scroller, maxScroll)
    if (stops.length === 0) return
    const pressedBar = (event.target as HTMLElement).closest<HTMLElement>('.message-nav-item')
    const pressedAnchor = pressedBar?.getAttribute('data-turn-anchor') ?? null
    const pressedIndex = pressedAnchor == null
      ? null
      : stops.findIndex((stop) => stop.anchorId === pressedAnchor)
    // A press on a bar anchors there; a press on padding or gaps anchors to
    // the bar nearest the pointer — every rail position yields an anchor.
    const anchorIndex = pressedIndex != null && pressedIndex >= 0
      ? pressedIndex
      : nearestStopIndexFromClientY(event.clientY, stops)
    const anchorStop = stops[anchorIndex]
    if (anchorStop == null) return
    let drag: NavDragState | null = navDragReducer(null, {
      kind: 'pointerdown',
      pointerId: event.pointerId,
      clientY: event.clientY,
      anchorIndex,
      pointerOffsetY: event.clientY - anchorStop.railY,
    }).state
    let pendingScrollTop: number | null = null
    let frame = 0
    nav.setPointerCapture(event.pointerId)

    const applyPending = () => {
      frame = 0
      if (pendingScrollTop == null) return
      const top = pendingScrollTop
      pendingScrollTop = null
      // Direct scrollTop assignment, once per frame — the data-nav-scrubbing
      // flag set at drag-start keeps CSS smooth behavior out of the way.
      scroller.scrollTop = top
    }

    const crestToIndex = (index: number) => {
      const stop = stops[index]
      if (stop) crestHoverTo(stop.anchorId, stop.railY)
    }

    const handleMove = (moveEvent: PointerEvent) => {
      if (drag == null) return
      const result = navDragReducer(drag, { kind: 'pointermove', clientY: moveEvent.clientY })
      drag = result.state
      if (result.outcome.kind === 'drag-start') {
        // First frame past the threshold: kill smooth travel FIRST, then
        // snap straight to the anchor turn's measured position. The old
        // viewport spot never enters the calculation.
        navScrubActiveRef.current = true
        scroller.dataset.navScrubbing = 'true'
        scroller.scrollTop = anchorStop.scrollTop
        setIsNavDragging(true)
        setNavScrubbingCursor(true)
        crestToIndex(anchorIndex)
        return
      }
      if (result.outcome.kind !== 'scroll' || drag == null) return
      // Undo the press-time offset so the bar under the hand stays under the
      // hand, then interpolate between the two neighboring turns' REAL
      // positions — not the document's.
      const effectiveRailY = result.outcome.clientY - drag.pointerOffsetY
      pendingScrollTop = interpolateScrollTop(effectiveRailY, stops)
      if (frame === 0) frame = requestAnimationFrame(applyPending)
      crestToIndex(nearestStopIndexFromClientY(effectiveRailY, stops))
    }
    const handleUp = (upEvent: PointerEvent) => {
      if (drag == null) return
      nav.removeEventListener('pointermove', handleMove)
      nav.removeEventListener('pointerup', handleUp)
      nav.removeEventListener('pointercancel', handleCancel)
      const wasDragging = drag.dragging
      const result = navDragReducer(drag, { kind: 'pointerup' })
      drag = result.state
      // A drag keeps wherever it got to: apply the last pending target, then
      // clear the scrub-only state. No snapping, no recompute.
      if (pendingScrollTop != null) {
        const top = pendingScrollTop
        pendingScrollTop = null
        scroller.scrollTop = top
      }
      if (frame !== 0) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      delete scroller.dataset.navScrubbing
      navScrubActiveRef.current = false
      setIsNavDragging(false)
      setNavScrubbingCursor(false)
      const stillOnRail = upEvent.target instanceof Node && nav.contains(upEvent.target)
      if (!stillOnRail) setNavHover(null)
      if (!wasDragging && result.outcome.kind === 'click') {
        const turn = turns[anchorIndex]
        if (turn) scrollToMessage(turn.anchorId)
      }
    }
    const handleCancel = () => {
      drag = navDragReducer(drag, { kind: 'pointercancel' }).state
      nav.removeEventListener('pointermove', handleMove)
      nav.removeEventListener('pointerup', handleUp)
      nav.removeEventListener('pointercancel', handleCancel)
      if (frame !== 0) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      // Drop everything but the conversation's position: a cancelled gesture
      // leaves the content exactly where the last applied frame put it.
      pendingScrollTop = null
      delete scroller.dataset.navScrubbing
      navScrubActiveRef.current = false
      setIsNavDragging(false)
      setNavScrubbingCursor(false)
      setNavHover(null)
    }
    nav.addEventListener('pointermove', handleMove)
    nav.addEventListener('pointerup', handleUp)
    nav.addEventListener('pointercancel', handleCancel)
  }

  // Continuous hover on the rail: the nearest REAL bar center wins — the same
  // nearest-stop resolution clicks and drags use (messageNavScrub), so hover,
  // click and scrub can never disagree about which turn a position means.
  const handleNavPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isNavDragging || navScrubActiveRef.current) return
    const railStops = measureRailStops(event.currentTarget)
    if (railStops.length === 0) return
    const index = nearestStopIndexFromClientY(event.clientY, railStops)
    const turn = turns[index]
    const railStop = railStops[index]
    if (!turn || !railStop) return
    crestHoverTo(turn.anchorId, railStop.railY)
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

  // A gesture killed by unmount can't run its own cleanup (the listeners die
  // with the rail) — strip the scrub-only cursor class and instant-scroll
  // flag here so neither outlives the drag.
  useEffect(
    () => () => {
      if (!navScrubActiveRef.current) return
      navScrubActiveRef.current = false
      setNavScrubbingCursor(false)
      const scroller = scrollerRef.current
      if (scroller) delete scroller.dataset.navScrubbing
    },
    [],
  )

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
            style={{ '--nav-gap': navGap } as CSSProperties}
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
