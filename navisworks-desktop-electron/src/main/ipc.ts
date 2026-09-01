import { randomUUID } from 'node:crypto'

import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'

import type { NavisworksBridgeClient } from './bridgeClient'
import type { NavisworksInstanceRegistry } from './navisworks/instanceRegistry'
import type { NavisworksInstanceSelection } from './navisworks/instanceSelection'
import type { NavisworksInstance } from './navisworks/instanceTypes'
import type { NavisworksRunBinding } from './navisworks/instanceTypes'
import {
  createNavisworksRunBinding,
  NavisworksTargetError,
} from './navisworks/runBinding'
import type {
  AppSettings as PersistedSettings,
  ConversationSession,
  JsonSessionRepository,
  JsonSettingsRepository
} from './sessionRepository'
import type { ToolCatalog } from './toolCatalog'
import type {
  ContextState,
  CurrentDocumentContext,
  DocumentChangeNotice,
} from './agent/contextState'
import type { AgentScopeManager } from './kernel/agentScopes'
import type { Scope } from './kernel/kernel'
import { externalizeResult, isExternalizedResult, resolveResult } from './agent/toolResultStore'
import type { SemanticMemory } from './agent/semanticMemory'
import { validateSender, type SenderTrustOptions } from './security/validateSender'
import {
  DesktopIpcError,
  IPC_EVENT_CHANNEL,
  IPC_REQUEST_CHANNEL,
  eventSchemas,
  requestSchemas,
  toolNameSchema,
  type AppearanceState,
  type ApiProfile,
  type AppSettings,
  type ChatEvent,
  type DesktopEventName,
  type EventPayload,
  type InputFor,
  type IpcEnvelope,
  type IpcRoute,
  type NavisworksStatus,
  type NavisworksConnectionState,
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
  runId: string
  sessionId: string
  turnId: string
  userMessageId: string
  text: string
  history: readonly OllamaHistoryEntry[]
  model?: string
  reasoningMode?: 'fast' | 'deep'
  /** Tool names switched off in settings; honored fresh on every request. */
  disabledTools?: readonly string[]
  /** API endpoint, read fresh from settings on every run. */
  api?: OllamaEndpointOptions & { model?: string }
  /** P4: durable compact summary of earlier turns, injected into this run's context. */
  compactSummary?: string
  semanticMemory?: SemanticMemory
  /** Runtime-only Navisworks environment notice; not part of persisted chat history. */
  documentNotice?: DocumentChangeNotice
  /** The document snapshot captured by the same preflight that binds the Run Scope. */
  currentDocument?: CurrentDocumentContext
  navisworksBinding?: NavisworksRunBinding
  navisworksUnavailable?: { code: 'TARGET_INSTANCE_DISCONNECTED'; message: string }
}

export interface OllamaHistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

export interface OllamaRunResult {
  messageId?: string
  content: string
  thinkingText?: string
  /** Prompt + completion tokens of the last model round, when reported. */
  contextTokensUsed?: number
  cacheHitRate?: number
  /** True when automatic context compaction ran during this run. */
  compacted?: boolean
  /** P4: the summary produced by this run's compaction, for durable persistence. */
  compactSummary?: string
  semanticMemory?: SemanticMemory
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
    options: {
      signal: AbortSignal
      onEvent: (event: OllamaStreamEvent) => void
      requestToolApproval: (request: OllamaToolApprovalRequest) => Promise<boolean>
    }
  ): Promise<OllamaRunResult>
  /** Optional: model-generated conversation title; routes fall back to truncation. */
  summarizeTitle?(text: string, signal?: AbortSignal): Promise<string>
  /** Manual /compact: summarizes a session's messages into one summary. */
  compact?(
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
    input: {
      model?: string
      api?: OllamaEndpointOptions & { model?: string }
    },
    options?: { signal?: AbortSignal }
  ): Promise<string>
  dispose?(): void | Promise<void>
}

export interface OllamaToolApprovalRequest {
  runId: string
  toolCallId: string
  toolName: ToolName
  arguments: Record<string, unknown>
  argumentsHash: string
  instanceId?: string
  bridgeSessionId?: string
  documentInstanceId?: string
  ambiguousRetry?: boolean
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
  secrets?: SecretProtector
  /** Live Document Scope; observes bridge status so identity changes invalidate facts/sets. */
  contextState?: ContextState
  scopeManager?: AgentScopeManager
  toolApprovals: ToolApprovalRegistry
  /** P3 directory for externalized large tool results. When absent, results stay inline. */
  toolResultsDirectory?: string
  instanceRegistry?: NavisworksInstanceRegistry
  instanceSelection?: NavisworksInstanceSelection
}

export interface SecretProtector {
  encrypt(value: string): string
  decrypt(value: string): string
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
  const persistence = new PersistenceFacade(
    dependencies.sessions,
    dependencies.settings,
    dependencies.secrets,
    dependencies.contextState,
    dependencies.toolResultsDirectory
  )
  const toolApprovals = dependencies.toolApprovals
  const chatRuns = new ChatRunRegistry(
    dependencies.ollama,
    persistence,
    toolApprovals,
    dependencies.scopeManager,
    dependencies.contextState,
    () => readNavisworksStatus(dependencies.bridge),
    dependencies.instanceRegistry,
    dependencies.instanceSelection,
    dependencies.bridge,
  )

  const handlers = {
    'app.runtime.get': routeHandler<'app.runtime.get'>(() => dependencies.runtimeInfo),
    'sessions.list': routeHandler<'sessions.list'>(() => persistence.listSessions()),
    'sessions.get': routeHandler<'sessions.get'>(({ sessionId }) => persistence.getSession(sessionId)),
    'sessions.save': routeHandler<'sessions.save'>(({ session }) => persistence.saveSession(session)),
    'sessions.summarizeTitle': routeHandler<'sessions.summarizeTitle'>(async ({ text }) => {
      // Title summarization is best-effort: if the provider is off or the
      // model stalls, fall back to plain truncation so the first message
      // always ends up with a usable sidebar label either way.
      const fallback = { title: text.trim().slice(0, 28) }
      if (typeof dependencies.ollama.summarizeTitle !== 'function') return fallback
      try {
        return { title: await dependencies.ollama.summarizeTitle(text) }
      } catch {
        return fallback
      }
    }),
    'sessions.delete': routeHandler<'sessions.delete'>(async ({ sessionId }) => {
      // Cherry Studio lesson: terminate this session's in-flight inference
      // first, so a late run completion cannot resurrect the deleted session
      // through sessions.save after the durable delete has landed.
      await chatRuns.abortAndWait(sessionId)
      await persistence.deleteSession(sessionId)
      await dependencies.scopeManager?.forgetConversation(sessionId)
    }),
    'settings.get': routeHandler<'settings.get'>(() => persistence.getSettings()),
    'settings.update': routeHandler<'settings.update'>(async ({ settings }) => {
      const updated = await persistence.updateSettings(settings)
      dependencies.appearance.setThemeMode(updated.themeMode)
      return updated
    }),
    'api.profile.save': routeHandler<'api.profile.save'>((input) =>
      persistence.saveApiProfile(input)
    ),
    'api.profile.delete': routeHandler<'api.profile.delete'>(({ profileId }) =>
      persistence.deleteApiProfile(profileId)
    ),
    'api.profile.models.list': routeHandler<'api.profile.models.list'>(async ({ profileId }) => {
      const endpoint = await persistence.getApiEndpoint(profileId)
      if (!endpoint) throw new DesktopIpcError('NOT_FOUND', 'API 配置不存在。')
      if (!endpoint.baseUrl) throw new DesktopIpcError('VALIDATION_FAILED', 'API 地址为空。')
      return [...await dependencies.ollama.listModels(endpoint)]
    }),
    'api.profile.connection.test': routeHandler<'api.profile.connection.test'>(async ({ profileId }) => {
      const endpoint = await persistence.getApiEndpoint(profileId)
      if (!endpoint) throw new DesktopIpcError('NOT_FOUND', 'API 配置不存在。')
      if (!endpoint.baseUrl) throw new DesktopIpcError('VALIDATION_FAILED', 'API 地址为空。')
      return dependencies.ollama.testConnection(endpoint)
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
    'tool.approval.resolve': routeHandler<'tool.approval.resolve'>((input, context) => ({
      resolved: toolApprovals.resolve(input.approvalId, input.decision === 'confirm', context.sender)
    })),
    'chat.compact': routeHandler<'chat.compact'>(async ({ sessionId }) => {
      const compactFn = dependencies.ollama.compact
      if (!compactFn) {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', '当前版本不支持手动压缩。')
      }
      const session = await persistence.getSession(sessionId)
      const messages = (session?.messages ?? [])
        .filter((message) => (message.role === 'user' || message.role === 'assistant')
          && !message.transient
          && message.content.trim())
        .map((message) => ({
          role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: message.content
        }))
      if (messages.length === 0) {
        return { summary: '' }
      }

      const settings = await persistence.getSettings()
      const activeEndpoint = settings.preferApiModel
        ? await persistence.getApiEndpoint(settings.activeApiProfileId)
        : null
      const summary = await compactFn(
        messages,
        {
          model: settings.selectedModel,
          ...(activeEndpoint ? { api: activeEndpoint } : {})
        }
      )

      // Replace the session transcript with the compact summary so the next
      // message starts on a light context.
      if (session) {
        const now = new Date().toISOString()
        await persistence.saveSession({
          ...session,
          updatedAt: now,
          // P4: keep the summary durable on its own field, and reset the transcript so the
          // next turn starts light — the summary is re-injected via compactSummary, not chat.
          compactSummary: summary,
          messages: [{
            id: randomUUID(),
            role: 'assistant',
            content: `上下文已压缩。早期对话摘要：\n${summary}`,
            createdAt: now,
            tools: []
          }]
        })
      }
      return { summary }
    }),
    'navisworks.status.get': routeHandler<'navisworks.status.get'>(async () => {
      if (dependencies.instanceRegistry !== undefined && dependencies.instanceSelection !== undefined) {
        const state = await refreshNavisworksConnectionState(
          dependencies.instanceRegistry,
          dependencies.instanceSelection,
        )
        const status = statusForSelectedInstance(
          dependencies.instanceRegistry,
          dependencies.instanceSelection,
        )
        dependencies.contextState?.observe(status)
        return status
      }
      const status = await readNavisworksStatus(dependencies.bridge)
      dependencies.contextState?.observe(status)
      return status
    }),
    'navisworks.instances.list': routeHandler<'navisworks.instances.list'>(async () => {
      if (dependencies.instanceRegistry === undefined || dependencies.instanceSelection === undefined) {
        return { instances: [] }
      }
      return refreshNavisworksConnectionState(
        dependencies.instanceRegistry,
        dependencies.instanceSelection,
      )
    }),
    'navisworks.instance.select': routeHandler<'navisworks.instance.select'>(async ({ instanceId }) => {
      if (dependencies.instanceRegistry === undefined || dependencies.instanceSelection === undefined) {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', 'Navisworks 实例发现服务不可用。')
      }
      const instances = await dependencies.instanceRegistry.refresh()
      dependencies.instanceSelection.observe(instances)
      try {
        dependencies.instanceSelection.select(instanceId, instances)
      } catch {
        throw new DesktopIpcError('NOT_FOUND', '目标 Navisworks 实例不存在或已经关闭。')
      }
      const state = buildNavisworksConnectionState(dependencies.instanceSelection, instances)
      broadcastNavisworksConnectionState(state)
      broadcastNavisworksStatus(statusForSelectedInstance(
        dependencies.instanceRegistry,
        dependencies.instanceSelection,
      ))
      return state
    }),
    'navisworks.tool.execute': routeHandler<'navisworks.tool.execute'>(async ({ toolName, arguments: args }) => {
      dependencies.tools.assertAllowed(toolName, args)
      if (dependencies.tools.get(toolName)?.impact === 'view-state-change') {
        throw new DesktopIpcError('VALIDATION_FAILED', '视图操作必须经过聊天操作确认。')
      }
      if (dependencies.instanceRegistry !== undefined && dependencies.instanceSelection !== undefined) {
        const selectedId = dependencies.instanceSelection.selectedInstanceId
        const selected = selectedId === undefined
          ? undefined
          : dependencies.instanceRegistry.get(selectedId)
        if (selected === undefined || !selected.connected) {
          throw new DesktopIpcError('SERVICE_UNAVAILABLE', '当前 Navisworks 目标已断开。')
        }
        return dependencies.bridge.callToEndpoint(selected.endpoint, toolName, args)
      }
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
    toolApprovals.cancelAll()
    await dependencies.ollama.dispose?.()
  }
}

export class ChatRunRegistry {
  readonly #runs = new Map<string, ActiveChatRun>()
  readonly #runningInstances = new Map<string, string>()

  constructor(
    private readonly agent: OllamaAgentPort,
    private readonly persistence: PersistenceFacade,
    private readonly toolApprovals: ToolApprovalRegistry = new ToolApprovalRegistry(),
    private readonly scopeManager?: AgentScopeManager,
    private readonly contextState?: ContextState,
    private readonly readCurrentNavisworksStatus: () => Promise<NavisworksStatus> = async () => ({
      connected: false,
      status: 'Navisworks 未连接',
    }),
    private readonly instanceRegistry?: NavisworksInstanceRegistry,
    private readonly instanceSelection?: NavisworksInstanceSelection,
    private readonly bridge?: NavisworksBridgeClient,
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
    let runScope: Scope | undefined
    let navisworksBinding: NavisworksRunBinding | undefined
    let navisworksUnavailable: OllamaRunInput['navisworksUnavailable']
    try {
      if (this.instanceRegistry !== undefined
        && this.instanceSelection !== undefined
        && this.bridge !== undefined) {
        const instances = await this.instanceRegistry.refresh()
        this.instanceSelection.observe(instances)
        const selectedInstanceId = this.instanceSelection.selectedInstanceId
        const selected = selectedInstanceId === undefined
          ? undefined
          : this.instanceRegistry.get(selectedInstanceId)
        if (selected === undefined || !selected.connected) {
          navisworksUnavailable = {
            code: 'TARGET_INSTANCE_DISCONNECTED',
            message: selectedInstanceId === undefined
              ? '请选择要使用的 Navisworks 实例。'
              : '当前选择的 Navisworks 已断开，请明确选择其他实例。',
          }
          this.contextState?.observe({ connected: false })
        } else {
          navisworksBinding = await createNavisworksRunBinding(selected, this.bridge, {
            signal: controller.signal,
          })
          this.contextState?.observe({
            connected: true,
            instanceId: navisworksBinding.instanceId,
            bridgeSessionId: navisworksBinding.bridgeSessionId,
            ...(navisworksBinding.documentInstanceId === undefined
              ? {}
              : { documentInstanceId: navisworksBinding.documentInstanceId }),
            ...(navisworksBinding.documentName === undefined
              ? {}
              : { documentName: navisworksBinding.documentName }),
          })
          this.#runningInstances.set(runId, navisworksBinding.instanceId)
          broadcastNavisworksConnectionState(buildNavisworksConnectionState(
            this.instanceSelection,
            this.instanceRegistry.instances,
            navisworksBinding.instanceId,
          ))
        }
      } else if (this.contextState !== undefined) {
        let status: NavisworksStatus
        try {
          status = await this.readCurrentNavisworksStatus()
        } catch {
          status = { connected: false, status: 'Navisworks 未连接' }
        }
        this.contextState.observe(status)
      }
      const observedDocumentRevision = this.contextState?.documentRevision
      const documentNotice = this.contextState?.documentNoticeForSession(input.sessionId)
      const currentDocument = this.contextState?.currentDocument
      runScope = await this.scopeManager?.createRun(
        runId,
        input.sessionId,
        this.contextState?.documentInstanceId,
      )
      const [history, settings] = await Promise.all([
        this.persistence.getAgentHistory(input.sessionId, input.text),
        this.persistence.getSettings()
      ])
      const compactSummary = await this.persistence.getCompactSummary(input.sessionId)
      const semanticMemory = await this.persistence.getSemanticMemory(input.sessionId)
      if (controller.signal.aborted) {
        throw controller.signal.reason
      }
      const disabledTools = settings.disabledTools
      const activeEndpoint = settings.preferApiModel
        ? await this.persistence.getApiEndpoint(settings.activeApiProfileId)
        : null
      const result = await this.agent.run(
        {
          sessionId: input.sessionId,
          runId,
          turnId,
          userMessageId: input.messageId,
          text: input.text,
          history,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningMode === undefined ? {} : { reasoningMode: input.reasoningMode }),
          ...(disabledTools.length === 0 ? {} : { disabledTools }),
          ...(activeEndpoint ? { api: activeEndpoint } : {}),
          ...(compactSummary === undefined ? {} : { compactSummary }),
          ...(semanticMemory === undefined ? {} : { semanticMemory }),
          ...(documentNotice === undefined ? {} : { documentNotice }),
          ...(currentDocument === undefined ? {} : { currentDocument }),
          ...(navisworksBinding === undefined ? {} : { navisworksBinding }),
          ...(navisworksUnavailable === undefined ? {} : { navisworksUnavailable })
        },
        {
          signal: controller.signal,
          requestToolApproval: (request) => this.toolApprovals.request({
            ...base,
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            arguments: request.arguments,
            argumentsHash: request.argumentsHash,
            ...(request.instanceId === undefined ? {} : { instanceId: request.instanceId }),
            ...(request.bridgeSessionId === undefined
              ? {}
              : { bridgeSessionId: request.bridgeSessionId }),
            ...(request.documentInstanceId === undefined
              ? {}
              : { documentInstanceId: request.documentInstanceId }),
            ...(request.ambiguousRetry ? { ambiguousRetry: true } : {})
          }, sender, controller.signal),
          onEvent: (event) => {
            if (controller.signal.aborted) return
            emitTo(sender, 'chat.chunk', { ...base, ...event })
          }
        }
      )

      if (controller.signal.aborted) throw controller.signal.reason
      if (observedDocumentRevision !== undefined) {
        this.contextState?.markDocumentSeen(input.sessionId, observedDocumentRevision)
      }

      // P4: durably persist any summary this run's auto-compaction produced (the renderer's
      // own save preserves it; see saveSession). Best-effort — a persistence failure must not
      // block delivering the answer to the user.
      if (result.compactSummary !== undefined) {
        await this.persistence.persistCompactSummary(input.sessionId, result.compactSummary)
          .catch(() => undefined)
      }
      if (result.semanticMemory !== undefined) {
        await this.persistence.persistSemanticMemory(input.sessionId, result.semanticMemory)
          .catch(() => undefined)
      }

      emitTo(sender, 'chat.done', {
        ...base,
        messageId: result.messageId ?? messageId,
        kind: 'done',
        content: result.content,
        ...(result.thinkingText === undefined ? {} : { thinkingText: result.thinkingText }),
        ...(result.contextTokensUsed === undefined ? {} : { contextTokensUsed: result.contextTokensUsed }),
        ...(result.cacheHitRate === undefined ? {} : { cacheHitRate: result.cacheHitRate }),
        ...(result.compacted ? { compacted: true } : {})
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
      await runScope?.dispose()
      if (this.#runningInstances.delete(runId)
        && this.instanceRegistry !== undefined
        && this.instanceSelection !== undefined) {
        broadcastNavisworksConnectionState(buildNavisworksConnectionState(
          this.instanceSelection,
          this.instanceRegistry.instances,
          [...this.#runningInstances.values()].at(-1),
        ))
      }
      this.#runs.delete(runId)
      settle()
    }
  }
}

interface PendingToolApproval {
  readonly senderId: number
  readonly instanceId?: string
  readonly bridgeSessionId?: string
  readonly documentInstanceId?: string
  readonly finish: (approved: boolean) => void
}

/** Main-process, one-shot authorization gate for model-requested view changes. */
export class ToolApprovalRegistry {
  readonly #pending = new Map<string, PendingToolApproval>()

  request(
    payload: Omit<EventPayload<'tool.approval.requested'>, 'approvalId'>,
    sender: WebContents,
    signal: AbortSignal
  ): Promise<boolean> {
    if (signal.aborted || sender.isDestroyed()) return Promise.resolve(false)
    const approvalId = randomUUID()

    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (approved: boolean): void => {
        if (settled) return
        settled = true
        this.#pending.delete(approvalId)
        signal.removeEventListener('abort', cancel)
        sender.removeListener('destroyed', cancel)
        resolve(approved)
      }
      const cancel = (): void => finish(false)
      this.#pending.set(approvalId, {
        senderId: sender.id,
        ...(payload.instanceId === undefined ? {} : { instanceId: payload.instanceId }),
        ...(payload.bridgeSessionId === undefined
          ? {}
          : { bridgeSessionId: payload.bridgeSessionId }),
        ...(payload.documentInstanceId === undefined
          ? {}
          : { documentInstanceId: payload.documentInstanceId }),
        finish,
      })
      signal.addEventListener('abort', cancel, { once: true })
      sender.once('destroyed', cancel)
      emitTo(sender, 'tool.approval.requested', { approvalId, ...payload })
    })
  }

  resolve(approvalId: string, approved: boolean, sender: WebContents): boolean {
    const pending = this.#pending.get(approvalId)
    if (!pending || pending.senderId !== sender.id) return false
    pending.finish(approved)
    return true
  }

  cancelAll(): void {
    for (const pending of [...this.#pending.values()]) pending.finish(false)
  }

  cancelForDocument(documentInstanceId: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.documentInstanceId === documentInstanceId) pending.finish(false)
    }
  }

  cancelForEnvironment(
    instanceId: string,
    bridgeSessionId: string,
    documentInstanceId?: string,
  ): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.instanceId === instanceId
        && pending.bridgeSessionId === bridgeSessionId
        && (documentInstanceId === undefined
          || pending.documentInstanceId === documentInstanceId)) {
        pending.finish(false)
      }
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
    private readonly settings: JsonSettingsRepository,
    private readonly secrets: SecretProtector = unavailableSecretProtector,
    private readonly contextState: ContextState | undefined = undefined,
    private readonly toolResultsDirectory: string | undefined = undefined
  ) {}

  /**
   * P3: persist oversized tool results to `toolResultsDirectory` and keep only a small ref
   * inline. A no-op when no directory is configured (e.g. unit tests), so the payload — and
   * therefore the on-disk format — is byte-for-byte what it was before P3.
   */
  async #externalizeForSave(session: Session): Promise<Session> {
    if (this.toolResultsDirectory === undefined) return session
    const messages = await Promise.all(session.messages.map(async (message) => ({
      ...message,
      tools: await Promise.all(message.tools.map(async (tool) => {
        if (isExternalizedResult(tool.result)) return tool
        const ref = await externalizeResult(
          this.toolResultsDirectory as string,
          `${session.id}:${message.id}:${tool.id}`,
          tool.result,
        )
        return ref === null ? tool : { ...tool, result: ref }
      })),
    })))
    return { ...session, messages }
  }

  /** P3: expand externalized refs back to full results before returning to the renderer. */
  async #resolveForRead(session: Session): Promise<Session> {
    if (this.toolResultsDirectory === undefined) return session
    const messages = await Promise.all(session.messages.map(async (message) => ({
      ...message,
      tools: await Promise.all(message.tools.map(async (tool) => (
        isExternalizedResult(tool.result)
          ? { ...tool, result: await resolveResult(this.toolResultsDirectory as string, tool.result) }
          : tool
      ))),
    })))
    return { ...session, messages }
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.#writeTail
    const loaded = await this.sessions.load()
    return loaded.sessions.map(toSessionSummary)
  }

  async getSession(sessionId: string): Promise<Session | null> {
    await this.#writeTail
    const loaded = await this.sessions.load()
    const session = loaded.sessions.find((candidate) => candidate.id === sessionId)
    if (!session) return null
    const resolved = await this.#resolveForRead(toDesktopSession(session))
    this.contextState?.ingestConversationMessages(sessionId, resolved.messages)
    return resolved
  }

  /** P4: read the durable compact summary for a session (no externalization involved). */
  async getCompactSummary(sessionId: string): Promise<string | undefined> {
    await this.#writeTail
    const loaded = await this.sessions.load()
    return loaded.sessions.find((candidate) => candidate.id === sessionId)?.compactSummary
  }

  async getSemanticMemory(sessionId: string): Promise<SemanticMemory | undefined> {
    await this.#writeTail
    const loaded = await this.sessions.load()
    return loaded.sessions.find((candidate) => candidate.id === sessionId)?.semanticMemory
  }

  /**
   * P4: persist the summary produced by a run's auto-compaction onto the durable session.
   * The renderer's own save is merged to preserve this value (see saveSession), so this can
   * run before or after the renderer writes the turn.
   */
  persistCompactSummary(sessionId: string, summary: string): Promise<void> {
    if (!summary.trim()) return Promise.resolve()
    return this.#serializeWrite(async () => {
      const loaded = await this.requireWritableSessions()
      const index = loaded.findIndex((candidate) => candidate.id === sessionId)
      const existing = index >= 0 ? loaded[index] : undefined
      if (existing === undefined) return
      loaded[index] = { ...existing, compactSummary: summary }
      if (!(await this.sessions.save(loaded))) {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', '无法保存压缩摘要。')
      }
    })
  }

  persistSemanticMemory(sessionId: string, memory: SemanticMemory): Promise<void> {
    return this.#serializeWrite(async () => {
      const loaded = await this.requireWritableSessions()
      const index = loaded.findIndex((candidate) => candidate.id === sessionId)
      const existing = index >= 0 ? loaded[index] : undefined
      if (existing === undefined) return
      loaded[index] = { ...existing, semanticMemory: memory }
      if (!(await this.sessions.save(loaded))) {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', '无法保存会话语义记忆。')
      }
    })
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
      // Persist a copy with large results externalized; return the caller's full session.
      const externalized = await this.#externalizeForSave(session)
      const persisted = toPersistedSession(externalized)
      const index = loaded.findIndex((candidate) => candidate.id === session.id)
      // The renderer does not carry the durable compact summary; preserve the stored one so
      // a routine save never wipes an auto-compaction summary (P4).
      const existing = index >= 0 ? loaded[index] : undefined
      if (existing !== undefined) {
        if (persisted.compactSummary === undefined && existing.compactSummary !== undefined) {
          persisted.compactSummary = existing.compactSummary
        }
        if (persisted.semanticMemory === undefined && existing.semanticMemory !== undefined) {
          persisted.semanticMemory = existing.semanticMemory
        }
        loaded[index] = persisted
      } else {
        loaded.push(persisted)
      }
      if (!(await this.sessions.save(loaded))) {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', '无法保存会话数据。')
      }
      this.contextState?.ingestConversationMessages(session.id, externalized.messages)
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
      this.contextState?.forgetSession(sessionId)
    })
  }

  #assertNotDeleted(sessionId: string): void {
    if (!this.#deletedSessionIds.has(sessionId)) return
    throw new DesktopIpcError('CONFLICT', DELETED_SESSION_WRITE_MESSAGE)
  }

  async getSettings(): Promise<AppSettings> {
    await this.#writeTail
    return toDesktopSettings(await this.#loadSettings())
  }

  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.#serializeWrite(async () => {
      const current = await this.#loadSettings()
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
        contextWindowTokens: patch.contextWindowTokens ?? current.contextWindowTokens ?? 32768,
        preferApiModel: patch.preferApiModel ?? current.preferApiModel ?? false,
        activeApiProfileId: validProfileId(
          patch.activeApiProfileId,
          current.activeApiProfileId,
          current.apiProfiles
        )
      }
      if (!(await this.settings.save(next))) {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', '无法保存设置。')
      }
      return toDesktopSettings(next)
    })
  }

  saveApiProfile(input: InputFor<'api.profile.save'>): Promise<AppSettings> {
    return this.#serializeWrite(async () => {
      const current = await this.#loadSettings()
      const id = input.id?.trim() || randomUUID()
      const existing = current.apiProfiles.find((profile) => profile.id === id)
      const baseUrl = input.baseUrl.trim()
      if (baseUrl) assertSafeProviderUrl(baseUrl)
      let apiKeyCiphertext = existing?.apiKeyCiphertext ?? ''
      if (input.clearApiKey) apiKeyCiphertext = ''
      else if (input.apiKey !== undefined) {
        try {
          apiKeyCiphertext = input.apiKey ? this.secrets.encrypt(input.apiKey) : ''
        } catch {
          throw new DesktopIpcError('SERVICE_UNAVAILABLE', 'Windows 安全存储当前不可用。')
        }
      }
      const profile: PersistedSettings['apiProfiles'][number] = {
        id,
        name: input.name.trim(),
        baseUrl,
        model: input.model.trim(),
        apiKeyCiphertext,
        legacyApiKey: '',
      }
      const apiProfiles = existing
        ? current.apiProfiles.map((candidate) => candidate.id === id ? profile : candidate)
        : [...current.apiProfiles, profile]
      const next: PersistedSettings = {
        ...current,
        apiProfiles,
        activeApiProfileId: current.activeApiProfileId ?? id,
      }
      await this.#saveSettings(next)
      return toDesktopSettings(next)
    })
  }

  deleteApiProfile(profileId: string): Promise<AppSettings> {
    return this.#serializeWrite(async () => {
      const current = await this.#loadSettings()
      if (!current.apiProfiles.some((profile) => profile.id === profileId)) {
        throw new DesktopIpcError('NOT_FOUND', 'API 配置不存在。')
      }
      const apiProfiles = current.apiProfiles.filter((profile) => profile.id !== profileId)
      const deletedActive = current.activeApiProfileId === profileId
      const next: PersistedSettings = {
        ...current,
        apiProfiles,
        preferApiModel: deletedActive ? false : current.preferApiModel,
        activeApiProfileId: deletedActive ? null : current.activeApiProfileId,
      }
      await this.#saveSettings(next)
      return toDesktopSettings(next)
    })
  }

  async getApiEndpoint(profileId: string | null): Promise<(OllamaEndpointOptions & { model: string }) | null> {
    await this.#writeTail
    if (!profileId) return null
    const current = await this.#loadSettings()
    const profile = current.apiProfiles.find((candidate) => candidate.id === profileId)
    if (!profile) return null
    if (profile.baseUrl) assertSafeProviderUrl(profile.baseUrl)
    let apiKey = profile.legacyApiKey
    if (profile.apiKeyCiphertext) {
      try {
        apiKey = this.secrets.decrypt(profile.apiKeyCiphertext)
      } catch {
        throw new DesktopIpcError('SERVICE_UNAVAILABLE', '无法读取安全保存的 API 密钥。')
      }
    }
    return {
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(apiKey ? { apiKey } : {}),
    }
  }

  async #loadSettings(): Promise<PersistedSettings> {
    const loaded = await this.settings.load()
    const current: PersistedSettings = loaded
      ? {
          ...defaultPersistedSettings(),
          ...loaded,
          apiProfiles: loaded.apiProfiles ?? [],
          activeApiProfileId: loaded.activeApiProfileId ?? null,
        }
      : defaultPersistedSettings()
    let changed = false
    const apiProfiles = current.apiProfiles.map((profile) => {
      if (!profile.legacyApiKey || profile.apiKeyCiphertext) return profile
      try {
        const migrated = {
          ...profile,
          apiKeyCiphertext: this.secrets.encrypt(profile.legacyApiKey),
          legacyApiKey: '',
        }
        changed = true
        return migrated
      } catch {
        return profile
      }
    })
    if (!changed) return current
    const migrated = { ...current, apiProfiles }
    await this.#saveSettings(migrated)
    return migrated
  }

  async #saveSettings(settings: PersistedSettings): Promise<void> {
    if (!(await this.settings.save(settings))) {
      throw new DesktopIpcError('SERVICE_UNAVAILABLE', '无法保存设置。')
    }
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
    const bridgeSessionId = typeof record.bridgeSessionId === 'string' && record.bridgeSessionId.trim()
      ? record.bridgeSessionId
      : undefined
    const documentInstanceId = typeof record.documentInstanceId === 'string' && record.documentInstanceId.trim()
      ? record.documentInstanceId
      : undefined
    return {
      connected,
      status: connected ? documentName ?? '已连接 Navisworks' : 'Navisworks 未连接',
      ...(documentName === undefined ? {} : { documentName }),
      ...(bridgeSessionId === undefined ? {} : { bridgeSessionId }),
      ...(documentInstanceId === undefined ? {} : { documentInstanceId })
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
    })),
    ...(session.compactSummary === undefined ? {} : { compactSummary: session.compactSummary }),
    ...(session.semanticMemory === undefined ? {} : { semanticMemory: session.semanticMemory })
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
    ...(session.compactSummary === undefined ? {} : { compactSummary: session.compactSummary }),
    ...(session.semanticMemory === undefined ? {} : { semanticMemory: session.semanticMemory }),
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
    contextWindowTokens: 32768,
    numPredict: 2048,
    themeMode: 'system',
    disabledTools: [],
    fontScale: 1,
    preferApiModel: false,
    apiProfiles: [],
    activeApiProfileId: null
  }
}

function toDesktopSettings(settings: PersistedSettings): AppSettings {
  const reasoningMode = settings.reasoningMode === 'deep' ? 'deep' : 'fast'
  const models = settings.models.includes(settings.selectedModel)
    ? [...settings.models]
    : [settings.selectedModel, ...settings.models]
  const disabled = settings.disabledTools ?? []
  const apiProfiles = settings.apiProfiles ?? []
  return {
    selectedModel: settings.selectedModel,
    models,
    reasoningMode,
    themeMode: settings.themeMode ?? 'system',
    disabledTools: toolNameSchema.options.filter((name) => disabled.includes(name)),
    fontScale: Math.min(1.3, Math.max(0.85, settings.fontScale ?? 1)),
    contextWindowTokens: settings.contextWindowTokens ?? 32768,
    preferApiModel: settings.preferApiModel ?? false,
    apiProfiles: apiProfiles.map((profile): ApiProfile => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      hasApiKey: Boolean(profile.apiKeyCiphertext || profile.legacyApiKey),
    })),
    activeApiProfileId: settings.activeApiProfileId ?? null
  }
}

const unavailableSecretProtector: SecretProtector = {
  encrypt: () => { throw new Error('Secure storage unavailable') },
  decrypt: () => { throw new Error('Secure storage unavailable') },
}

function validProfileId(
  requested: string | null | undefined,
  current: string | null,
  profiles: PersistedSettings['apiProfiles']
): string | null {
  if (requested === undefined) return current
  if (requested === null) return null
  return profiles.some((profile) => profile.id === requested) ? requested : current
}

function assertSafeProviderUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new DesktopIpcError('VALIDATION_FAILED', 'API 地址格式无效。')
  }
  if (url.protocol === 'https:') return
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
  if (url.protocol !== 'http:' || !loopback) {
    throw new DesktopIpcError('VALIDATION_FAILED', 'API 地址必须使用 HTTPS；本机地址可以使用 HTTP。')
  }
}

function toSafeIpcError(error: unknown): DesktopIpcError {
  if (error instanceof DesktopIpcError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new DesktopIpcError('CANCELLED', '操作已取消。')
  }
  if (error instanceof NavisworksTargetError) {
    return new DesktopIpcError(error.code, error.message)
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

export function broadcastNavisworksConnectionState(state: NavisworksConnectionState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) emitTo(window.webContents, 'navisworks.instances.changed', state)
  }
}

export async function refreshNavisworksConnectionState(
  registry: NavisworksInstanceRegistry,
  selection: NavisworksInstanceSelection,
  runningInstanceId?: string,
): Promise<NavisworksConnectionState> {
  const instances = await registry.refresh()
  selection.observe(instances)
  return buildNavisworksConnectionState(selection, instances, runningInstanceId)
}

export function buildNavisworksConnectionState(
  selection: NavisworksInstanceSelection,
  instances: readonly NavisworksInstance[],
  runningInstanceId?: string,
): NavisworksConnectionState {
  return {
    instances: selection.instancesForUi(instances).map((instance) => ({
      instanceId: instance.instanceId,
      processId: instance.processId,
      connected: instance.connected,
      ...(instance.documentName === undefined ? {} : { documentName: instance.documentName }),
      hostVersion: instance.hostVersion,
      pluginVersion: instance.pluginVersion,
    })),
    ...(selection.selectedInstanceId === undefined
      ? {}
      : { selectedInstanceId: selection.selectedInstanceId }),
    ...(runningInstanceId === undefined ? {} : { runningInstanceId }),
  }
}

function statusForSelectedInstance(
  registry: NavisworksInstanceRegistry,
  selection: NavisworksInstanceSelection,
): NavisworksStatus {
  const selected = selection.selected(registry.instances)
  if (selected === undefined) return { connected: false, status: 'Navisworks 未连接' }
  if (!selected.connected) {
    return {
      connected: false,
      status: '当前 Navisworks 已断开',
      instanceId: selected.instanceId,
      ...(selected.documentName === undefined ? {} : { documentName: selected.documentName }),
    }
  }
  return {
    connected: true,
    status: selected.documentName ?? '已连接 Navisworks',
    instanceId: selected.instanceId,
    ...(selected.documentName === undefined ? {} : { documentName: selected.documentName }),
    ...(selected.bridgeSessionId === undefined ? {} : { bridgeSessionId: selected.bridgeSessionId }),
    ...(selected.documentInstanceId === undefined
      ? {}
      : { documentInstanceId: selected.documentInstanceId }),
  }
}

const NAVISWORKS_STATUS_POLL_MS = 5_000

/**
 * Polls the plugin endpoint so a Navisworks instance launched AFTER this app
 * (or one that just closed) is picked up without a manual refresh.
 * readNavisworksStatus never rejects — failures map to connected:false — and
 * only changed snapshots are broadcast, so an idle setup stays quiet.
 */
export function startNavisworksStatusPolling(
  bridge: NavisworksBridgeClient,
  intervalMs: number = NAVISWORKS_STATUS_POLL_MS,
  onStatus?: (status: NavisworksStatus) => void
): () => void {
  let lastSignature = ''
  const timer = setInterval(() => {
    void readNavisworksStatus(bridge)
      .then((status) => {
        // Feed the Document Scope on EVERY poll (even unchanged) so identity invalidation
        // is independent of the broadcast dedupe below.
        onStatus?.(status)
        const signature = JSON.stringify(status)
        if (signature === lastSignature) return
        lastSignature = signature
        broadcastNavisworksStatus(status)
      })
      .catch(() => {
        // Defensive: polling must survive even an unexpected rejection.
      })
  }, intervalMs)
  return () => clearInterval(timer)
}

export function startNavisworksInstancesPolling(
  registry: NavisworksInstanceRegistry,
  selection: NavisworksInstanceSelection,
  intervalMs: number = NAVISWORKS_STATUS_POLL_MS,
  onStatus?: (status: NavisworksStatus) => void,
): () => void {
  let lastSignature = ''
  const timer = setInterval(() => {
    void refreshNavisworksConnectionState(registry, selection)
      .then((state) => {
        const status = statusForSelectedInstance(registry, selection)
        onStatus?.(status)
        const signature = JSON.stringify(state)
        if (signature === lastSignature) return
        lastSignature = signature
        broadcastNavisworksConnectionState(state)
        broadcastNavisworksStatus(status)
      })
      .catch(() => {
        // Discovery polling is best-effort and must survive one bad refresh.
      })
  }, intervalMs)
  return () => clearInterval(timer)
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
