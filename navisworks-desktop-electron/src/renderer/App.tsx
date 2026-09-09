import { Box, Check, ChevronDown, RefreshCw } from 'lucide-react'
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
import { nearestReasoningEffort } from '../shared/reasoning'
import {
  type ChatMessage,
  type ChatRunPhase,
  type QuestionAnswer,
  type QuestionRequest,
  type ModelInfo,
  type ModelRef,
  type ModelUsage,
  type ToolDefinitionSummary,
  type ChatSession,
  type ChatStreamEvent,
  type ContextWindowSource,
  type DesktopSettings,
  type NavisworksStatus,
  type SessionSummary,
  type ToolApprovalRequest,
  createId,
  navisworksInstanceDisplay,
  navisworksStatusBadge,
  normalizeModelUsage
} from './chatTypes'
import { Composer } from './Composer'
import { QuestionCard } from './QuestionCard'
import {
  routeChatEventSession,
  shouldApplyContextUsage,
} from './sessionLifecycle'
import { appearanceGateway, applyAppearance, applyFontScale } from './appearance'
import { installAppTooltip } from './appTooltip'
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
import { TitleBar } from './TitleBar'
import { SearchOverlay } from './SearchOverlay'
import { SettingsPanel, type SettingsPageId } from './SettingsPanel'
import { DEFAULT_EXECUTION_SETTINGS, DEFAULT_STORAGE_SETTINGS } from '../shared/ipc'
import {
  deriveNavisworksRebindState,
  navisworksRebindStateKey,
} from './navisworksConnection'

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
  activeApiProfileId: null,
  toolPermissions: {},
  execution: DEFAULT_EXECUTION_SETTINGS,
  storage: DEFAULT_STORAGE_SETTINGS,
  modelConfigurations: []
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
    status: selected.connected ? selected.documentName ?? '已连接' : '当前选择的 Navisworks 已断开',
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
  // Registry tool summaries for the 工具与权限 page (single source: main).
  const [toolDefinitions, setToolDefinitions] = useState<ToolDefinitionSummary[]>([])
  const refreshToolDefinitions = useCallback(() => {
    if (!serviceAvailable) return
    void desktopGateway.listTools()
      .then((summaries) => setToolDefinitions(summaries))
      .catch(() => setToolDefinitions([]))
  }, [serviceAvailable])
  const [contextUsage, setContextUsage] = useState<{
    used: number
    window?: number
    source?: ContextWindowSource
    /** Model Configuration v2 (§31): the run's model identity; a stale window is
     *  ignored when the active model differs. */
    modelRef?: ModelRef
    usage?: ModelUsage
    cacheHitRate?: number
  } | null>(null)
  // P8: the ACTIVE model as resolved by the main-process Model System.
  // Never derived in the renderer — this is the one copy the UI reads.
  const [activeModel, setActiveModel] = useState<ModelInfo | null>(null)
  const refreshActiveModel = useCallback(() => {
    if (!serviceAvailable) return
    void desktopGateway.getActiveModel()
      .then((info) => setActiveModel(info))
      .catch(() => setActiveModel(null))
  }, [serviceAvailable])
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo>()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // A structured run record instead of a boolean: it names WHICH session is
  // running and WHAT phase it is in, so switching to another session never
  // loses track of the background run (and its stop button stays scoped).
  const [activeRun, setActiveRun] = useState<{
    sessionId: string
    turnId?: string
    phase: ChatRunPhase
  } | null>(null)
  const abortWatchdogRef = useRef<number | undefined>(undefined)
  // Freshest in-memory copy of every session with stream activity — events for
  // a BACKGROUND session update this cache instead of the screen, and are
  // persisted + shown when the user navigates back.
  const inflightSessionsRef = useRef(new Map<string, ChatSession>())
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia(MOBILE_SIDEBAR_QUERY).matches)
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Settings category picked in the sidebar's list; survives close/reopen.
  const [settingsPage, setSettingsPage] = useState<SettingsPageId>('appearance')
  // Chat-search overlay, scoped to the conversation pane (see SearchOverlay).
  const [searchOpen, setSearchOpen] = useState(false)
  // In-app delete confirmation target. Native dialogs are off-limits:
  // Electron's window.confirm() leaves the renderer unable to focus inputs.
  const [pendingDeleteSession, setPendingDeleteSession] = useState<SessionSummary | null>(null)
  const [pendingToolApproval, setPendingToolApproval] = useState<ToolApprovalRequest | null>(null)
  const [approvalResolving, setApprovalResolving] = useState(false)
  // P16: the session's pending question (process-memory mirror of main's
  // registry). Kept session-scoped: switching windows never cancels it — on
  // return, question.pending.list(sessionId) re-attaches the card (§18).
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null)
  const [questionResolving, setQuestionResolving] = useState(false)
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
  // Global tooltip: one body-level fixed node backs every [data-tip] control
  // (replacing the native OS title bubble). Installed once for the app session.
  useEffect(() => installAppTooltip(), [])
  const [composerClearance, setComposerClearance] = useState(176)
  const composerDockRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<ChatSession | undefined>(undefined)
  const sessionsRef = useRef<SessionSummary[]>([])
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const draftSessionIdRef = useRef<string | undefined>(undefined)
  const sessionLoadVersionRef = useRef(0)
  const sessionTransitionLockRef = useRef(new SessionTransitionLock())
  const busyRef = useRef(false)
  const activeRunRef = useRef<{
    sessionId: string
    turnId?: string
    phase: ChatRunPhase
  } | null>(null)

  const draft = activeSessionId ? drafts[activeSessionId] ?? '' : ''
  sessionRef.current = session
  sessionsRef.current = sessions
  activeSessionIdRef.current = activeSessionId
  // Any-run guard for non-session-scoped controls (delete/rename/compact stay
  // locked while a background run is live). Session-scoped UI derives from
  // activeRun directly.
  const busy = activeRun !== null
  const activeSessionBusy = activeRun?.sessionId === activeSessionId
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
    // Switching/VIEWING another session is always allowed now: background run
    // events keep updating the originating session's cache (and are persisted
    // on completion). Only STARTING a second run is blocked (sendText).
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
        // An inflight (streaming) copy is always fresher than the disk row —
        // switching BACK to a running session must show the streamed content.
        const resolved = inflightSessionsRef.current.get(activeSessionId) ?? loaded
        sessionRef.current = resolved
        setSession(resolved)
        if (resolved) replaceSessionSummary(resolved)
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
      const targetId = event.sessionId
      if (!targetId) return
      // Phase events steer the run indicator only; they never touch messages.
      if (event.kind === 'phase') {
        console.debug(`[chat-ui] PHASE session=${targetId} phase=${event.phase}`)
        setActiveRun((current) => current?.sessionId === targetId
          ? { ...current, phase: event.phase ?? 'generating' }
          : current)
        return
      }
      // Split "update the run's session data" from "update the screen": a
      // background session's chunks go to the inflight cache, the active
      // session's go to the screen AND the cache.
      const isActive = routeChatEventSession(event, activeSessionIdRef.current) === 'screen'
      const base = isActive && sessionRef.current?.id === targetId
        ? sessionRef.current
        : inflightSessionsRef.current.get(targetId)
      if (!base) return
      const next = { ...base, messages: updateStreamMessage(base.messages, event) }
      if (isActive) {
        sessionRef.current = next
        setSession(next)
      }
      inflightSessionsRef.current.set(targetId, next)
      if (event.kind === 'done' || event.kind === 'error') {
        console.debug(`[chat-ui] ${event.kind === 'done' ? 'DONE_RECEIVED' : 'ERROR_RECEIVED'} session=${targetId}`)
        if (abortWatchdogRef.current !== undefined) {
          window.clearTimeout(abortWatchdogRef.current)
          abortWatchdogRef.current = undefined
        }
        setActiveRun((current) => current?.sessionId === targetId ? null : current)
        setPendingToolApproval((current) => current?.sessionId === targetId ? null : current)
        setPendingQuestion((current) => current?.sessionId === targetId ? null : current)
        // A late completion for a session already removed from the list must
        // never resurrect it through sessions.save; only clear the run state.
        // Persisting also refreshes the sidebar summary for background runs.
        if (shouldPersistChatCompletion(sessionsRef.current, targetId)) {
          void persistSession(next)
        }
      }
    }

    const unsubscribers = [
      desktopGateway.subscribe('chat.chunk', (event) => applyChatEvent(event as ChatStreamEvent)),
      desktopGateway.subscribe('chat.done', (event) => {
        const done = event as ChatStreamEvent
        // The context ring is session-scoped: a BACKGROUND session finishing
        // must never repaint the ring of the session on screen.
        if (shouldApplyContextUsage(done.sessionId, activeSessionIdRef.current)) {
          // P6: the raw usage object rides along for the detail lines —
          // re-validated, because event payloads are runtime data.
          const doneUsage = normalizeModelUsage(done.usage)
          if (typeof done.contextTokensUsed === 'number') {
            setContextUsage({
              used: done.contextTokensUsed,
              ...(typeof done.contextWindowTokens === 'number' ? { window: done.contextWindowTokens } : {}),
              ...(typeof done.contextWindowSource === 'string' ? { source: done.contextWindowSource } : {}),
              // §31: tag the reported window/usage with the model that produced it.
              ...(done.modelRef !== undefined ? { modelRef: done.modelRef } : {}),
              ...(doneUsage === undefined ? {} : { usage: doneUsage }),
              ...(typeof done.cacheHitRate === 'number' ? { cacheHitRate: done.cacheHitRate } : {})
            })
          }
          if (done.compacted) {
            setNotice('上下文已接近上限，早期过程已自动压缩为摘要')
          }
        }
        applyChatEvent(done)
      }),
      desktopGateway.subscribe('chat.error', (event) => applyChatEvent(event as ChatStreamEvent)),
      desktopGateway.subscribe('tool.approval.requested', (event) => {
        const approval = event as ToolApprovalRequest
        // Single global run: keep the approval no matter which session the user
        // is viewing — dropping it would leave the run waiting forever.
        setPendingToolApproval(approval)
        if (approval.sessionId !== activeSessionIdRef.current) {
          const title = sessionsRef.current.find((item) => item.id === approval.sessionId)?.title ?? '后台会话'
          setNotice(`会话「${title}」正在请求工具确认，请在输入区上方处理。`)
        }
      }),
      desktopGateway.subscribe('question.requested', (event) => {
        const question = event as unknown as QuestionRequest
        // Mirror approvals: keep the pending question no matter which session
        // is on screen; the card only renders for the ACTIVE session.
        setPendingQuestion(question)
        if (question.sessionId !== activeSessionIdRef.current) {
          const title = sessionsRef.current.find((item) => item.id === question.sessionId)?.title ?? '后台会话'
          setNotice(`会话「${title}」在等你回答，切回该会话继续处理。`)
        }
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

  // P16 §18: re-attach this session's pending question after a switch. The
  // card must NOT rely on having caught the question.requested event live.
  useEffect(() => {
    if (!serviceAvailable || activeSessionId === undefined) return
    let stale = false
    void desktopGateway.listPendingQuestions(activeSessionId)
      .then((pending) => {
        if (stale) return
        setPendingQuestion((current) => {
          if (pending.length > 0) return pending[0] ?? null
          // This session has nothing pending: only clear a question that
          // belongs HERE, never one another session is still awaiting.
          return current === null || current.sessionId === activeSessionId ? null : current
        })
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [activeSessionId, serviceAvailable])

  // Tool registry summaries must re-resolve whenever settings change:
  // permissions shown in the 工具与权限 page always mirror the latest state.
  useEffect(() => {
    refreshToolDefinitions()
  }, [refreshToolDefinitions, settings.toolPermissions, settings.disabledTools])

  // P8: the active model re-resolves whenever anything that routes it changes
  // — provider switches, profile edits, model picks, profile deletion. Model
  // Configuration v2 (§29): a saved per-model override also changes the resolved
  // window, so modelConfigurations is in the deps — save → re-resolve → ring
  // refreshes WITHOUT a restart or a new message.
  useEffect(() => {
    refreshActiveModel()
  }, [
    refreshActiveModel,
    settings.selectedModel,
    settings.preferApiModel,
    settings.activeApiProfileId,
    settings.ollamaEnabled,
    settings.apiEnabled,
    settings.apiProfiles,
    settings.modelConfigurations,
  ])

  // §32: when the active model's identity OR its known context window changes
  // (model switch / saved override), a run-reported window/usage from the
  // previous model is stale — drop it so it can never contaminate the ring. The
  // ring then shows the CURRENT activeModel window immediately (§33/Case B).
  const modelWindowKey = activeModel === null
    ? ''
    : `${activeModel.ref.providerId} ${activeModel.ref.modelId} ${activeModel.limits.context ?? ''}`
  const lastModelWindowKey = useRef(modelWindowKey)
  useEffect(() => {
    if (lastModelWindowKey.current !== modelWindowKey) {
      lastModelWindowKey.current = modelWindowKey
      setContextUsage(null)
    }
  }, [modelWindowKey])

  // P7: after switching models, a persisted step outside the new model's
  // allowed modes snaps to the nearest legal one — the UI never shows (and
  // chat.start never sends) an illegal step. No write until the user acts.
  const allowedReasoningModes = activeModel?.reasoning.modes
  const effectiveReasoningMode = allowedReasoningModes === undefined
    ? settings.reasoningMode
    : nearestReasoningEffort(settings.reasoningMode, allowedReasoningModes) ?? settings.reasoningMode

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
    // One global Agent Run at a time (Navisworks safety): starting a second
    // one is refused with a clear hint — browsing/drafting elsewhere is free.
    if (activeRunRef.current) {
      setNotice(activeRunRef.current.sessionId === activeSessionIdRef.current
        ? '请等待当前回复完成，或先停止。'
        : '另一个会话正在执行，请等待完成或先停止。')
      return
    }
    if (!trimmed || !serviceAvailable) return
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
    setActiveRun({ sessionId: current.id, phase: 'generating' })
    inflightSessionsRef.current.set(current.id, nextSession)
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
        // P7: send the mode snapped to the active model's legal steps, so an
        // illegal persisted value can never reach the request schema.
        reasoningMode: effectiveReasoningMode
      })
      setActiveRun((currentRun) => currentRun?.sessionId === current.id
        ? { ...currentRun, turnId: started.turnId }
        : currentRun)
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
      setActiveRun((currentRun) => currentRun?.sessionId === current.id ? null : currentRun)
      inflightSessionsRef.current.delete(current.id)
      setNotice(eventErrorMessage(failedEvent.error))
      void persistSession(failed)
    }
  }

  const stop = async () => {
    const run = activeRunRef.current
    // The stop button only renders for the ACTIVE session's run, so this can
    // never abort a background session by mistake.
    if (!run || run.sessionId !== activeSessionId) return
    try {
      await desktopGateway.abortChat(run.sessionId, run.turnId)
      // An aborted run's pending question is rejected in main (§20) — clear
      // the mirror so the card cannot outlive its run.
      setPendingQuestion((current) => current?.sessionId === run.sessionId ? null : current)
      // Watchdog: if the main process somehow never delivers the terminal
      // event, reset the run state so the UI cannot stay stuck on 停止.
      if (abortWatchdogRef.current !== undefined) window.clearTimeout(abortWatchdogRef.current)
      abortWatchdogRef.current = window.setTimeout(() => {
        if (activeRunRef.current?.sessionId === run.sessionId) {
          console.debug(`[chat-ui] ABORT_WATCHDOG session=${run.sessionId}`)
          setActiveRun(null)
          setNotice('停止操作未及时确认，已重置运行状态。')
        }
      }, 15_000)
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

  /**
   * Submit / decline the active question. `resolved=false` means the run
   * already ended (stale card) — drop it silently like an expired approval.
   */
  const resolveQuestion = async (answers: readonly QuestionAnswer[] | null) => {
    const question = pendingQuestion
    if (!question || questionResolving) return
    setQuestionResolving(true)
    try {
      const resolved = answers === null
        ? await desktopGateway.rejectQuestions(question.requestId)
        : await desktopGateway.answerQuestions(question.requestId, answers)
      if (!resolved) setNotice('该问题已失效（运行可能已结束）。')
      setPendingQuestion((current) => current?.requestId === question.requestId ? null : current)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法提交回答')
    } finally {
      setQuestionResolving(false)
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
    setActiveRun({ sessionId, phase: 'generating' })
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
      setActiveRun((currentRun) => currentRun?.sessionId === sessionId ? null : currentRun)
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

  // Stale-target rebind UX: discovery never switches the explicit target, so
  // the UI must tell the user the old target is gone and (when candidates
  // exist) open the instance menu for an explicit re-selection.
  const navisworksRebindState = deriveNavisworksRebindState(navisworksConnection)
  const navisworksRebindKey = navisworksRebindStateKey(navisworksRebindState)
  const lastRebindKeyRef = useRef<string>('none')
  useEffect(() => {
    if (navisworksRebindState.kind === 'none') {
      lastRebindKeyRef.current = navisworksRebindKey
      return
    }
    // Notify once per distinct stale/rebind state; repeated polls with the
    // same state stay silent.
    if (lastRebindKeyRef.current === navisworksRebindKey) return
    lastRebindKeyRef.current = navisworksRebindKey
    if (navisworksRebindState.kind === 'disconnected') {
      setNotice('之前选择的 Navisworks 已断开，目前没有检测到可用实例。')
      return
    }
    setNotice(navisworksRebindState.kind === 'single-replacement'
      ? '之前选择的 Navisworks 已断开，检测到一个可用实例，请重新连接。'
      : '之前选择的 Navisworks 已断开，请选择要继续使用的实例。')
    setNavisworksMenuOpen(true)
  }, [navisworksRebindKey, navisworksRebindState])
  // A stale target always keeps an entry point to the instance menu, even
  // when only one replacement candidate exists (instances may hold the stale
  // snapshot too, but the choice must not depend on that implicit detail).
  const canChooseNavisworksInstance =
    navisworksConnection.instances.length > 1
    || navisworksRebindState.kind === 'single-replacement'
    || navisworksRebindState.kind === 'multiple-replacements'

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

  const navisworksBadge = navisworksStatusBadge(navisworks)
  // The header carries the selected instance as one quiet line: PID, version
  // and the raw filename belong in the hover title, not on the chip.
  const selectedInstance = navisworksConnection.instances.find(
    (instance) => instance.instanceId === navisworksConnection.selectedInstanceId
  )
  const navisworksChipTitle = selectedInstance === undefined
    ? navisworksBadge.title
    : [
        selectedInstance.documentName ?? '未命名文档',
        `Navisworks ${selectedInstance.hostVersion}`,
        `PID ${selectedInstance.processId}`,
        selectedInstance.connected ? null : '已断开',
      ].filter(Boolean).join('\n')

  return (
    <div className="app-root">
      <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((current) => !current)} />
      <div
        className="app-shell"
        data-session-transitioning={sessionTransitioning}
        data-deleting-session={deletingSessionId}>
        <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        open={sidebarOpen}
        busy={busy || sessionTransitioning}
        runningSessionId={activeRun?.sessionId}
        settingsMode={settingsOpen}
        activeSettingsPage={settingsPage}
        onSettingsPageChange={setSettingsPage}
        onExitSettings={() => setSettingsOpen(false)}
        onClose={() => setSidebarOpen(false)}
        onCreate={openNewSession}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onSelect={selectSession}
        onTogglePinned={(id) => void togglePinned(id)}
        onDelete={requestDeleteSession}
      />

      <main className="chat-pane" data-view={settingsOpen ? 'settings' : 'chat'}>
        {settingsOpen ? (
          <SettingsPanel
            settings={settings}
            themeMode={appearance.themeMode}
            serviceAvailable={serviceAvailable}
            activePage={settingsPage}
            diagnostics={runtimeInfo ? {
              dataDirectory: runtimeInfo.dataDirectory,
              runtime: `${runtimeInfo.version} · ${runtimeInfo.platform} · ${runtimeInfo.profile}${runtimeInfo.isPackaged ? ' · 已打包' : ' · 开发版'}`
            } : undefined}
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
            onModelConfigurationsChange={(modelConfigurations) => {
              void updateSettings({ ...settings, modelConfigurations })
            }}
            onDisabledToolsChange={(disabledTools) => updateSettings({ ...settings, disabledTools })}
            tools={toolDefinitions}
            onToolPermissionChange={(name, permission) => {
              void updateSettings({
                ...settings,
                toolPermissions: { ...(settings.toolPermissions ?? {}), [name]: permission },
              })
            }}
            onBulkToolPermissions={(toolPermissions) => {
              void updateSettings({ ...settings, toolPermissions })
            }}
            onRefreshModels={refreshModels}
            onFetchCloudModels={(profileId) => desktopGateway.listApiProfileModels(profileId)}
            cloudLatency={cloudLatency}
            onNotice={setNotice}
            onTestApiProfile={testApiProfile}
          />
        ) : (
          <>
        <header className="chat-header">
          {showHero ? null : (
            <div className="chat-title">
              <h1>{session?.title || '新会话'}</h1>
            </div>
          )}
          <div className="header-actions">
            <div className="navisworks-status" data-connected={navisworks.connected} role="status" data-tip={navisworksChipTitle} data-tip-below="true">
              <span className="status-dot" />
              <Box aria-hidden="true" size={14} />
              <span className="status-copy">
                {canChooseNavisworksInstance ? (
                  <button
                    type="button"
                    className="navisworks-instance-trigger"
                    disabled={busy || navisworksConnection.runningInstanceId !== undefined}
                    aria-haspopup="true"
                    aria-expanded={navisworksMenuOpen}
                    onClick={() => setNavisworksMenuOpen((current) => !current)}>
                    <strong>
                      {selectedInstance === undefined
                        ? 'Navisworks'
                        : navisworksInstanceDisplay(selectedInstance, navisworksConnection.instances).label}
                    </strong>
                    <ChevronDown aria-hidden="true" size={12} />
                  </button>
                ) : (
                  <strong>{navisworksBadge.label}</strong>
                )}
              </span>

              {canChooseNavisworksInstance && navisworksMenuOpen ? (
                <div className="navisworks-instance-menu" role="menu">
                  {navisworksConnection.instances.map((instance) => {
                    const isSelected = instance.instanceId === navisworksConnection.selectedInstanceId
                    const isDisconnected = !instance.connected
                    // Rebind candidates are marked as available; the copy must
                    // NOT claim a candidate is the restarted old instance.
                    const isReplacementCandidate = !isDisconnected && !isSelected
                      && (navisworksRebindState.kind === 'single-replacement'
                        || navisworksRebindState.kind === 'multiple-replacements')
                    const display = navisworksInstanceDisplay(instance, navisworksConnection.instances)
                    return (
                      <button
                        key={instance.instanceId}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected && !isDisconnected}
                        className="instance-menu-item"
                        data-selected={isSelected}
                        data-disconnected={isDisconnected}
                        disabled={isDisconnected || busy || navisworksConnection.runningInstanceId !== undefined}
                        data-tip={[
                          instance.documentName ?? '未命名文档',
                          `Navisworks ${instance.hostVersion}`,
                          `PID ${instance.processId}`,
                          isDisconnected ? '已断开连接，无法切换' : null,
                        ].filter(Boolean).join('\n')}
                        onClick={() => {
                          if (!isDisconnected) {
                            void selectNavisworksInstance(instance.instanceId)
                            setNavisworksMenuOpen(false)
                          }
                        }}>
                        <span className="instance-menu-item-title">{display.label}</span>
                        {isDisconnected ? (
                          <span className="instance-menu-state">{isSelected ? '当前目标 · 已断开' : '已断开'}</span>
                        ) : isReplacementCandidate ? (
                          <span className="instance-menu-state">可用</span>
                        ) : null}
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
                    刷新
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
              sessionId={session?.id}
              messages={session?.messages ?? []}
              sessionTitle={session?.title}
              composerClearance={composerClearance}
              onRetryLast={busy ? undefined : retryLast}
              followKey={pendingQuestion?.requestId}
              footer={pendingQuestion && pendingQuestion.sessionId === activeSessionId ? (
                <QuestionCard
                  request={pendingQuestion}
                  resolving={questionResolving}
                  onSubmit={(answers) => void resolveQuestion(answers)}
                  onReject={() => void resolveQuestion(null)}
                />
              ) : undefined}
            />
          )}

          <Composer
            dockRef={composerDockRef}
            variant={showHero ? 'hero' : 'docked'}
            draft={draft}
            busy={activeSessionBusy}
            phase={activeSessionBusy ? activeRun?.phase : undefined}
            settings={settings}
            serviceAvailable={serviceAvailable}
            contextUsage={contextUsage}
            activeModel={activeModel}
            approval={pendingToolApproval}
            approvalResolving={approvalResolving}
            awaitingQuestion={pendingQuestion !== null
              && pendingQuestion.sessionId === activeSessionId
              && activeSessionBusy}
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
          </>
        )}
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
      </div>
    </div>
  )
}

function CircleAlertIcon() {
  return <span aria-hidden="true" className="notice-icon">!</span>
}
