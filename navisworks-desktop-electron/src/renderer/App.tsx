import { Box, Check, ChevronDown, PanelLeftClose, PanelLeftOpen, RefreshCw } from 'lucide-react'
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type {
  AppearanceState,
  NavisworksConnectionState,
  RuntimeInfo,
  ThemeMode,
} from '../shared/ipc'
import {
  type ChatMessage,
  type ChatSession,
  type ChatStreamEvent,
  type DesktopSettings,
  type NavisworksStatus,
  type SessionSummary,
  type ToolApprovalRequest,
  createId
} from './chatTypes'
import { Composer } from './Composer'
import { appearanceGateway, applyAppearance, applyFontScale } from './appearance'
import { desktopGateway } from './desktop'
import { MessageList } from './MessageList'
import {
  isSessionReadyForSend,
  planAfterDurableSessionDeletion,
  planSessionDeletion,
  planSessionReconciliation,
  removeDeletedSessionDraft,
  SessionTransitionLock,
  shouldApplySessionLoad,
  shouldPersistChatCompletion,
  shouldShowHeroComposer
} from './sessionLifecycle'
import { Sidebar } from './Sidebar'
import { SearchOverlay } from './SearchOverlay'
import { SettingsPanel } from './SettingsPanel'

const DEFAULT_SETTINGS: DesktopSettings = {
  selectedModel: 'qwen3.5:9b-q4_K_M',
  models: ['qwen3.5:9b-q4_K_M'],
  reasoningMode: 'low',
  themeMode: 'system',
  disabledTools: [],
  fontScale: 1,
  contextWindowTokens: 32768,
  preferApiModel: false,
  ollamaEnabled: true,
  apiEnabled: true,
  apiProfiles: [],
  activeApiProfileId: null
}

const DEFAULT_NAVISWORKS_STATUS: NavisworksStatus = {
  connected: false,
  status: '未连接'
}

const DEFAULT_NAVISWORKS_CONNECTION: NavisworksConnectionState = { instances: [] }

function statusFromConnection(state: NavisworksConnectionState): NavisworksStatus {
  const selected = state.instances.find((instance) => instance.instanceId === state.selectedInstanceId)
  if (selected === undefined) return DEFAULT_NAVISWORKS_STATUS
  return {
    connected: selected.connected,
    status: selected.connected ? selected.documentName ?? '已连接' : '当前 Navisworks 已断开',
    ...(selected.documentName === undefined ? {} : { documentName: selected.documentName }),
  }
}

const MOBILE_SIDEBAR_QUERY = '(max-width: 900px)'

function systemAppearance(): AppearanceState {
  return {
    themeMode: 'system',
    effectiveTheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
}

function createSession(): ChatSession {
  const now = new Date().toISOString()
  return {
    id: createId(),
    title: '新会话',
    preview: '',
    updatedAt: now,
    pinnedAt: null,
    messages: [],
    contextTokensUsed: 0
  }
}

function toSummary(session: ChatSession): SessionSummary {
  const { messages: _messages, contextTokensUsed: _tokens, ...summary } = session
  return summary
}

function eventErrorMessage(error: ChatStreamEvent['error']): string {
  if (!error) return '生成失败'
  return typeof error === 'string' ? error : error.message
}

function findTransientAssistantIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.transient) return index
  }
  return -1
}

function updateStreamMessage(messages: ChatMessage[], event: ChatStreamEvent): ChatMessage[] {
  const idIndex = event.messageId ? messages.findIndex((message) => message.id === event.messageId) : -1
  const targetIndex = idIndex >= 0
    ? idIndex
    : findTransientAssistantIndex(messages)
  if (targetIndex < 0) return messages

  const target = messages[targetIndex]
  if (!target) return messages
  const updated: ChatMessage = { ...target, tools: [...target.tools] }

  switch (event.kind) {
    case 'thinking':
      updated.thinking = `${updated.thinking ?? ''}${event.delta ?? event.text ?? ''}`
      break
    case 'text':
      updated.content = `${updated.content}${event.delta ?? event.text ?? ''}`
      break
    case 'tool-start': {
      const toolCallId = event.toolCallId ?? createId()
      const existingIndex = updated.tools.findIndex((tool) => tool.id === toolCallId)
      const nextTool = {
        id: toolCallId,
        name: event.toolName ?? '工具',
        status: 'running' as const,
        arguments: event.arguments
      }
      const existing = updated.tools[existingIndex]
      if (existingIndex >= 0 && existing) updated.tools[existingIndex] = { ...existing, ...nextTool }
      else updated.tools.push(nextTool)
      break
    }
    case 'tool-result': {
      const existingIndex = updated.tools.findIndex((tool) => tool.id === event.toolCallId)
      const resultTool = {
        id: event.toolCallId ?? createId(),
        name: event.toolName ?? '工具',
        status: event.error ? ('error' as const) : ('success' as const),
        arguments: event.arguments,
        result: event.result,
        error: event.error ? eventErrorMessage(event.error) : undefined
      }
      const existing = updated.tools[existingIndex]
      if (existingIndex >= 0 && existing) updated.tools[existingIndex] = { ...existing, ...resultTool }
      else updated.tools.push(resultTool)
      break
    }
    case 'done':
      updated.transient = false
      if (event.content !== undefined) updated.content = event.content
      if (event.thinkingText !== undefined) updated.thinking = event.thinkingText
      break
    case 'error':
      updated.transient = false
      updated.content = updated.content || `错误：${eventErrorMessage(event.error)}`
      break
  }

  return messages.map((message, index) => index === targetIndex ? updated : message)
}

export default function App() {
  const serviceAvailable = desktopGateway.isAvailable()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>()
  // Id of the in-memory-only draft conversation. It is never listed in the
  // sidebar and never persisted; the first sent message promotes it into a
  // real session by clearing this marker (persistSession does the rest).
  const [draftSessionId, setDraftSessionId] = useState<string>()
  const [session, setSession] = useState<ChatSession>()
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [appearance, setAppearance] = useState<AppearanceState>(systemAppearance)
  const [navisworks, setNavisworks] = useState(DEFAULT_NAVISWORKS_STATUS)
  const [navisworksConnection, setNavisworksConnection] = useState(DEFAULT_NAVISWORKS_CONNECTION)
  // Round-trip latency of the last cloud connectivity test; null until run.
  const [cloudLatency, setCloudLatency] = useState<{ ok: boolean; ms: number } | null>(null)
  // Context-ring usage of the active session: tokens of the last round, the
  // window that round actually budgeted against, and the backend's cache hit
  // rate when it reports one.
  const [contextUsage, setContextUsage] = useState<{
    used: number
    window?: number
    cacheHitRate?: number
  } | null>(null)
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo>()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [turnId, setTurnId] = useState<string>()
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia(MOBILE_SIDEBAR_QUERY).matches)
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Chat-search overlay, scoped to the conversation pane (see SearchOverlay).
  const [searchOpen, setSearchOpen] = useState(false)
  // In-app delete confirmation target. Native dialogs are off-limits:
  // Electron's window.confirm() leaves the renderer unable to focus inputs.
  const [pendingDeleteSession, setPendingDeleteSession] = useState<SessionSummary | null>(null)
  const [pendingToolApproval, setPendingToolApproval] = useState<ToolApprovalRequest | null>(null)
  const [approvalResolving, setApprovalResolving] = useState(false)
  const [sessionTransitioning, setSessionTransitioning] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<string>()
  const [navisworksMenuOpen, setNavisworksMenuOpen] = useState(false)
  const [loading, setLoading] = useState(serviceAvailable)
  const [notice, setNotice] = useState(serviceAvailable ? '' : '桌面服务未连接，请通过 Electron 启动应用。')
  // Notices float above every overlay and dismiss themselves after 3s.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])
  const [composerClearance, setComposerClearance] = useState(176)
  const composerDockRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<ChatSession | undefined>(undefined)
  const sessionsRef = useRef<SessionSummary[]>([])
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const draftSessionIdRef = useRef<string | undefined>(undefined)
  const sessionLoadVersionRef = useRef(0)
  const sessionTransitionLockRef = useRef(new SessionTransitionLock())
  const busyRef = useRef(false)

  const draft = activeSessionId ? drafts[activeSessionId] ?? '' : ''
  sessionRef.current = session
  sessionsRef.current = sessions
  activeSessionIdRef.current = activeSessionId
  draftSessionIdRef.current = draftSessionId
  busyRef.current = busy
  const isDraftSession = activeSessionId !== undefined && activeSessionId === draftSessionId
  const showHero = shouldShowHeroComposer({
    isLoading: loading,
    isDraftSession,
    messageCount: session?.messages.length ?? 0
  })
  const sidebarOpen = compactLayout ? mobileDrawerOpen : desktopSidebarOpen

  const setSidebarOpen = useCallback((next: SetStateAction<boolean>) => {
    if (window.matchMedia(MOBILE_SIDEBAR_QUERY).matches) setMobileDrawerOpen(next)
    else setDesktopSidebarOpen(next)
  }, [])

  const beginSessionTransition = useCallback(() => {
    if (!sessionTransitionLockRef.current.tryAcquire()) return false
    setSessionTransitioning(true)
    return true
  }, [])

  const endSessionTransition = useCallback(() => {
    sessionTransitionLockRef.current.release()
    setSessionTransitioning(false)
  }, [])

  const commitSessionSummaries = useCallback((next: SessionSummary[]) => {
    sessionsRef.current = next
    setSessions(next)
  }, [])

  /**
   * Re-pulls the durable list so a failed mutation (e.g. delete) cannot leave
   * sidebar rows the disk no longer has. The active selection is untouched.
   */
  const reconcileSessionsFromDisk = useCallback(async () => {
    if (!serviceAvailable) return
    try {
      const remoteSummaries = await desktopGateway.listSessions()
      commitSessionSummaries(
        planSessionReconciliation(remoteSummaries, activeSessionIdRef.current).summaries
      )
    } catch {
      // The durable read failed too; keep the current list until the next user
      // action retries reconciliation instead of masking the original error.
    }
  }, [commitSessionSummaries, serviceAvailable])

  const invalidateSessionLoads = useCallback(() => {
    sessionLoadVersionRef.current += 1
  }, [])

  const activateLoadedSession = useCallback((next: ChatSession) => {
    invalidateSessionLoads()
    activeSessionIdRef.current = next.id
    sessionRef.current = next
    setActiveSessionId(next.id)
    setSession(next)
  }, [invalidateSessionLoads])

  /**
   * Swaps the view to an in-memory draft conversation: live in the composer,
   * absent from the sidebar and from disk. Any previous draft is discarded
   * together with its unsent text — the same semantics as switching away,
   * because drafts were never persisted.
   */
  const startDraftSession = useCallback((): ChatSession => {
    const previousDraftId = draftSessionIdRef.current
    const next = createSession()
    activateLoadedSession(next)
    draftSessionIdRef.current = next.id
    setDraftSessionId(next.id)
    if (previousDraftId && previousDraftId !== next.id) {
      setDrafts((current) => removeDeletedSessionDraft(current, previousDraftId))
    }
    return next
  }, [activateLoadedSession])

  const selectSession = useCallback((sessionId: string) => {
    if (busy) {
      setNotice('请先停止当前回复，再切换会话。')
      return
    }
    if (sessionTransitionLockRef.current.locked) {
      setNotice('会话正在更新，请稍后再切换。')
      return
    }
    if (activeSessionIdRef.current === sessionId && sessionRef.current?.id === sessionId) return
    // Leaving an unsent draft abandons it; drop the marker first so the lazy
    // loader never mistakes its id for a durable conversation.
    const leavingDraftId = draftSessionIdRef.current
    if (leavingDraftId && activeSessionIdRef.current === leavingDraftId) {
      draftSessionIdRef.current = undefined
      setDraftSessionId(undefined)
      setDrafts((current) => removeDeletedSessionDraft(current, leavingDraftId))
    }
    invalidateSessionLoads()
    activeSessionIdRef.current = sessionId
    sessionRef.current = undefined
    setActiveSessionId(sessionId)
    setSession(undefined)
    if (window.innerWidth <= 900) setSidebarOpen(false)
  }, [busy, invalidateSessionLoads])

  const replaceSessionSummary = useCallback((nextSession: ChatSession) => {
    const summary = toSummary(nextSession)
    setSessions((current) => {
      const exists = current.some((item) => item.id === summary.id)
      const next = exists
        ? current.map((item) => item.id === summary.id ? summary : item)
        : [summary, ...current]
      sessionsRef.current = next
      return next
    })
  }, [])

  const persistSession = useCallback(async (nextSession: ChatSession) => {
    replaceSessionSummary(nextSession)
    if (!serviceAvailable) return
    try {
      await desktopGateway.saveSession(nextSession)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存会话失败')
    }
  }, [replaceSessionSummary, serviceAvailable])

  const openNewSession = useCallback(() => {
    if (busyRef.current) {
      setNotice('请先停止当前回复，再新建会话。')
      return
    }
    // Already composing an unsent draft: keep it instead of stacking a second
    // one; just surface the sidebar like any other new-session click would.
    if (draftSessionIdRef.current && activeSessionIdRef.current === draftSessionIdRef.current) {
      setSidebarOpen(window.innerWidth > 900)
      return
    }
    if (!beginSessionTransition()) {
      setNotice('会话正在更新，请稍后再新建。')
      return
    }
    try {
      startDraftSession()
      setSidebarOpen(window.innerWidth > 900)
    } finally {
      endSessionTransition()
    }
  }, [beginSessionTransition, endSessionTransition, setSidebarOpen, startDraftSession])

  useEffect(() => {
    const media = window.matchMedia(MOBILE_SIDEBAR_QUERY)
    const update = () => setCompactLayout(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  // Keep the global UI zoom in sync with the appearance setting.
  useEffect(() => {
    applyFontScale(settings.fontScale)
  }, [settings.fontScale])

  useEffect(() => {
    let cancelled = false
    const apply = (next: AppearanceState) => {
      if (cancelled) return
      setAppearance(next)
      setSettings((current) => ({ ...current, themeMode: next.themeMode }))
      applyAppearance(next)
    }
    void appearanceGateway.get()
      .then(apply)
      .catch((error: unknown) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : '读取应用主题失败')
      })
    const unsubscribe = appearanceGateway.subscribe(apply)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!serviceAvailable) return
    let cancelled = false
    void desktopGateway.getRuntimeInfo()
      .then((info) => { if (!cancelled) setRuntimeInfo(info) })
      .catch((error: unknown) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : '读取运行信息失败')
      })
    return () => { cancelled = true }
  }, [serviceAvailable])

  useLayoutEffect(() => {
    const dock = composerDockRef.current
    if (!dock) return
    const update = () => setComposerClearance(Math.ceil(dock.getBoundingClientRect().height))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [session?.id, showHero])

  useEffect(() => {
    if (!serviceAvailable) {
      // Offline: an unpersisted draft keeps the composer usable-looking while
      // the sidebar honestly shows that nothing exists yet.
      startDraftSession()
      setLoading(false)
      return
    }

    let cancelled = false
    const load = async () => {
      const [sessionResult, settingsResult, modelResult, statusResult] = await Promise.allSettled([
        desktopGateway.listSessions(),
        desktopGateway.getSettings(),
        desktopGateway.listModels(),
        desktopGateway.getNavisworksInstances()
      ])
      if (cancelled) return

      if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value)
      if (modelResult.status === 'fulfilled' && modelResult.value.length > 0) {
        setSettings((current) => ({
          ...current,
          models: Array.from(new Set([current.selectedModel, ...modelResult.value]))
        }))
      }
      if (statusResult.status === 'fulfilled') {
        setNavisworksConnection(statusResult.value)
        setNavisworks(statusFromConnection(statusResult.value))
      }

      if (sessionResult.status === 'fulfilled' && sessionResult.value.length > 0) {
        commitSessionSummaries(sessionResult.value)
      }

      // Cold start always lands on the centered new-conversation view, even
      // when saved conversations exist; entering one stays a sidebar choice.
      openNewSession()

      const firstFailure = [sessionResult, settingsResult, statusResult].find((result) => result.status === 'rejected')
      if (firstFailure?.status === 'rejected') {
        setNotice(firstFailure.reason instanceof Error ? firstFailure.reason.message : '部分桌面数据加载失败')
      }
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [commitSessionSummaries, openNewSession, serviceAvailable, startDraftSession])

  useEffect(() => {
    if (!serviceAvailable || !activeSessionId) return
    if (sessionRef.current?.id === activeSessionId) {
      setLoading(false)
      return
    }
    // A draft id has no durable row; fetching it would fail with
    // "会话不存在或已经删除。". Its content is already in memory.
    if (activeSessionId === draftSessionIdRef.current) {
      setLoading(false)
      return
    }
    const requestVersion = ++sessionLoadVersionRef.current
    setLoading(true)
    desktopGateway.getSession(activeSessionId)
      .then((loaded) => {
        if (!shouldApplySessionLoad(
          requestVersion,
          sessionLoadVersionRef.current,
          activeSessionId,
          activeSessionIdRef.current
        )) return
        sessionRef.current = loaded
        setSession(loaded)
        replaceSessionSummary(loaded)
      })
      .catch((error: unknown) => {
        if (shouldApplySessionLoad(
          requestVersion,
          sessionLoadVersionRef.current,
          activeSessionId,
          activeSessionIdRef.current
        )) setNotice(error instanceof Error ? error.message : '读取会话失败')
      })
      .finally(() => {
        if (requestVersion === sessionLoadVersionRef.current) setLoading(false)
      })
    return () => {
      if (requestVersion === sessionLoadVersionRef.current) invalidateSessionLoads()
    }
  }, [activeSessionId, invalidateSessionLoads, replaceSessionSummary, serviceAvailable])

  useEffect(() => {
    if (!serviceAvailable) return

    const applyChatEvent = (event: ChatStreamEvent) => {
      if (event.sessionId && event.sessionId !== activeSessionId) return
      const current = sessionRef.current
      if (!current) return
      const next = { ...current, messages: updateStreamMessage(current.messages, event) }
      sessionRef.current = next
      setSession(next)
      if (event.kind === 'done' || event.kind === 'error') {
        setBusy(false)
        setTurnId(undefined)
        setPendingToolApproval((current) => current?.sessionId === event.sessionId ? null : current)
        // A late completion for a session already removed from the list must
        // never resurrect it through sessions.save; only clear the run state.
        if (shouldPersistChatCompletion(sessionsRef.current, event.sessionId)) {
          void persistSession(next)
        }
      }
    }

    const unsubscribers = [
      desktopGateway.subscribe('chat.chunk', (event) => applyChatEvent(event as ChatStreamEvent)),
      desktopGateway.subscribe('chat.done', (event) => {
        const done = event as ChatStreamEvent
        if (typeof done.contextTokensUsed === 'number') {
          setContextUsage({
            used: done.contextTokensUsed,
            ...(typeof done.contextWindowTokens === 'number' ? { window: done.contextWindowTokens } : {}),
            ...(typeof done.cacheHitRate === 'number' ? { cacheHitRate: done.cacheHitRate } : {})
          })
        }
        if (done.compacted) {
          setNotice('上下文已接近上限，早期过程已自动压缩为摘要')
        }
        applyChatEvent(done)
      }),
      desktopGateway.subscribe('chat.error', (event) => applyChatEvent(event as ChatStreamEvent)),
      desktopGateway.subscribe('tool.approval.requested', (event) => {
        const approval = event as ToolApprovalRequest
        if (approval.sessionId === activeSessionIdRef.current) setPendingToolApproval(approval)
      }),
      desktopGateway.subscribe('navisworks.instances.changed', (event) => {
        const state = event as NavisworksConnectionState
        setNavisworksConnection(state)
        setNavisworks(statusFromConnection(state))
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [activeSessionId, persistSession, serviceAvailable])

  // Context-ring data: the finished run's token usage feeds the composer's
  // usage ring; switching sessions clears it until the next reply lands.
  useEffect(() => {
    setContextUsage(null)
  }, [activeSessionId])

  // Escape dismisses the in-app delete confirmation; clicking the dimmed
  // backdrop cancels too.
  useEffect(() => {
    if (!pendingDeleteSession) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPendingDeleteSession(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingDeleteSession])

  const setDraft = (value: string) => {
    if (!activeSessionId) return
    setDrafts((current) => ({ ...current, [activeSessionId]: value }))
  }

  /**
   * Swaps the first-send truncation label for a model-summarized title.
   * Guards against switching away mid-request; chat streaming merges through
   * sessionRef so a concurrent reply stream cannot clobber the new title.
   */
  const applySummarizedTitle = async (sessionId: string, firstMessage: string) => {
    try {
      const suggested = await desktopGateway.suggestSessionTitle(firstMessage)
      if (activeSessionIdRef.current !== sessionId || sessionRef.current?.id !== sessionId) return
      const target = sessionRef.current
      if (!target || target.title === suggested) return
      const retitled = { ...target, title: suggested }
      sessionRef.current = retitled
      setSession(retitled)
      void persistSession(retitled)
    } catch {
      // Silent: the truncation label is already a usable fallback.
    }
  }

  const sendText = async (text: string) => {
    const trimmed = text.trim()
    const current = sessionRef.current
    if (!trimmed || busy || !serviceAvailable) return
    if (sessionTransitionLockRef.current.locked) {
      setNotice('会话正在更新，请稍后再发送。')
      return
    }
    if (!isSessionReadyForSend(current, activeSessionIdRef.current)) {
      setNotice('当前会话仍在加载，请稍后再发送。')
      return
    }

    const now = new Date().toISOString()
    const userMessage: ChatMessage = {
      id: createId(), role: 'user', content: trimmed, createdAt: now, tools: []
    }
    const assistantMessage: ChatMessage = {
      id: createId(), role: 'assistant', content: '', createdAt: now, transient: true, tools: []
    }
    const nextSession: ChatSession = {
      ...current,
      title: current.messages.length === 0 ? trimmed.slice(0, 28) : current.title,
      preview: trimmed.slice(0, 80),
      updatedAt: now,
      messages: [...current.messages, userMessage, assistantMessage]
    }

    setSession(nextSession)
    sessionRef.current = nextSession
    setDraft('')
    setBusy(true)
    setNotice('')
    // First send of an unsent draft establishes the real session: clearing
    // the marker lets the persist below both list it in the sidebar and
    // write it to disk.
    if (draftSessionIdRef.current === current.id) {
      draftSessionIdRef.current = undefined
      setDraftSessionId(undefined)
    }
    void persistSession(nextSession)

    // The truncated send text is only a placeholder label; ask the model to
    // retitle once the first message lands. Best-effort — on failure the
    // truncation simply stays.
    if (current.messages.length === 0) {
      void applySummarizedTitle(current.id, trimmed)
    }

    try {
      const started = await desktopGateway.startChat({
        sessionId: current.id,
        messageId: userMessage.id,
        text: trimmed,
        model: settings.selectedModel,
        reasoningMode: settings.reasoningMode
      })
      setTurnId(started.turnId)
    } catch (error) {
      const failedEvent: ChatStreamEvent = {
        sessionId: current.id,
        messageId: assistantMessage.id,
        kind: 'error',
        error: error instanceof Error ? error.message : '无法开始生成'
      }
      const failed = { ...nextSession, messages: updateStreamMessage(nextSession.messages, failedEvent) }
      sessionRef.current = failed
      setSession(failed)
      setBusy(false)
      setNotice(eventErrorMessage(failedEvent.error))
      void persistSession(failed)
    }
  }

  const stop = async () => {
    if (!activeSessionId || !busy) return
    try {
      await desktopGateway.abortChat(activeSessionId, turnId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '停止生成失败')
    }
  }

  const resolveToolApproval = async (decision: 'confirm' | 'cancel') => {
    const approval = pendingToolApproval
    if (!approval || approvalResolving) return
    setApprovalResolving(true)
    try {
      const resolved = await desktopGateway.resolveToolApproval(approval.approvalId, decision)
      if (!resolved) setNotice('该操作确认已经失效。')
      setPendingToolApproval((current) => current?.approvalId === approval.approvalId ? null : current)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法提交操作确认')
    } finally {
      setApprovalResolving(false)
    }
  }

  const requestDeleteSession = (sessionId: string) => {
    if (busyRef.current) {
      setNotice('请先停止当前回复，再删除会话。')
      return
    }
    const target = sessionsRef.current.find((item) => item.id === sessionId)
    if (!target) return
    setPendingDeleteSession(target)
  }

  const deleteSession = async (sessionId: string) => {
    // Confirmation already happened in-app via pendingDeleteSession; native
    // dialogs are off-limits because Electron's window.confirm() leaves the
    // renderer unable to focus inputs afterwards.
    if (!sessionsRef.current.some((item) => item.id === sessionId)) return
    if (sessionTransitionLockRef.current.locked) {
      setNotice('会话正在更新，请稍后再删除。')
      return
    }
    if (!beginSessionTransition()) return
    setDeletingSessionId(sessionId)
    try {
      const plan = serviceAvailable
        ? await planAfterDurableSessionDeletion(
          () => desktopGateway.deleteSession(sessionId),
          () => sessionsRef.current,
          () => activeSessionIdRef.current,
          sessionId
        )
        : planSessionDeletion(sessionsRef.current, activeSessionIdRef.current, sessionId)
      if (!plan.deletedActiveSession) {
        setDrafts((current) => removeDeletedSessionDraft(current, sessionId))
        commitSessionSummaries(plan.remaining)
        return
      }

      // The deleted conversation was on screen: land on a fresh draft (the
      // new-conversation view) instead of auto-jumping into some other
      // conversation. Everything past the plan is synchronous, so the
      // transition lock already covers the whole swap.
      invalidateSessionLoads()
      sessionRef.current = undefined
      setSession(undefined)
      const nextFocus = createSession()
      draftSessionIdRef.current = nextFocus.id
      setDraftSessionId(nextFocus.id)
      // A draft never appears in the sidebar; the surviving rows are the
      // whole list.
      commitSessionSummaries(plan.remaining)
      setDrafts((current) => removeDeletedSessionDraft(current, sessionId, nextFocus.id))
      activateLoadedSession(nextFocus)
      setLoading(false)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除会话失败')
      // The durable delete failed: re-sync with the disk so the sidebar cannot
      // keep showing a state that never landed, while keeping the selection.
      await reconcileSessionsFromDisk()
    } finally {
      setDeletingSessionId(undefined)
      endSessionTransition()
    }
  }

  const confirmPendingDelete = async () => {
    const target = pendingDeleteSession
    setPendingDeleteSession(null)
    if (!target) return
    await deleteSession(target.id)
  }

  const togglePinned = async (sessionId: string) => {
    if (busyRef.current) {
      setNotice('请先停止当前回复，再更新会话。')
      return
    }
    if (!beginSessionTransition()) {
      setNotice('会话正在更新，请稍后再固定。')
      return
    }
    try {
      const summary = sessions.find((item) => item.id === sessionId)
      if (!summary) return
      const pinnedAt = summary.pinnedAt ? null : new Date().toISOString()
      setSessions((current) => current.map((item) => item.id === sessionId ? { ...item, pinnedAt } : item))
      if (session?.id === sessionId) {
        const next = { ...session, pinnedAt }
        setSession(next)
        await persistSession(next)
        return
      }
      if (serviceAvailable) {
        try {
          const loaded = await desktopGateway.getSession(sessionId)
          await persistSession({ ...loaded, pinnedAt })
        } catch (error) {
          setNotice(error instanceof Error ? error.message : '固定会话失败')
        }
      }
    } finally {
      endSessionTransition()
    }
  }

  const updateSettings = async (next: DesktopSettings) => {
    setSettings(next)
    if (!serviceAvailable) return
    try {
      const saved = await desktopGateway.updateSettings(next)
      setSettings(saved)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存模型设置失败')
    }
  }

  const updateAppearance = async (themeMode: ThemeMode) => {
    try {
      const next = await appearanceGateway.update(themeMode)
      setAppearance(next)
      applyAppearance(next)
      setSettings((current) => ({ ...current, themeMode: next.themeMode }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存应用主题失败')
    }
  }

  const refreshModels = async () => {
    try {
      // Always the LOCAL Ollama list: the model dropdown selects the local
      // worker regardless of the active API endpoint configuration.
      const models = await desktopGateway.listModels()
      if (models.length === 0) {
        setNotice('Ollama 当前没有可用模型。')
        return
      }
      const next = {
        ...settings,
        models: Array.from(new Set([settings.selectedModel, ...models]))
      }
      await updateSettings(next)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '刷新 Ollama 模型失败')
    }
  }

  const testApiProfile = async (profileId: string): Promise<{ connected: boolean; message: string }> => {
    const started = Date.now()
    try {
      const result = await desktopGateway.testApiProfile(profileId)
      setCloudLatency({ ok: result.connected, ms: Date.now() - started })
      if (!result.connected) setNotice(result.message)
      return result
    } catch (error) {
      setCloudLatency({ ok: false, ms: Date.now() - started })
      setNotice(error instanceof Error ? error.message : '云端连接测试失败')
      throw error
    }
  }

  // Manual /compact: summarize the active session's transcript and replace
  // it, so the next message starts on a light context.
  const runCompact = async () => {
    const sessionId = activeSessionId
    if (!sessionId || busy || !serviceAvailable) return
    setBusy(true)
    try {
      const { summary } = await desktopGateway.compactSession(sessionId)
      if (!summary) {
        setNotice('当前会话还没有可压缩的内容')
        return
      }
      setSession(await desktopGateway.getSession(sessionId))
      setNotice('已压缩当前会话上下文')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '压缩上下文失败')
    } finally {
      setBusy(false)
    }
  }

  const refreshNavisworks = async () => {
    try {
      const state = await desktopGateway.getNavisworksInstances()
      setNavisworksConnection(state)
      setNavisworks(statusFromConnection(state))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '刷新 Navisworks 状态失败')
    }
  }

  const selectNavisworksInstance = async (instanceId: string) => {
    if (busy || navisworksConnection.runningInstanceId) return
    try {
      const state = await desktopGateway.selectNavisworksInstance(instanceId)
      setNavisworksConnection(state)
      setNavisworks(statusFromConnection(state))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '切换 Navisworks 实例失败')
    }
  }

  /**
   * Re-runs the last prompt. sendText always APPENDS a fresh user+assistant
   * pair, so the previous attempt — the prompt and everything after it — is
   * dropped first; otherwise every retry stacks another copy of the same
   * question in the transcript.
   */
  const retryLast = () => {
    const current = sessionRef.current
    if (!current || busy) return
    let lastUserIndex = -1
    for (let index = current.messages.length - 1; index >= 0; index -= 1) {
      if (current.messages[index]?.role === 'user') {
        lastUserIndex = index
        break
      }
    }
    const lastUser = current.messages[lastUserIndex]
    if (!lastUser) return
    const truncated = { ...current, messages: current.messages.slice(0, lastUserIndex) }
    sessionRef.current = truncated
    setSession(truncated)
    void sendText(lastUser.content)
  }

  return (
    <div
      className="app-shell"
      data-session-transitioning={sessionTransitioning}
      data-deleting-session={deletingSessionId}>
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        open={sidebarOpen}
        busy={busy || sessionTransitioning}
        onClose={() => setSidebarOpen(false)}
        onCreate={openNewSession}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onSelect={selectSession}
        onTogglePinned={(id) => void togglePinned(id)}
        onDelete={requestDeleteSession}
      />

      <main className="chat-pane">
        <header className="chat-header">
          <button
            className="icon-button sidebar-toggle"
            type="button"
            aria-expanded={sidebarOpen}
            aria-controls="conversation-sidebar"
            onClick={() => setSidebarOpen((current) => !current)}
            aria-label={sidebarOpen ? '收起会话栏' : '打开会话栏'}>
            {sidebarOpen ? <PanelLeftClose aria-hidden="true" size={18} /> : <PanelLeftOpen aria-hidden="true" size={18} />}
          </button>
          {showHero ? null : (
            <div className="chat-title">
              <h1>{session?.title || '新会话'}</h1>
            </div>
          )}
          <div className="header-actions">
            <div className="navisworks-status" data-connected={navisworks.connected} role="status">
              <span className="status-dot" />
              <Box aria-hidden="true" size={14} />
              <span className="status-copy">
                {navisworksConnection.instances.length > 1 ? (
                  <button
                    type="button"
                    className="navisworks-instance-trigger"
                    disabled={busy || navisworksConnection.runningInstanceId !== undefined}
                    aria-haspopup="true"
                    aria-expanded={navisworksMenuOpen}
                    onClick={() => setNavisworksMenuOpen((current) => !current)}>
                    <strong>
                      {(() => {
                        const selected = navisworksConnection.instances.find(
                          (instance) => instance.instanceId === navisworksConnection.selectedInstanceId
                        )
                        return selected
                          ? `${selected.documentName ?? '未命名文档'} · PID ${selected.processId}`
                          : 'Navisworks'
                      })()}
                    </strong>
                    <ChevronDown aria-hidden="true" size={12} />
                  </button>
                ) : (
                  <strong>{navisworks.documentName ?? (navisworks.connected ? 'Navisworks 已连接' : 'Navisworks 未连接')}</strong>
                )}
                {(() => {
                  const selected = navisworksConnection.instances.find(
                    (instance) => instance.instanceId === navisworksConnection.selectedInstanceId
                  )
                  if (!selected) return null
                  return (
                    <small>
                      {navisworksConnection.runningInstanceId === selected.instanceId
                        ? '正在使用'
                        : `Navisworks ${selected.hostVersion} · PID ${selected.processId}`}
                    </small>
                  )
                })()}
              </span>

              {navisworksConnection.instances.length > 1 && navisworksMenuOpen ? (
                <div className="navisworks-instance-menu">
                  {navisworksConnection.instances.map((instance) => {
                    const isSelected = instance.instanceId === navisworksConnection.selectedInstanceId
                    const isDisconnected = !instance.connected
                    return (
                      <button
                        key={instance.instanceId}
                        type="button"
                        className="instance-menu-item"
                        data-selected={isSelected}
                        data-disconnected={isDisconnected}
                        disabled={isDisconnected || busy || navisworksConnection.runningInstanceId !== undefined}
                        title={isDisconnected ? '已断开连接，无法切换' : undefined}
                        onClick={() => {
                          if (!isDisconnected) {
                            void selectNavisworksInstance(instance.instanceId)
                            setNavisworksMenuOpen(false)
                          }
                        }}>
                        <span className="instance-menu-item-title">
                          {instance.documentName ?? '未命名文档'}
                        </span>
                        <span className="instance-menu-item-meta">
                          PID {instance.processId}
                          {isDisconnected ? ' · 已断开' : ''}
                        </span>
                        {isSelected && !isDisconnected ? <Check aria-hidden="true" size={14} /> : null}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    className="instance-menu-action"
                    disabled={busy}
                    onClick={() => {
                      void refreshNavisworks()
                      setNavisworksMenuOpen(false)
                    }}>
                    <RefreshCw aria-hidden="true" size={14} className={busy ? 'running' : undefined} />
                    刷新实例列表
                  </button>
                </div>
              ) : null}

              {navisworksMenuOpen ? (
                <button
                  type="button"
                  className="navisworks-menu-backdrop"
                  aria-label="关闭实例菜单"
                  onClick={() => setNavisworksMenuOpen(false)}
                />
              ) : null}
            </div>
          </div>
        </header>

        <div className="chat-stage" data-hero={showHero ? 'true' : 'false'}>
          {loading ? (
            <div className="loading-state" role="status">
              <RefreshCw aria-hidden="true" className="running" size={18} />
              正在加载会话…
            </div>
          ) : showHero ? null : (
            <MessageList
              messages={session?.messages ?? []}
              sessionTitle={session?.title}
              composerClearance={composerClearance}
              onRetryLast={busy ? undefined : retryLast}
            />
          )}

          <Composer
            dockRef={composerDockRef}
            variant={showHero ? 'hero' : 'docked'}
            draft={draft}
            busy={busy}
            settings={settings}
            serviceAvailable={serviceAvailable}
            contextUsage={contextUsage}
            approval={pendingToolApproval}
            approvalResolving={approvalResolving}
            onDraftChange={setDraft}
            onSend={() => void sendText(draft)}
            onStop={() => void stop()}
            onResolveApproval={(decision) => void resolveToolApproval(decision)}
            onModelChange={(selectedModel) => void updateSettings({ ...settings, selectedModel, preferApiModel: false })}
            onApiModelPick={(activeApiProfileId) => void updateSettings({ ...settings, activeApiProfileId, preferApiModel: true })}
            onSlashCommand={(cmd) => { if (cmd === 'compact') void runCompact() }}
            onReasoningChange={(reasoningMode) => void updateSettings({ ...settings, reasoningMode })}
          />

        </div>
      </main>

      {searchOpen ? (
        <SearchOverlay
          sessions={sessions}
          activeSessionId={activeSessionId}
          onClose={() => setSearchOpen(false)}
          onSelect={selectSession}
        />
      ) : null}

      {/* Toast floats above every overlay (settings included) and dismisses
          itself after 3 seconds - no manual close. */}
      {notice ? (
        <div className="notice-toast" role="status">
          <CircleAlertIcon />
          <span>{notice}</span>
        </div>
      ) : null}

      {pendingDeleteSession ? (
        <div className="confirm-overlay" role="presentation" onClick={() => setPendingDeleteSession(null)}>
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-title"
            aria-describedby="confirm-delete-copy"
            onClick={(event) => event.stopPropagation()}>
            <h2 id="confirm-delete-title">删除会话</h2>
            <p id="confirm-delete-copy">
              确定删除“{pendingDeleteSession.title || '新会话'}”吗？此操作无法撤销。
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="secondary-button"
                autoFocus
                onClick={() => setPendingDeleteSession(null)}>
                取消
              </button>
              <button type="button" className="danger-button" onClick={() => void confirmPendingDelete()}>
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        themeMode={appearance.themeMode}
        navisworks={navisworks}
        serviceAvailable={serviceAvailable}
        diagnostics={runtimeInfo ? {
          dataDirectory: runtimeInfo.dataDirectory,
          runtime: `${runtimeInfo.version} · ${runtimeInfo.platform} · ${runtimeInfo.profile}${runtimeInfo.isPackaged ? ' · 已打包' : ' · 开发版'}`
        } : undefined}
        onClose={() => setSettingsOpen(false)}
        onThemeModeChange={updateAppearance}
        onFontScaleChange={(fontScale) => updateSettings({ ...settings, fontScale })}
        onProviderChange={(patch) => updateSettings({ ...settings, ...patch })}
        onSaveApiProfile={async (profile) => {
          const saved = await desktopGateway.saveApiProfile(profile)
          setSettings(saved)
          return saved
        }}
        onDeleteApiProfile={async (profileId) => {
          const saved = await desktopGateway.deleteApiProfile(profileId)
          setSettings(saved)
          return saved
        }}
        onModelChange={(selectedModel) => updateSettings({ ...settings, selectedModel, preferApiModel: false })}
        onDisabledToolsChange={(disabledTools) => updateSettings({ ...settings, disabledTools })}
        onRefreshModels={refreshModels}
        onFetchCloudModels={(profileId) => desktopGateway.listApiProfileModels(profileId)}
        cloudLatency={cloudLatency}
        onNotice={setNotice}
        onTestApiProfile={testApiProfile}
        onRefreshNavisworks={refreshNavisworks}
      />
    </div>
  )
}

function CircleAlertIcon() {
  return <span aria-hidden="true" className="notice-icon">!</span>
}
