import { randomUUID } from 'node:crypto'

import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'

import type { NavisworksBridgeClient } from './bridgeClient'
import type {
  AppSettings as PersistedSettings,
  ConversationSession,
  JsonSessionRepository,
  JsonSettingsRepository
} from './sessionRepository'
import type { ToolCatalog } from './toolCatalog'
import { validateSender, type SenderTrustOptions } from './security/validateSender'
import {
  DesktopIpcError,
  IPC_EVENT_CHANNEL,
  IPC_REQUEST_CHANNEL,
  eventSchemas,
  requestSchemas,
  toolNameSchema,
  type AppearanceState,
  type AppSettings,
  type ChatEvent,
  type DesktopEventName,
  type EventPayload,
  type InputFor,
  type IpcEnvelope,
  type IpcRoute,
  type NavisworksStatus,
  type OutputFor,
  type RuntimeInfo,
  type Session,
  type SessionSummary,
  type ThemeMode,
  type ToolName
} from '../shared/ipc'

export type OllamaStreamEvent =
  | { kind: 'thinking'; delta: string }
  | { kind: 'text'; delta: string }
  | { kind: 'tool-start'; toolCallId: string; toolName: string; arguments: unknown }
  | {
      kind: 'tool-result'
      toolCallId: string
      toolName: string
      arguments?: unknown
      result: unknown
      error?: { code: string; message: string }
    }

export interface OllamaRunInput {
  sessionId: string
  turnId: string
  userMessageId: string
  text: string
  history: readonly OllamaHistoryEntry[]
  model?: string
  reasoningMode?: 'fast' | 'deep'
  /** Tool names switched off in settings; honored fresh on every request. */
  disabledTools?: readonly string[]
  /** Provider endpoint overrides, read fresh from settings on every run. */
  providerBaseUrl?: string
  providerApiKey?: string
}

export interface OllamaHistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

export interface OllamaRunResult {
  messageId?: string
  content: string
  thinkingText?: string
}

export interface OllamaEndpointOptions {
  baseUrl?: string
  apiKey?: string
}

export interface OllamaAgentPort {
  listModels(options?: OllamaEndpointOptions, signal?: AbortSignal): Promise<readonly string[]>
  testConnection(
    options?: OllamaEndpointOptions & { model?: string },
    signal?: AbortSignal
  ): Promise<{ connected: boolean; message: string }>
  run(
    input: OllamaRunInput,
    options: { signal: AbortSignal; onEvent: (event: OllamaStreamEvent) => void }
  ): Promise<OllamaRunResult>
  dispose?(): void | Promise<void>
}

export interface DesktopIpcDependencies {
  runtimeInfo: RuntimeInfo
  sessions: JsonSessionRepository
  settings: JsonSettingsRepository
  bridge: NavisworksBridgeClient
  tools: ToolCatalog
  ollama: OllamaAgentPort
  appearance: AppearancePort
  senderTrust: SenderTrustOptions
}

export interface AppearancePort {
  getState(): AppearanceState
  setThemeMode(themeMode: ThemeMode): AppearanceState
}

interface RequestContext {
  sender: WebContents
}

/**
 * Upper bound for waiting on in-flight runs during session deletion. A healthy
 * Ollama run unwinds within milliseconds of its abort signal; the timeout only
 * exists so a wedged run can never hold deletion hostage (the Cherry Studio
 * lock-up lesson: the wait must always be escapable).
 */
const CHAT_RUN_SETTLE_TIMEOUT_MS = 3_000

const DELETED_SESSION_WRITE_MESSAGE = '会话已被删除，拒绝写回。'

type RouteHandler<R extends IpcRoute> = (
  input: InputFor<R>,
  context: RequestContext
) => Promise<OutputFor<R>> | OutputFor<R>

type UntypedRouteHandler = (input: unknown, context: RequestContext) => Promise<unknown>

function routeHandler<R extends IpcRoute>(handler: RouteHandler<R>): UntypedRouteHandler {
  return (input, context) => Promise.resolve(handler(input as InputFor<R>, context))
}

export function registerDesktopIpc(dependencies: DesktopIpcDependencies): () => Promise<void> {
  const persistence = new PersistenceFacade(dependencies.sessions, dependencies.settings)
  const chatRuns = new ChatRunRegistry(dependencies.ollama, persistence)

  const handlers = {
    'app.runtime.get': routeHandler<'app.runtime.get'>(() => dependencies.runtimeInfo),
    'sessions.list': routeHandler<'sessions.list'>(() => persistence.listSessions()),
    'sessions.get': routeHandler<'sessions.get'>(({ sessionId }) => persistence.getSession(sessionId)),
    'sessions.save': routeHandler<'sessions.save'>(({ session }) => persistence.saveSession(session)),
    'sessions.delete': routeHandler<'sessions.delete'>(async ({ sessionId }) => {
      // Cherry Studio lesson: terminate this session's in-flight inference
      // first, so a late run completion cannot resurrect the deleted session
      // through sessions.save after the durable delete has landed.
      await chatRuns.abortAndWait(sessionId)
      await persistence.deleteSession(sessionId)
    }),
    'settings.get': routeHandler<'settings.get'>(() => persistence.getSettings()),
    'settings.update': routeHandler<'settings.update'>(async ({ settings }) => {
      const updated = await persistence.updateSettings(settings)
      dependencies.appearance.setThemeMode(updated.themeMode)
      return updated
    }),
    'appearance.get': routeHandler<'appearance.get'>(() => dependencies.appearance.getState()),
    'appearance.update': routeHandler<'appearance.update'>(async ({ themeMode }) => {
      const updated = await persistence.updateSettings({ themeMode })
      return dependencies.appearance.setThemeMode(updated.themeMode)
    }),
    'ollama.models.list': routeHandler<'ollama.models.list'>(async (options) => [
      ...(await dependencies.ollama.listModels(options))
    ]),
    'ollama.connection.test': routeHandler<'ollama.connection.test'>((options) =>
      dependencies.ollama.testConnection(options)
    ),
    'chat.start': routeHandler<'chat.start'>((input, context) =>
      chatRuns.start(input, context.sender)
    ),
    'chat.abort': routeHandler<'chat.abort'>(({ sessionId, turnId }) => ({
      aborted: chatRuns.abort(sessionId, turnId)
    })),
    'navisworks.status.get': routeHandler<'navisworks.status.get'>(() =>
      readNavisworksStatus(dependencies.bridge)
    ),
    'navisworks.tool.execute': routeHandler<'navisworks.tool.execute'>(async ({ toolName, arguments: args }) => {
      dependencies.tools.assertAllowed(toolName, args)
      return dependencies.bridge.call(toolName, args)
    })
  } satisfies Record<IpcRoute, UntypedRouteHandler>

  ipcMain.handle(IPC_REQUEST_CHANNEL, async (event, route: unknown, input: unknown): Promise<IpcEnvelope<unknown>> => {
    try {
      assertTrustedRequest(event, route, dependencies.senderTrust)
      if (typeof route !== 'string' || !Object.hasOwn(requestSchemas, route)) {
        throw new DesktopIpcError('ROUTE_NOT_FOUND', `Unknown desktop route: ${String(route)}`)
      }

      const typedRoute = route as IpcRoute
      const definition = requestSchemas[typedRoute]
      const parsedInput = definition.input.safeParse(input)
      if (!parsedInput.success) {
        throw new DesktopIpcError('VALIDATION_FAILED', `Invalid input for ${typedRoute}`, {
          issues: parsedInput.error.issues
        })
      }

      const output = await handlers[typedRoute](parsedInput.data, { sender: event.sender })
      const parsedOutput = definition.output.safeParse(output)
      if (!parsedOutput.success) {
        console.error(`[IPC] Invalid handler output for ${typedRoute}`, parsedOutput.error)
        throw new DesktopIpcError('INTERNAL', `Desktop service returned invalid output for ${typedRoute}`)
      }

      return { ok: true, data: parsedOutput.data }
    } catch (error) {
      const ipcError = toSafeIpcError(error)
      return { ok: false, error: ipcError.toPayload() }
    }
  })

  return async () => {
    ipcMain.removeHandler(IPC_REQUEST_CHANNEL)
    chatRuns.abortAll()
    await dependencies.ollama.dispose?.()
  }
}

export class ChatRunRegistry {
  readonly #runs = new Map<string, ActiveChatRun>()

  constructor(
    private readonly agent: OllamaAgentPort,
    private readonly persistence: PersistenceFacade
  ) {}

  start(
    input: InputFor<'chat.start'>,
    sender: WebContents
  ): OutputFor<'chat.start'> {
    const runId = randomUUID()
    const turnId = randomUUID()
    const messageId = randomUUID()
    const controller = new AbortController()
    const settlement = createSettlementGate()
    this.#runs.set(runId, {
      controller,
      sessionId: input.sessionId,
      turnId,
      settled: settlement.settled
    })

    void this.#execute(runId, turnId, messageId, input, sender, controller, settlement.settle)
    return { runId, sessionId: input.sessionId, turnId }
  }

  abort(sessionId: string, turnId?: string): boolean {
    let aborted = false
    for (const run of this.#runs.values()) {
      if (run.sessionId !== sessionId || (turnId !== undefined && run.turnId !== turnId)) continue
      run.controller.abort(cancelledGenerationError())
      aborted = true
    }
    return aborted
  }

  /**
   * Aborts every run for a session and waits, bounded, until they unwind.
   * The timeout always escapes so a run that ignores its abort signal can
   * never hold session deletion hostage.
   */
  async abortAndWait(sessionId: string, timeoutMs = CHAT_RUN_SETTLE_TIMEOUT_MS): Promise<boolean> {
    const runs = [...this.#runs.values()].filter((run) => run.sessionId === sessionId)
    if (runs.length === 0) return false

    for (const run of runs) {
      run.controller.abort(cancelledGenerationError())
    }

    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.allSettled(runs.map((run) => run.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
          timer.unref?.()
        })
      ])
    } finally {
      clearTimeout(timer)
    }
    return true
  }

  abortAll(): void {
    for (const run of this.#runs.values()) {
      run.controller.abort(new DesktopIpcError('CANCELLED', '应用正在退出。'))
    }
    this.#runs.clear()
  }

  async #execute(
    runId: string,
    turnId: string,
    messageId: string,
    input: InputFor<'chat.start'>,
    sender: WebContents,
    controller: AbortController,
    settle: () => void
  ): Promise<void> {
    const base = { runId, sessionId: input.sessionId, turnId, messageId }
    try {
      const [history, settings] = await Promise.all([
        this.persistence.getAgentHistory(input.sessionId, input.text),
        this.persistence.getSettings()
      ])
      if (controller.signal.aborted) {
        throw controller.signal.reason
      }
      const disabledTools = settings.disabledTools
      // Provider toggle gates chat entirely; endpoint config is read fresh so
      // edits apply on the very next message.
      if (settings.providerEnabled === false) {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', '模型提供商已停用，请在设置中开启。')
      }
      const providerBaseUrl = settings.providerBaseUrl?.trim()
      const providerApiKey = settings.providerApiKey?.trim()
      const result = await this.agent.run(
        {
          sessionId: input.sessionId,
          turnId,
          userMessageId: input.messageId,
          text: input.text,
          history,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningMode === undefined ? {} : { reasoningMode: input.reasoningMode }),
          ...(disabledTools.length === 0 ? {} : { disabledTools }),
          ...(providerBaseUrl ? { providerBaseUrl } : {}),
          ...(providerApiKey ? { providerApiKey } : {})
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (controller.signal.aborted) return
            emitTo(sender, 'chat.chunk', { ...base, ...event })
          }
        }
      )

      emitTo(sender, 'chat.done', {
        ...base,
        messageId: result.messageId ?? messageId,
        kind: 'done',
        content: result.content,
        ...(result.thinkingText === undefined ? {} : { thinkingText: result.thinkingText })
      })
    } catch (error) {
      const ipcError = controller.signal.aborted
        ? new DesktopIpcError('CANCELLED', '已取消本次生成。')
        : toSafeIpcError(error)
      emitTo(sender, 'chat.error', {
        ...base,
        kind: 'error',
        error: { code: ipcError.code, message: ipcError.message }
      })
    } finally {
      this.#runs.delete(runId)
      settle()
    }
  }
}

interface ActiveChatRun {
  controller: AbortController
  sessionId: string
  turnId: string
  /** Resolves once #execute has fully unwound (success, error, or abort). */
  readonly settled: Promise<void>
}

/**
 * Deferred promise pair so deletion can await a run's final cleanup without
 * depending on how the run itself resolves.
 */
function createSettlementGate(): { readonly settled: Promise<void>; readonly settle: () => void } {
  let settle!: () => void
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { settled, settle }
}

function cancelledGenerationError(): DesktopIpcError {
  return new DesktopIpcError('CANCELLED', '已取消本次生成。')
}

export class PersistenceFacade {
  #writeTail: Promise<void> = Promise.resolve()
  /**
   * In-process tombstones. A session id that was durably deleted must never be
   * resurrected by a late sessions.save (e.g. an aborted run finishing after
   * the delete). Process-local by design; fresh session ids never collide.
   */
  readonly #deletedSessionIds = new Set<string>()

  constructor(
    private readonly sessions: JsonSessionRepository,
    private readonly settings: JsonSettingsRepository
  ) {}

  async listSessions(): Promise<SessionSummary[]> {
    await this.#writeTail
    const loaded = await this.sessions.load()
    return loaded.sessions.map(toSessionSummary)
  }

  async getSession(sessionId: string): Promise<Session | null> {
    await this.#writeTail
    const loaded = await this.sessions.load()
    const session = loaded.sessions.find((candidate) => candidate.id === sessionId)
    return session ? toDesktopSession(session) : null
  }

  async getAgentHistory(sessionId: string, currentInput: string): Promise<OllamaHistoryEntry[]> {
    // Wait for an in-flight sessions.save issued immediately before chat.start,
    // then read the durable snapshot rather than trusting renderer-only state.
    await this.#writeTail
    const loaded = await this.sessions.load()
    const session = loaded.sessions.find((candidate) => candidate.id === sessionId)
    const history: OllamaHistoryEntry[] = []

    for (const message of session?.messages ?? []) {
      if (message.isTransient || !message.content.trim()) continue
      if (message.role === 'user') {
        history.push({ role: 'user', content: message.content })
      } else if (message.role === 'ai' || message.role === 'assistant') {
        history.push({ role: 'assistant', content: message.content })
      }
    }

    // The renderer persists the optimistic user message before invoking
    // chat.start. OllamaAgent.run appends input.text itself, so remove exactly
    // one matching trailing user entry to avoid doubling the current turn.
    const last = history.at(-1)
    if (last?.role === 'user' && last.content.trim() === currentInput.trim()) {
      history.pop()
    }
    return history
  }

  saveSession(session: Session): Promise<Session> {
    return this.#serializeWrite(async () => {
      this.#assertNotDeleted(session.id)
      const loaded = await this.requireWritableSessions()
      const persisted = toPersistedSession(session)
      const index = loaded.findIndex((candidate) => candidate.id === session.id)
      if (index >= 0) loaded[index] = persisted
      else loaded.push(persisted)
      if (!(await this.sessions.save(loaded))) {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', '无法保存会话数据。')
      }
      return session
    })
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.#serializeWrite(async () => {
      const loaded = await this.requireWritableSessions()
      const remaining = loaded.filter((candidate) => candidate.id !== sessionId)
      if (remaining.length === loaded.length) return
      if (!(await this.sessions.save(remaining))) {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', '无法删除会话数据。')
      }
      this.#deletedSessionIds.add(sessionId)
    })
  }

  #assertNotDeleted(sessionId: string): void {
    if (!this.#deletedSessionIds.has(sessionId)) return
    throw new DesktopIpcError('CONFLICT', DELETED_SESSION_WRITE_MESSAGE)
  }

  async getSettings(): Promise<AppSettings> {
    await this.#writeTail
    return toDesktopSettings((await this.settings.load()) ?? defaultPersistedSettings())
  }

  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.#serializeWrite(async () => {
      const current = (await this.settings.load()) ?? defaultPersistedSettings()
      const selectedModel = patch.selectedModel ?? current.selectedModel
      const models = patch.models ?? current.models
      const next: PersistedSettings = {
        ...current,
        selectedModel,
        models: models.includes(selectedModel) ? [...models] : [selectedModel, ...models],
        reasoningMode: patch.reasoningMode ?? current.reasoningMode ?? 'fast',
        themeMode: patch.themeMode ?? current.themeMode ?? 'system',
        disabledTools: patch.disabledTools ?? current.disabledTools,
        fontScale: patch.fontScale ?? current.fontScale ?? 1,
        providerEnabled: patch.providerEnabled ?? current.providerEnabled ?? true,
        providerBaseUrl: patch.providerBaseUrl ?? current.providerBaseUrl ?? '',
        providerApiKey: patch.providerApiKey ?? current.providerApiKey ?? ''
      }
      if (!(await this.settings.save(next))) {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', '无法保存设置。')
      }
      return toDesktopSettings(next)
    })
  }

  async requireWritableSessions(): Promise<ConversationSession[]> {
    const loaded = await this.sessions.load()
    if (!loaded.canPersist) {
      throw new DesktopIpcError(
        'SERVICE_UNAVAILABLE',
        '会话主文件和备份均不可用，已停止写入以保护现有数据。'
      )
    }
    return loaded.sessions
  }

  #serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation)
    this.#writeTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function assertTrustedRequest(
  event: IpcMainInvokeEvent,
  route: unknown,
  trust: SenderTrustOptions
): void {
  if (validateSender(event, trust)) return
  console.warn('[IPC] Rejected request from an untrusted sender', {
    route: typeof route === 'string' ? route : '<invalid>',
    senderType: event.sender.getType(),
    senderUrl: event.senderFrame?.url
  })
  throw new DesktopIpcError('FORBIDDEN_SENDER', '已拒绝来自非受信页面的请求。')
}

function emitTo<E extends DesktopEventName>(
  sender: WebContents,
  event: E,
  payload: EventPayload<E>
): void {
  if (sender.isDestroyed()) return
  const parsed = eventSchemas[event].safeParse(payload)
  if (!parsed.success) {
    console.error(`[IPC] Dropped invalid ${event} event`, parsed.error)
    return
  }
  sender.send(IPC_EVENT_CHANNEL, event, parsed.data)
}

async function readNavisworksStatus(bridge: NavisworksBridgeClient): Promise<NavisworksStatus> {
  try {
    const value = await bridge.call<unknown>('navisworks_status')
    const record = isRecord(value) ? value : {}
    const connected = record.connected === true
    const documentName = typeof record.documentTitle === 'string' && record.documentTitle.trim()
      ? record.documentTitle
      : undefined
    return {
      connected,
      status: connected ? documentName ?? '已连接 Navisworks' : 'Navisworks 未连接',
      ...(documentName === undefined ? {} : { documentName })
    }
  } catch {
    return { connected: false, status: 'Navisworks 未连接' }
  }
}

function toSessionSummary(session: ConversationSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    preview: session.preview,
    updatedAt: session.updatedAt,
    pinnedAt: session.pinnedAt,
    contextTokensUsed: session.contextTokensUsed
  }
}

function toDesktopSession(session: ConversationSession): Session {
  return {
    ...toSessionSummary(session),
    messages: (session.messages ?? []).map((message, index) => ({
      id: `${session.id}:message:${index}`,
      role: normalizeRole(message.role),
      content: message.content,
      thinking: message.thinkingText || undefined,
      transient: message.isTransient,
      createdAt: session.updatedAt,
      tools: (message.tools ?? []).map((tool) => ({
        id: tool.id,
        name: tool.name,
        // A tool still marked running/queued on disk died with the previous
        // app run; showing a live spinner for it would be a lie.
        status: restoreToolStatus(tool.status),
        arguments: tool.arguments ?? undefined,
        result: tool.result ?? undefined,
        ...(tool.error ? { error: tool.error } : {})
      }))
    }))
  }
}

function restoreToolStatus(status: string): 'success' | 'error' | 'cancelled' {
  if (status === 'success') return 'success'
  if (status === 'cancelled') return 'cancelled'
  return 'error'
}

function toPersistedSession(session: Session): ConversationSession {
  return {
    id: session.id,
    title: session.title,
    preview: session.preview,
    updatedAt: session.updatedAt,
    pinnedAt: session.pinnedAt ?? null,
    contextTokensUsed: session.contextTokensUsed ?? 0,
    messages: session.messages.map((message) => ({
      role: message.role === 'assistant' ? 'ai' : message.role,
      content: message.content,
      isTransient: message.transient ?? false,
      thinkingText: message.thinking ?? '',
      tools: (message.tools ?? []).map((tool) => ({
        id: tool.id,
        name: tool.name,
        status: tool.status,
        arguments: tool.arguments ?? null,
        result: tool.result ?? null,
        error: tool.error ?? ''
      }))
    }))
  }
}

function normalizeRole(role: string): 'user' | 'assistant' | 'system' | 'error' {
  if (role === 'user') return 'user'
  if (role === 'ai' || role === 'assistant') return 'assistant'
  if (role === 'error') return 'error'
  return 'system'
}

function defaultPersistedSettings(): PersistedSettings {
  return {
    selectedModel: 'qwen3.5:9b-q4_K_M',
    models: ['qwen3.5:9b-q4_K_M'],
    plugins: [],
    skills: [],
    reasoningMode: 'fast',
    activeSessionId: null,
    gpuVramGb: 8,
    contextWindowTokens: 8192,
    numPredict: 2048,
    themeMode: 'system',
    disabledTools: [],
    fontScale: 1,
    providerEnabled: true,
    providerBaseUrl: '',
    providerApiKey: ''
  }
}

function toDesktopSettings(settings: PersistedSettings): AppSettings {
  const reasoningMode = settings.reasoningMode === 'deep' ? 'deep' : 'fast'
  const models = settings.models.includes(settings.selectedModel)
    ? [...settings.models]
    : [settings.selectedModel, ...settings.models]
  const disabled = settings.disabledTools ?? []
  return {
    selectedModel: settings.selectedModel,
    models,
    reasoningMode,
    themeMode: settings.themeMode ?? 'system',
    disabledTools: toolNameSchema.options.filter((name) => disabled.includes(name)),
    fontScale: Math.min(1.3, Math.max(0.85, settings.fontScale ?? 1)),
    providerEnabled: settings.providerEnabled ?? true,
    providerBaseUrl: settings.providerBaseUrl ?? '',
    providerApiKey: settings.providerApiKey ?? ''
  }
}

function toSafeIpcError(error: unknown): DesktopIpcError {
  if (error instanceof DesktopIpcError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new DesktopIpcError('CANCELLED', '操作已取消。')
  }
  console.error('[IPC] Desktop service failed', error)
  return new DesktopIpcError('INTERNAL', '桌面服务执行失败。')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function broadcastNavisworksStatus(status: NavisworksStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) emitTo(window.webContents, 'navisworks.status.changed', status)
  }
}

export function broadcastNativeThemeUpdated(state: AppearanceState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) emitTo(window.webContents, 'nativeTheme.updated', state)
  }
}

// Compile-time guard that the complete chat event remains representable by the
// separate chunk/done/error channels above.
const _chatEventContract: ChatEvent | undefined = undefined
void _chatEventContract
