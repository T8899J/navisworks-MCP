import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  LoaderCircle,
  RotateCcw,
  UserRound,
  Wrench,
  X
} from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ToolCall } from './chatTypes'
import { displayValue } from './chatTypes'
import { ConversationColumn } from './ConversationColumn'

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

function ToolCallCard({ tool }: { tool: ToolCall }) {
  return (
    <details className="tool-card" open={tool.status === 'running'}>
      <summary>
        <span className="tool-card-heading">
          <Wrench aria-hidden="true" size={14} />
          <span className="tool-name">{tool.name}</span>
          <span className="tool-status-text">{statusText(tool.status)}</span>
        </span>
        <span className="tool-card-summary-tail">
          <ToolStatusIcon tool={tool} />
          <ChevronDown aria-hidden="true" className="tool-chevron" size={14} />
        </span>
      </summary>
      <div className="tool-details">
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
    <article className={`message-row role-${message.role}`} aria-label={`${label}的消息`}>
      <div className="message-shell">
        <div className="message-heading" aria-hidden="true">
          <span className="message-avatar">
            {isUser ? <UserRound size={14} /> : message.role === 'assistant' ? <Bot size={14} /> : <CircleAlert size={14} />}
          </span>
          <span>{label}</span>
        </div>
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
            <div className="tool-list" aria-label="工具调用">
              {message.tools.map((tool) => <ToolCallCard key={tool.id} tool={tool} />)}
            </div>
          ) : null}

          {message.content ? <div className="message-content">{message.content}</div> : null}
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

export function MessageList({ messages, sessionTitle, composerClearance, onRetryLast }: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const shouldFollowRef = useRef(true)
  const [showBottomButton, setShowBottomButton] = useState(false)

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollTo({ top: scroller.scrollHeight, behavior })
    shouldFollowRef.current = true
    setShowBottomButton(false)
  }

  useEffect(() => {
    if (shouldFollowRef.current) scrollToBottom('auto')
  }, [messages, composerClearance])

  return (
    <section
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
