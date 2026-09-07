import { BridgeError, type BridgeCallOptions } from './bridgeClient'
import type { NavisworksBridgeClient } from './bridgeClient'
import { randomUUID } from 'node:crypto'
import {
  type AgentToolName,
  ToolCatalogError,
} from './toolCatalog'
import { toolRegistry } from './tool/registry'
import type { ToolOutputStore } from './toolOutputStore'
import type { ToolPermission } from '../shared/ipc'
import { ModelRouter } from './model/modelRouter'
import {
  AgentRuntimeError,
  type AgentBridgeClient,
  type ChatMessage,
  type CompletionRequest,
  type ModelProvider,
  type ToolCallWire,
} from './model/types'
import {
  createAbortError,
  errorMessage,
  positiveInteger,
  throwIfAborted,
} from './model/providerUtils'
import type { SamplingOptions } from './model/types'
import type { NavisworksRunBinding } from './navisworks/instanceTypes'
import {
  callWithNavisworksRunBinding,
  NavisworksTargetError,
  validateNavisworksRunBinding,
} from './navisworks/runBinding'
import type { BuiltAgentRequest } from './agent/contextTypes'
import {
  COMPACT_MAX_TRANSCRIPT_CHARS,
  ContextManager,
  LOCAL_MAX_CONTEXT_TOKENS,
  buildAgentRequest,
  clampLocalContextWindow,
  providerSendsContextWindow,
  type ContextBlock,
  type CompactConfig,
} from './agent/contextManager'
import {
  ContextState,
  renderCurrentDocumentContext,
  renderDocumentTransition,
  renderReferenceSetBlock,
  type CurrentDocumentContext,
  type DocumentChangeNotice,
} from './agent/contextState'
import { renderVerifiedFacts } from './agent/facts'
import { localThinkForEffort, nearestReasoningEffort, type ReasoningEffort } from '../shared/reasoning'
import type { ModelInfo, ModelUsage } from '../shared/model'
import {
  DocumentOperationCoordinator,
  ToolExecutionLedger,
  hashArguments,
} from './agent/executionLedger'
import {
  renderSemanticMemory,
  updateSemanticMemory,
  type SemanticMemory,
} from './agent/semanticMemory'
import {
  CURI_CORE_PROMPT,
  NAVISWORKS_CAPABILITY_PROMPT,
} from './agent/prompts'
import type {
  ApiProfileAdvancedSettings,
  ContextWindowSource,
  ExecutionSettings,
} from '../shared/ipc'
import { TaskManager, type TaskVerification } from './agent/taskManager'
import { TaskPlanner } from './agent/taskPlanner'
import { TaskVerifier } from './agent/taskVerifier'
import { renderTaskContext, type TaskVerificationFeedback } from './agent/taskContext'
import {
  MAX_TASK_REPLANS,
  REPLAN_LIMIT_REASON,
  type CuriTask,
  type TaskPauseReason,
} from './agent/taskTypes'

type AgentRequest = Omit<CompletionRequest, 'sampling'> & { sampling?: SamplingOptions }
type CompleteResult = Awaited<ReturnType<ModelProvider['complete']>>

const DEFAULT_MODEL = 'qwen3.5:9b-q4_K_M'
const MAX_TOOL_ROUNDS = 8

/**
 * Run-scoped agent execution policy. Formerly local-model hardcodes (24-message
 * history, 4000-char tool results, fixed compaction, planner/verifier attempt
 * caps) are user-configurable per run; every field is clamped again at the
 * runtime boundary so a bad settings file can never disable the safety rails.
 */
export interface AgentRuntimeSettings {
  maxToolRounds: number
  compactionEnabled: boolean
  compactionTriggerRatio: number
  compactKeepRecentFrames: number
  compactMaxTranscriptChars: number
  historyMode: 'auto' | 'fixed'
  historyMessageLimit?: number
  toolResultMode: 'auto' | 'fixed'
  toolResultMaxChars?: number
  plannerMaxAttempts: number
  plannerMaxSteps: number
  plannerMaxTokens: number | null
  verifierMaxAttempts: number
  verifierMaxEvidence: number
  maxTaskReplans: number
  /**
   * Per-call timeout for the hidden planner/verifier model calls. Undefined =
   * the INTERNAL_TASK_CALL_TIMEOUT_MS default; tests inject a short value.
   */
  taskCallTimeoutMs?: number
}

export const DEFAULT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  maxToolRounds: MAX_TOOL_ROUNDS,
  compactionEnabled: true,
  compactionTriggerRatio: 0.85,
  compactKeepRecentFrames: 1,
  compactMaxTranscriptChars: 30_000,
  historyMode: 'auto',
  historyMessageLimit: undefined,
  toolResultMode: 'auto',
  toolResultMaxChars: undefined,
  plannerMaxAttempts: 2,
  plannerMaxSteps: 10,
  plannerMaxTokens: 2048,
  verifierMaxAttempts: 2,
  verifierMaxEvidence: 12,
  maxTaskReplans: MAX_TASK_REPLANS,
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Map the persisted execution settings onto run-scope config with hard ceilings. */
export function toAgentRuntimeSettings(execution: ExecutionSettings | undefined): AgentRuntimeSettings {
  const source = execution ?? DEFAULT_RUNTIME_SETTINGS
  return {
    maxToolRounds: clampInt(source.maxToolRounds, DEFAULT_RUNTIME_SETTINGS.maxToolRounds, 1, 64),
    compactionEnabled: source.compactionEnabled !== false,
    compactionTriggerRatio: Math.min(0.98, Math.max(0.5, source.compactionTriggerRatio || 0.85)),
    compactKeepRecentFrames: clampInt(source.compactKeepRecentFrames, 1, 0, 20),
    compactMaxTranscriptChars: clampInt(source.compactMaxTranscriptChars, 30_000, 2_000, 200_000),
    historyMode: source.historyMode === 'fixed' ? 'fixed' : 'auto',
    historyMessageLimit: source.historyMode === 'fixed' && source.historyMessageLimit
      ? clampInt(source.historyMessageLimit, 24, 4, 1_000)
      : undefined,
    toolResultMode: source.toolResultMode === 'fixed' ? 'fixed' : 'auto',
    toolResultMaxChars: source.toolResultMode === 'fixed' && source.toolResultMaxChars
      ? clampInt(source.toolResultMaxChars, 4_000, 500, 200_000)
      : undefined,
    plannerMaxAttempts: clampInt(source.plannerMaxAttempts, 2, 1, 5),
    plannerMaxSteps: clampInt(source.plannerMaxSteps, 10, 1, 32),
    plannerMaxTokens: source.plannerMaxTokens === null
      ? null
      : clampInt(source.plannerMaxTokens ?? 2048, 2048, 256, 200_000),
    verifierMaxAttempts: clampInt(source.verifierMaxAttempts, 2, 1, 5),
    verifierMaxEvidence: clampInt(source.verifierMaxEvidence, 12, 2, 50),
    maxTaskReplans: clampInt(source.maxTaskReplans, DEFAULT_RUNTIME_SETTINGS.maxTaskReplans, 0, 16),
  }
}

// Task System v1: stateless planning/verification callers shared across runs.
// Both talk to the SAME provider/model the user is already using (Section 三十二)
// through their internal tool schemas — never a separate client or API key.
const TASK_PLANNER = new TaskPlanner()
const TASK_VERIFIER = new TaskVerifier()

/** Evidence summaries stored per tool result; tasks.json keeps references, not payloads. */
const MAX_EVIDENCE_SUMMARY_CHARS = 600

/**
 * Auto tool-result sizing: a dynamic share of the remaining context budget
 * (~2 chars per token, conservative for CJK-mixed payloads), bounded so a
 * 1M-token window cannot encourage unbounded dumps.
 */
function resolveToolResultCharLimit(
  config: AgentRuntimeSettings,
  contextTokensUsed: number,
  effectiveWindow: number,
  outputReserve: number,
): number {
  if (config.toolResultMode === 'fixed' && config.toolResultMaxChars) {
    return config.toolResultMaxChars
  }
  const remainingTokens = Math.max(0, effectiveWindow - contextTokensUsed - outputReserve - 1_024)
  return Math.max(2_000, Math.min(32_000, remainingTokens * 2))
}

/** The completion gate's return: either keep the agent loop running or stop the run now. */
type TaskGateOutcome =
  | { kind: 'stop'; result: AgentRunResult }
  | { kind: 'continue' }

// Automatic context compaction is decided by ContextManager.contextPressure(usage,
// effectiveWindow) — provider-neutral (Invariant G). Both local and API providers use a
// finite internal budget; only Ollama receives that budget as num_ctx.

class ToolExecutionGuardError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ToolExecutionGuardError'
  }
}

export interface AgentHistoryEntry {
  role: 'user' | 'assistant' | 'ai'
  content: string
}

export type AgentRunEvent =
  | { phase: 'text'; delta: string }
  | { phase: 'thinking'; delta: string }
  /** Run-phase signal: the completion gate is verifying the active task. */
  | { phase: 'verifying' }
  /** Back to normal generation after a gate verdict kept the loop running. */
  | { phase: 'generating' }
  | {
      phase: 'started'
      runId: string
      toolCallId: string
      tool: string
      arguments: Record<string, unknown>
    }
  | {
      phase: 'completed'
      runId: string
      toolCallId: string
      tool: string
      arguments: Record<string, unknown>
      result?: unknown
      error?: { code: string; message: string; ambiguousOutcome?: boolean }
    }

export interface ApiEndpointConfig {
  baseUrl?: string
  apiKey?: string
  model?: string
  /** Profile-level compatibility & capability overrides (null fields = auto). */
  advanced?: ApiProfileAdvancedSettings
}

export interface AgentRunInput {
  /** IPC run/session identity. Direct unit tests may omit both. */
  runId?: string
  sessionId?: string
  text: string
  history?: readonly AgentHistoryEntry[]
  model?: string
  reasoningMode?: ReasoningEffort
  disabledTools?: readonly string[]
  /** Explicit per-tool permission overrides (allow/ask/deny) for this run. */
  toolPermissions?: Record<string, ToolPermission>
  api?: ApiEndpointConfig
  /**
   * P5/P7: the runtime-resolved ModelInfo for THIS run (ModelResolver output).
   * Carries the reasoning-mode floor so an illegal persisted step can never
   * reach the request schema. Absent → every previous behavior unchanged.
   */
  runtimeModel?: ModelInfo
  /** Run-scope execution policy; falls back to the legacy defaults when absent. */
  runtimeConfig?: AgentRuntimeSettings
  /** P4: durable digest of earlier (compacted) turns, injected as a leading system block. */
  compactSummary?: string
  semanticMemory?: SemanticMemory
  /** Runtime-only environment notice; never persisted into conversation history. */
  documentNotice?: DocumentChangeNotice
  /** Stable preflight snapshot for this Run Scope. */
  currentDocument?: CurrentDocumentContext
  navisworksBinding?: NavisworksRunBinding
  navisworksUnavailable?: { code: 'TARGET_INSTANCE_DISCONNECTED'; message: string }
}

export interface RunAgentOptions {
  signal?: AbortSignal
  onEvent?: (event: AgentRunEvent) => void
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<boolean>
}

export interface ToolApprovalRequest {
  runId: string
  toolCallId: string
  toolName: AgentToolName
  arguments: Record<string, unknown>
  argumentsHash: string
  instanceId?: string
  bridgeSessionId?: string
  documentInstanceId?: string
  ambiguousRetry?: boolean
}

export interface AgentRunResult {
  isSuccess: boolean
  message: string
  /** @deprecated Derived from `usage` — kept for legacy IPC/renderer fields. */
  contextTokensUsed: number
  thinkingText?: string
  /**
   * P6: the last model round's RAW provider usage — the single source of
   * truth. Absent only when the provider reported nothing (≠ reported zero).
   */
  usage?: ModelUsage
  /** Cached prompt tokens / prompt tokens of the last round, when reported. */
  cacheHitRate?: number
  /** P5: the model this run actually resolved to, for renderer-side display. */
  activeModel?: ModelInfo
  /**
   * The finite context window this run actually budgeted against — the local
   * clamp for Ollama, the provider/model capability window (or the configured
   * fallback) for API endpoints. Reported so the UI's usage ring measures
   * against the real budget instead of guessing the provider's window.
   */
  contextWindowTokens?: number
  /** Where `contextWindowTokens` came from ('fallback' = safety budget, not a model limit). */
  contextWindowSource?: ContextWindowSource
  /** True when automatic context compaction ran during this run. */
  compacted?: boolean
  /** P4: the compact summary produced this run (if any), for durable persistence. */
  compactSummary?: string
  semanticMemory?: SemanticMemory
  errorCode?: string
}

export interface AgentRuntimeOptions {
  bridgeClient: AgentBridgeClient
  /** Default model when a run input does not name one. */
  model?: string
  /** Default reasoning toggle when a run input has no reasoning mode. */
  think?: boolean
  contextWindow?: number
  numPredict?: number
  requestTimeoutMs?: number
  maxToolRounds?: number
  fetchImpl?: typeof fetch
  /**
   * Live Document Scope. When supplied, each tool result is deterministically mined for
   * Verified Facts + an ordered Reference Set, and (local runs) the last result set is
   * injected into context so "第一个 / 第三个" resolve across turns (docs/context-runtime.md
   * §P2). Omitted in unit tests → the runtime behaves exactly as before.
   */
  contextState?: ContextState
  /** P5: modifying-call lifecycle + crash-recovery record. Optional (tests omit it). */
  executionLedger?: ToolExecutionLedger
  /** P5: serializes view-state-change per document; read-only stays concurrent. */
  operationCoordinator?: DocumentOperationCoordinator
  /** Resolve an externalized persisted tool result for runtime-internal recall. */
  resolveToolResult?: (value: unknown) => Promise<unknown>
  /** Bounded tool-output store: large results become preview + resultRef. */
  toolOutputStore?: ToolOutputStore
  /**
   * Task System v1: durable task lifecycle (plan/evidence/verify). Optional —
   * omitted in unit tests and every behavior stays exactly as before.
   */
  taskManager?: TaskManager
}

export { AgentRuntimeError } from './model/types'
export type { ContextWindowSource } from '../shared/ipc'

/**
 * API context-window resolution with an explicit SOURCE, so the UI can say
 * WHERE the number came from instead of presenting a fallback budget as the
 * model's real limit. Priority: profile override → provider capability →
 * safe fallback (the configured local default; never presented as a model
 * maximum).
 */
export interface ApiContextWindowResolution {
  window: number
  source: ContextWindowSource
}

export function resolveApiContextWindow(
  profileTokens: number | null | undefined,
  capabilities: { maxContextWindow?: number; defaultContextWindow?: number },
  fallbackConfigured: number,
): ApiContextWindowResolution {
  if (profileTokens != null) {
    return { window: Math.max(1024, profileTokens), source: 'profile' }
  }
  if (capabilities.maxContextWindow != null) {
    return { window: Math.max(1024, capabilities.maxContextWindow), source: 'provider' }
  }
  if (capabilities.defaultContextWindow != null) {
    return { window: Math.max(1024, capabilities.defaultContextWindow), source: 'provider' }
  }
  return { window: Math.max(1024, fallbackConfigured), source: 'fallback' }
}
export type { AgentBridgeClient } from './model/types'

export class AgentRuntime {
  readonly #bridgeClient: AgentBridgeClient
  readonly #router: ModelRouter
  readonly #model: string
  readonly #think: boolean
  readonly #contextWindow: number
  readonly #numPredict: number
  readonly #maxToolRounds: number
  readonly #toolOutputStore: ToolOutputStore | undefined
  readonly #contextState: ContextState | undefined
  readonly #executionLedger: ToolExecutionLedger | undefined
  readonly #operationCoordinator: DocumentOperationCoordinator | undefined
  readonly #resolveToolResult: ((value: unknown) => Promise<unknown>) | undefined
  readonly #taskManager: TaskManager | undefined

  constructor(options: AgentRuntimeOptions) {
    this.#bridgeClient = options.bridgeClient
    this.#router = new ModelRouter({
      requestTimeoutMs: options.requestTimeoutMs,
      fetchImpl: options.fetchImpl,
    })
    this.#model = (options.model ?? DEFAULT_MODEL).trim()
    this.#think = options.think ?? false
    // Store the configured window raw; the local clamp lives in ContextManager now and is
    // applied per request only when the provider actually consumes a window (Invariant G).
    this.#contextWindow = options.contextWindow ?? LOCAL_MAX_CONTEXT_TOKENS
    this.#numPredict = Math.max(1, Math.trunc(options.numPredict ?? 2048))
    this.#maxToolRounds = positiveInteger(options.maxToolRounds ?? MAX_TOOL_ROUNDS, 'maxToolRounds')
    this.#toolOutputStore = options.toolOutputStore
    this.#contextState = options.contextState
    this.#executionLedger = options.executionLedger
    this.#operationCoordinator = options.operationCoordinator
    this.#resolveToolResult = options.resolveToolResult
    this.#taskManager = options.taskManager
  }

  /**
   * Title generation follows the ACTIVELY routed provider: in API mode the
   * current endpoint answers (so deleting Ollama someday keeps titles working);
   * only a genuinely local run uses the local daemon.
   */
  async summarizeTitle(text: string, signal?: AbortSignal, api?: ApiEndpointConfig): Promise<string> {
    const apiActive = Boolean(api?.baseUrl && api.model?.trim())
    if (apiActive) {
      const provider = this.#apiProvider(api!)
      const response = await provider.complete({
        model: api!.model!.trim(),
        messages: [
          { role: 'system', content: '根据用户的第一条消息生成一个简洁的会话标题：不超过 20 个字，不要标点或引号，只输出标题本身。' },
          { role: 'user', content: text },
        ],
        sampling: { temperature: 0.2, maxTokens: 64 },
        ...(signal ? { signal } : {}),
      })
      const title = response.content.trim()
      if (!title) {
        throw new AgentRuntimeError('MODEL_EMPTY_RESPONSE', '标题生成没有返回结果。')
      }
      return title
    }
    const provider = this.#router.local()
    const summarize = provider.summarizeTitle
    if (!summarize) {
      throw new AgentRuntimeError('MODEL_INVALID_RESPONSE', '本地模型不支持标题生成。')
    }
    return summarize.call(provider, this.#model, text, signal)
  }

  async run(rawInput: string | AgentRunInput, options: RunAgentOptions = {}): Promise<AgentRunResult> {
    const input: AgentRunInput = typeof rawInput === 'string' ? { text: rawInput } : rawInput
    const trimmedInput = input.text.trim()
    if (!trimmedInput) {
      return {
        isSuccess: false,
        message: '消息不能为空。',
        contextTokensUsed: 0,
        errorCode: 'EMPTY_INPUT',
      }
    }

    const api = input.api
    const apiActive = Boolean(api?.baseUrl && api.model?.trim())
    console.debug(
      `[model] resolved provider=${apiActive ? 'api' : 'ollama'} model=${apiActive ? api!.model!.trim() : (input.model?.trim() || this.#model)}`,
    )
    // Run-scope policy: chat.start passes the FRESH settings every time, so
    // execution changes apply on the very next message — no app restart.
    const runtimeConfig = input.runtimeConfig ?? DEFAULT_RUNTIME_SETTINGS
    const provider = apiActive ? this.#apiProvider(api!) : this.#router.local()
    const disabledTools = input.disabledTools
    // Registry materialization: deny tools never reach the model, ask tools
    // are offered but gate on approval, allow tools run silently.
    const tools = toolRegistry.materialize({
      permissions: input.toolPermissions,
      legacyDisabled: disabledTools,
    })
    const model = apiActive
      ? api!.model!.trim()
      : (input.model?.trim() || this.#model)
    // P7 capability floor: a persisted/selected step the active model does not
    // support (e.g. xhigh against Ollama's low/max, or any step when the API
    // profile sends no reasoning_effort) snaps to the nearest legal one, so an
    // illegal mode can never reach the request schema or the wire.
    const modeFloor = input.runtimeModel?.reasoning.modes
    const rawEffort = input.reasoningMode
    const effort: ReasoningEffort | undefined = rawEffort === undefined || modeFloor === undefined
      ? rawEffort
      : modeFloor.length === 0
        ? undefined
        : nearestReasoningEffort(rawEffort, modeFloor) ?? modeFloor[0]
    const think = apiActive
      ? false
      : (effort === undefined ? this.#think : localThinkForEffort(effort))

    // A single execution scope id for this run; the P5 ledger attributes modifying calls
    // to it so crash recovery / approval re-checks can correlate a call with its run.
    const runId = input.runId?.trim() || randomUUID()
    // Context window + its SOURCE. API priority: profile override → provider
    // capability → safe fallback. The LOCAL 32768 clamp never applies to API
    // endpoints, and the fallback is budget accounting — never presented as
    // the model's real maximum.
    const advanced = apiActive ? api!.advanced ?? undefined : undefined
    const capabilities = provider.capabilities(model)
    const localWindow = clampLocalContextWindow(this.#contextWindow)
    const apiResolution = resolveApiContextWindow(
      advanced?.contextWindowTokens,
      capabilities,
      this.#contextWindow,
    )
    const usingLocalWindow = provider.kind === 'ollama'
    const effectiveWindow = usingLocalWindow ? localWindow : apiResolution.window
    const contextWindowSource: ContextWindowSource = usingLocalWindow
      ? 'local'
      : apiResolution.source
    // Output reserve: budgeting always needs a number, but the WIRE parameter
    // is only sent when the profile configures one — an API run with
    // maxOutputTokens=null no longer inherits the local 2048 cap.
    const outputReserve = apiActive
      ? (advanced?.maxOutputTokens ?? 4_096)
      : this.#numPredict
    const maxToolRounds = runtimeConfig.maxToolRounds
    const contextBlocks: ContextBlock[] = [
      {
        kind: 'other',
        message: {
          role: 'system',
          content: NAVISWORKS_CAPABILITY_PROMPT,
        },
      },
    ]
    // Task System v1: resume the session's latest unfinished task as Active
    // Task Context (block order: capability → task-state → document…). A paused
    // task never auto-executes — it re-enters running only when the model
    // produces tool calls again during THIS run (Section 十四).
    const taskManager = this.#taskManager
    const sessionId = input.sessionId
    let activeTask: CuriTask | undefined
    if (taskManager !== undefined && sessionId !== undefined) {
      activeTask = taskManager.getResumableTaskForSession(sessionId)
      if (activeTask !== undefined) {
        contextBlocks.push({
          kind: 'task-state',
          message: { role: 'system', content: renderTaskContext(activeTask) },
        })
      }
    }
    const currentDocumentBlock = renderCurrentDocumentContext(
      input.currentDocument ?? this.#contextState?.currentDocument,
    )
    if (currentDocumentBlock) contextBlocks.push({
      kind: 'document-transition',
      message: { role: 'system', content: currentDocumentBlock },
    })
    const documentTransitionBlock = renderDocumentTransition(input.documentNotice)
    if (documentTransitionBlock) contextBlocks.push({
      kind: 'document-transition',
      message: { role: 'system', content: documentTransitionBlock },
    })
    const semanticMemory = input.sessionId === undefined
      ? input.semanticMemory
      : updateSemanticMemory(input.semanticMemory, trimmedInput)
    const semanticMemoryBlock = renderSemanticMemory(semanticMemory)
    if (semanticMemoryBlock) contextBlocks.push({
      kind: 'semantic-memory',
      message: { role: 'system', content: semanticMemoryBlock },
    })
    if (input.compactSummary?.trim()) {
      contextBlocks.push({
        kind: 'compact-summary',
        message: {
          role: 'system',
          content: `早期对话摘要（供参考，非实时事实）：\n${input.compactSummary.trim()}`,
        },
      })
    }
    if (this.#contextState !== undefined) {
      const factsBlock = renderVerifiedFacts(this.#contextState.factsForCurrentDocument())
      if (factsBlock) contextBlocks.push({
        kind: 'verified-facts',
        message: { role: 'system', content: factsBlock },
      })
      const referenceSet = this.#contextState.lastRelevantReferenceSet(input.sessionId)
      const referenceBlock = renderReferenceSetBlock(referenceSet)
      if (referenceBlock) contextBlocks.push({
        kind: 'reference-set',
        message: { role: 'system', content: referenceBlock },
      })
      if (referenceSet !== undefined && input.sessionId !== undefined) {
        const recalled = await this.#contextState.recallToolResult(
          input.sessionId,
          referenceSet.sourceToolCallId,
          this.#resolveToolResult,
        )
        if (recalled !== undefined) {
          contextBlocks.push({
            kind: 'recall',
            message: {
              role: 'system',
              content: `【最近引用集的持久化来源（内部召回）】\n${clip(JSON.stringify(recalled), 4_000)}`,
            },
          })
        }
      }
    }
    const contextManager = new ContextManager({
      systemPrompt: CURI_CORE_PROMPT,
      history: normalizeHistory(input.history ?? [], runtimeConfig),
      contextBlocks,
    })
    contextManager.addUserTurn({ role: 'user', content: trimmedInput })
    let latestContextTokens = 0
    let latestUsage: ModelUsage | undefined
    let latestCacheHitRate: number | undefined
    let lastAssistantText = ''
    let didCompactRun = false
    let capturedSummary: string | undefined

    // --- Task System v1 run-scoped state (all no-ops without a TaskManager) ---
    const plannerOptions = {
      maxAttempts: runtimeConfig.plannerMaxAttempts,
      maxSteps: runtimeConfig.plannerMaxSteps,
      maxTokens: runtimeConfig.plannerMaxTokens,
      ...(runtimeConfig.taskCallTimeoutMs === undefined ? {} : { callTimeoutMs: runtimeConfig.taskCallTimeoutMs }),
    }
    const verifierOptions = {
      maxAttempts: runtimeConfig.verifierMaxAttempts,
      maxEvidence: runtimeConfig.verifierMaxEvidence,
      ...(runtimeConfig.taskCallTimeoutMs === undefined ? {} : { callTimeoutMs: runtimeConfig.taskCallTimeoutMs }),
    }
    const taskContextFeedback: { verification?: TaskVerificationFeedback } = {}
    let taskDecisionMade = false
    let verificationDisabled = false
    const recentToolOutcomes: Array<{ toolName: string; ok: boolean; summary: string }> = []
    const refreshTaskContext = (): void => {
      if (activeTask === undefined) return
      contextManager.setSingletonContextBlock('task-state', {
        role: 'system',
        content: renderTaskContext(activeTask, taskContextFeedback.verification),
      })
    }
    // End-of-run safety: a task left running by a round limit, model error or
    // user abort must not stay running — pause it so the next run can resume.
    const pauseIfRunning = async (reason: TaskPauseReason): Promise<void> => {
      if (taskManager === undefined || activeTask?.status !== 'running') return
      try {
        activeTask = await taskManager.pause(activeTask.id, reason)
      } catch (pauseError) {
        console.debug(`[task] pause failed: ${errorMessage(pauseError)}`)
      }
    }
    // Verifier/planner failures must degrade, except aborts which propagate so
    // the outer catch can record USER_ABORTED (never a fabricated verdict).
    const verifyOrDegrade = async (): Promise<TaskVerification | null> => {
      try {
        return await TASK_VERIFIER.verify(provider, model, {
          task: activeTask!,
          agentAnswer: lastAssistantText || undefined,
          recentToolOutcomes,
        }, options.signal, verifierOptions)
      } catch (error) {
        if (options.signal?.aborted) throw error
        console.debug(`[task] verifier error: ${errorMessage(error)}`)
        return null
      }
    }
    try {
      // Section 一/1.3: budget-check BEFORE the first model call, not just on later rounds.
      const initialTokens = contextManager.estimateRequestTokens(tools, outputReserve)
      if (runtimeConfig.compactionEnabled
        && ContextManager.contextPressure(initialTokens, effectiveWindow, runtimeConfig.compactionTriggerRatio) === 'compact') {
        const compacted = await this.#compactMessages(contextManager, input, options, runtimeConfig)
        if (compacted) {
          didCompactRun = true
          capturedSummary = compacted
        }
      }
      for (let round = 0; round < maxToolRounds; round += 1) {
        throwIfAborted(options.signal)
        // Auto-compaction (P4): usage/effectiveWindow decides pressure — the SAME rule for
        // local and cloud (Invariant G).
        if (runtimeConfig.compactionEnabled
          && ContextManager.contextPressure(latestContextTokens, effectiveWindow, runtimeConfig.compactionTriggerRatio) === 'compact') {
          const compacted = await this.#compactMessages(contextManager, input, options, runtimeConfig)
          if (compacted) {
            didCompactRun = true
            capturedSummary = compacted
          }
        }
        const built = contextManager.assembleBudgetedFrames({
          tools,
          temperature: 0.1,
          maxTokens: outputReserve,
          effectiveWindow,
          sendContextWindow: provider.kind === 'ollama',
        })
        // maxOutputTokens=null (API auto) → send NO output-limit parameter at
        // all; a configured value rides through in the profile's chosen
        // parameter name (openaiProvider gates the wire field).
        const requestSampling = apiActive && advanced?.maxOutputTokens == null
          ? { ...built.sampling, maxTokens: undefined }
          : built.sampling
        const response = await provider.complete({
          model,
          messages: built.messages,
          tools: built.tools,
          think,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          sampling: requestSampling,
          signal: options.signal,
          onDelta: (delta) => {
            if (delta.text !== undefined) options.onEvent?.({ phase: 'text', delta: delta.text })
            if (delta.thinking !== undefined) options.onEvent?.({ phase: 'thinking', delta: delta.thinking })
          },
        })
        latestContextTokens = response.contextTokensUsed
        latestUsage = response.usage
        latestCacheHitRate = response.cacheHitRate
        lastAssistantText = response.content.trim()

        const finishSuccess = (message: string = lastAssistantText): AgentRunResult => ({
          isSuccess: true,
          message,
          contextTokensUsed: latestContextTokens,
          ...(latestUsage === undefined ? {} : { usage: latestUsage }),
          ...(input.runtimeModel === undefined ? {} : { activeModel: input.runtimeModel }),
          contextWindowTokens: effectiveWindow,
          contextWindowSource,
          ...(response.thinking.trim() ? { thinkingText: response.thinking } : {}),
          ...(latestCacheHitRate === undefined ? {} : { cacheHitRate: latestCacheHitRate }),
          ...(didCompactRun ? { compacted: true } : {}),
          ...(capturedSummary === undefined || capturedSummary === '' ? {} : { compactSummary: capturedSummary }),
          ...(semanticMemory === undefined ? {} : { semanticMemory }),
        })

        // The Completion Gate (Sections 二十/二十三): judge the ACTIVE task
        // against its completion criteria — with the agent's draft answer as
        // context only. verdict complete → complete + return; continue/replan →
        // fold verifier feedback into the task context and loop on; blocked →
        // block + hand the blocker to the user. A broken verifier degrades
        // (paused VERIFIER_ERROR), it NEVER reads as complete.
        const runCompletionGate = async (): Promise<TaskGateOutcome> => {
          if (taskManager === undefined || activeTask === undefined) return { kind: 'continue' }
          console.debug(`[chat-run] VERIFY_START run=${runId} task=${activeTask.id}`)
          options.onEvent?.({ phase: 'verifying' })
          const verification = await verifyOrDegrade()
          if (verification === null) {
            console.debug(`[chat-run] VERIFY_TIMEOUT run=${runId} task=${activeTask.id}`)
            verificationDisabled = true
            await pauseIfRunning('VERIFIER_ERROR')
            return response.toolCalls.length === 0
              ? {
                  kind: 'stop',
                  result: finishSuccess(
                    `${lastAssistantText}\n\n（任务完成状态暂时无法确认，任务已暂停；需要时让 Curi 继续该任务以完成验证。）`,
                  ),
                }
              : { kind: 'continue' }
          }
          taskContextFeedback.verification = {
            verdict: verification.verdict,
            reason: verification.reason,
            ...(verification.missingEvidence === undefined ? {} : { missingEvidence: verification.missingEvidence }),
            ...(verification.nextAction === undefined ? {} : { nextAction: verification.nextAction }),
          }
          console.debug(`[chat-run] VERIFY_DONE run=${runId} verdict=${verification.verdict} task=${activeTask.id}`)
          if (verification.verdict === 'complete') {
            activeTask = await taskManager.complete(activeTask.id)
            refreshTaskContext()
            return response.toolCalls.length === 0
              ? { kind: 'stop', result: finishSuccess() }
              : { kind: 'continue' }
          }
          if (verification.verdict === 'blocked') {
            activeTask = await taskManager.block(activeTask.id, verification.blockedReason ?? 'BLOCKED')
            refreshTaskContext()
            const blocker = `任务已阻塞：${verification.reason}`
              + (verification.nextAction ? ` 下一步：${verification.nextAction}` : '')
            return { kind: 'stop', result: finishSuccess(blocker) }
          }
          if (verification.verdict === 'replan') {
            if (activeTask.replanCount >= runtimeConfig.maxTaskReplans) {
              activeTask = await taskManager.block(activeTask.id, REPLAN_LIMIT_REASON)
              refreshTaskContext()
              return {
                kind: 'stop',
                result: finishSuccess(`任务已阻塞（重规划次数已达上限）：${verification.reason}`),
              }
            }
            const replan = await TASK_PLANNER.replan(provider, model, {
              task: activeTask,
              failureReason: verification.reason,
              ...(verification.missingEvidence === undefined ? {} : { missingEvidence: verification.missingEvidence }),
            }, options.signal, plannerOptions).catch((error) => {
              if (options.signal?.aborted) throw error
              console.debug(`[task] replanner error: ${errorMessage(error)}`)
              return null
            })
            if (replan === null) {
              verificationDisabled = true
              await pauseIfRunning('REPLAN_FAILED')
              return response.toolCalls.length === 0
                ? {
                    kind: 'stop',
                    result: finishSuccess(
                      `${lastAssistantText}\n\n（重新规划暂时失败，任务已暂停；需要时让 Curi 继续该任务。）`,
                    ),
                  }
                : { kind: 'continue' }
            }
            console.debug(`[task] TASK_REPLAN task=${activeTask.id} planVersion=${activeTask.planVersion + 1}`)
            activeTask = await taskManager.replacePlan(activeTask.id, replan)
            refreshTaskContext()
            return { kind: 'continue' }
          }
          // verdict = continue: task state + verifier feedback are now in the
          // task context; the next round keeps calling the tools it needs.
          activeTask = await taskManager.applyVerification(activeTask.id, verification)
          refreshTaskContext()
          options.onEvent?.({ phase: 'generating' })
          return { kind: 'continue' }
        }

        if (response.toolCalls.length === 0) {
          if (!lastAssistantText) {
            await pauseIfRunning('MODEL_ERROR')
            return {
              isSuccess: false,
              message: '模型没有返回文本或工具调用，请重试或更换模型。',
              contextTokensUsed: latestContextTokens,
              contextWindowTokens: effectiveWindow,
        contextWindowSource,
              errorCode: 'MODEL_EMPTY_RESPONSE',
            }
          }
          if (activeTask !== undefined && activeTask.status === 'running' && !verificationDisabled) {
            console.debug(`[chat-run] MODEL_RESPONSE_COMPLETE run=${runId} (entering completion gate)`)
            const gate = await runCompletionGate()
            if (gate.kind === 'stop') return gate.result
            // Verdict continue/replan: the refreshed task context now guides
            // the next model round — skip tool processing for THIS response.
            continue
          } else {
            return finishSuccess()
          }
        }

        // Task creation trigger (Section 十三): exactly once per run, on the
        // first tool-call round, before anything executes. Plain chats and
        // session-less unit tests never reach here with a TaskManager.
        if (taskManager !== undefined && sessionId !== undefined
          && !taskDecisionMade && activeTask === undefined) {
          taskDecisionMade = true
          const decision = await TASK_PLANNER.plan(provider, model, {
            userGoal: trimmedInput,
            constraints: semanticMemory?.constraints ?? [],
            ...(currentDocumentBlock ? { documentSummary: clip(currentDocumentBlock, 300) } : {}),
            proposedToolCalls: response.toolCalls.map((call) => ({
              name: call.name,
              arguments: call.arguments,
            })),
          }, options.signal, plannerOptions).catch((error) => {
            if (options.signal?.aborted) throw error
            console.debug(`[task] planner error: ${errorMessage(error)}`)
            return null
          })
          if (decision?.needsTask === true && decision.task !== undefined) {
            activeTask = await taskManager.createTask({
              sessionId,
              ...decision.task,
            })
            console.debug(`[task] TASK_CREATED task=${activeTask.id} steps=${activeTask.steps.length}`)
            refreshTaskContext()
          }
        }
        // A resumable paused/planning task re-enters running only because the
        // model is actually executing tools again this round — never on talk.
        if (taskManager !== undefined && activeTask !== undefined && activeTask.status !== 'running') {
          activeTask = await taskManager.markRunning(activeTask.id)
          taskContextFeedback.verification = undefined
          refreshTaskContext()
          console.debug(`[task] TASK_RUNNING task=${activeTask.id}`)
        }

        const assistantToolMessage: ChatMessage = {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls.map((call): ToolCallWire => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        }
        const toolResultMessages: ChatMessage[] = []
        let roundHadToolFailure = false

        for (const toolCall of response.toolCalls) {
          throwIfAborted(options.signal)
          options.onEvent?.({
            phase: 'started',
            runId,
            toolCallId: toolCall.id,
            tool: toolCall.name,
            arguments: toolCall.arguments,
          })

          let toolResult = await this.#executeTool(
            toolCall,
            runId,
            toolRegistry.resolvePermission(toolCall.name, {
              permissions: input.toolPermissions,
              legacyDisabled: disabledTools,
            }),
            options.signal,
            options.requestToolApproval,
            hasExplicitAmbiguousRetryConfirmation(trimmedInput),
            input.navisworksBinding,
            input.navisworksUnavailable,
          )
          // Bound large tool results ONCE: full data goes to the
          // ToolOutputStore, the model/session receive preview + resultRef.
          if (toolResult.error === undefined && this.#toolOutputStore !== undefined) {
            const bounded = await this.#toolOutputStore.bound({
              sessionId: input.sessionId ?? '',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              data: toolResult.result,
            })
            toolResult = {
              ...toolResult,
              result: bounded.content,
              wire: toolResult.error === undefined
                ? buildToolSuccessObservation(toolCall.name, bounded.content)
                : toolResult.wire,
            }
          }
          options.onEvent?.({
            phase: 'completed',
            runId,
            toolCallId: toolCall.id,
            tool: toolCall.name,
            arguments: toolCall.arguments,
            result: toolResult.result,
            error: toolResult.error,
          })

          const wireResult = JSON.stringify(toolResult.wire)
          toolResultMessages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            // Auto mode sizes the truncation from the remaining context budget
            // each round; a fixed mode uses the user's value. Bigger windows
            // are no longer pinned to the local-model 4000 chars.
            content: truncateToolResult(
              toolCall.name,
              wireResult,
              resolveToolResultCharLimit(runtimeConfig, latestContextTokens, effectiveWindow, outputReserve),
            ),
          })

          // P2: mine this successful result for Verified Facts + an ordered Reference Set,
          // attributed to the current document instance. No-op without a ContextState.
          if (toolResult.error === undefined) {
            this.#contextState?.ingestToolResult(
              toolCall.name,
              toolResult.result,
              toolCall.id,
              input.sessionId,
            )
          }

          // Task evidence (Section 十八/十九): summary + reference only. Raw
          // payloads stay with the session's persisted tool results; tasks.json
          // never grows a second raw-result store.
          if (activeTask !== undefined && taskManager !== undefined) {
            const toolError = toolResult.error
            const toolOk = toolError === undefined
            const evidenceSummary = toolOk
              ? summarizeToolSuccess(toolCall.name, payloadIsRecord(toolResult.result) ? toolResult.result : undefined)
              : `失败 ${toolError.code}：${toolError.message}`
            recentToolOutcomes.push({ toolName: toolCall.name, ok: toolOk, summary: clip(evidenceSummary, 400) })
            await taskManager.recordToolEvidence(activeTask.id, {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              status: toolOk
                ? 'supporting'
                : toolError.ambiguousOutcome === true ? 'unknown' : 'contradicting',
              summary: clip(evidenceSummary, MAX_EVIDENCE_SUMMARY_CHARS),
            })
            if (!toolOk) roundHadToolFailure = true
          }
        }
        contextManager.addToolExchange(assistantToolMessage, toolResultMessages)
        if (activeTask !== undefined) refreshTaskContext()

        // Verifier situation A (Section 二十二): a failed/ambiguous tool round
        // inside an active task gets judged (continue/replan/blocked) before
        // the loop continues — complete is handled the same way it is at the
        // answer-time gate.
        if (roundHadToolFailure && activeTask !== undefined
          && activeTask.status === 'running' && !verificationDisabled) {
          const gate = await runCompletionGate()
          if (gate.kind === 'stop') return gate.result
        }
      }

      // Section 二十八: the run ended without finishing the task — never leave
      // it running; pause with the reason so the next run can resume it.
      await pauseIfRunning('TOOL_ROUND_LIMIT')
      return {
        isSuccess: false,
        message: `工具调用超过 ${maxToolRounds} 轮，已停止以避免循环。请缩小指令范围后重试。`,
        contextTokensUsed: latestContextTokens,
        contextWindowTokens: effectiveWindow,
        contextWindowSource,
        ...(didCompactRun ? { compacted: true } : {}),
        ...(capturedSummary === undefined || capturedSummary === '' ? {} : { compactSummary: capturedSummary }),
        errorCode: 'TOOL_ROUND_LIMIT',
      }
    } catch (error) {
      if (options.signal?.aborted) {
        await pauseIfRunning('USER_ABORTED')
        throw createAbortError(options.signal.reason)
      }
      if (error instanceof AgentRuntimeError) {
        await pauseIfRunning('MODEL_ERROR')
        return {
          isSuccess: false,
          message: error.message,
          contextTokensUsed: latestContextTokens,
          contextWindowTokens: effectiveWindow,
          contextWindowSource,
          errorCode: error.code,
        }
      }
      if (error instanceof NavisworksTargetError) {
        await pauseIfRunning('MODEL_ERROR')
        return {
          isSuccess: false,
          message: error.message,
          contextTokensUsed: latestContextTokens,
          contextWindowTokens: effectiveWindow,
          contextWindowSource,
          errorCode: error.code,
        }
      }
      await pauseIfRunning('MODEL_ERROR')
      return {
        isSuccess: false,
        message: `模型调用失败：${errorMessage(error)}`,
        contextTokensUsed: latestContextTokens,
        contextWindowTokens: effectiveWindow,
        contextWindowSource,
        errorCode: 'MODEL_ERROR',
      }
    }
  }

  async #executeTool(
    toolCall: { id: string; name: string; arguments: Record<string, unknown> },
    runId: string,
    permission: ToolPermission,
    signal?: AbortSignal,
    requestToolApproval?: RunAgentOptions['requestToolApproval'],
    allowAmbiguousRetry = false,
    navisworksBinding?: NavisworksRunBinding,
    navisworksUnavailable?: AgentRunInput['navisworksUnavailable'],
  ): Promise<{ result?: unknown; error?: { code: string; message: string; ambiguousOutcome?: boolean }; wire: Record<string, unknown> }> {
    const ledger = this.#executionLedger
    const isModifying = toolRegistry.get(toolCall.name)?.impact === 'view-state-change'
    let documentAtRequest: string | undefined
    let ledgerStarted = false
    let executing = false
    try {
      toolRegistry.assertAllowed(toolCall.name, toolCall.arguments)
      // Double protection for deny: materialization already hides the tool
      // from the model — a forged call is rejected here as well.
      if (permission === 'deny') {
        const message = `该工具已被用户禁用：${toolCall.name}`
        return {
          error: { code: 'PERMISSION_DENIED', message },
          wire: buildToolErrorObservation(toolCall.name, 'PERMISSION_DENIED', message),
        }
      }
      // Internal tool: reads Curi's own stored tool outputs — no bridge and no
      // Navisworks dependency, so it works while the instance is offline.
      if (toolCall.name === 'read_tool_result') {
        const store = this.#toolOutputStore
        if (store === undefined) {
          const message = '工具结果存储在当前运行中不可用。'
          return {
            error: { code: 'TOOL_OUTPUT_UNAVAILABLE', message },
            wire: buildToolErrorObservation(toolCall.name, 'TOOL_OUTPUT_UNAVAILABLE', message),
          }
        }
        const normalizedArguments = toolRegistry.normalizeArguments(toolCall.name, toolCall.arguments)
        const resultRef = typeof normalizedArguments.resultRef === 'string' ? normalizedArguments.resultRef : ''
        const offset = typeof normalizedArguments.offset === 'number' ? normalizedArguments.offset : 0
        const limit = typeof normalizedArguments.limit === 'number' ? normalizedArguments.limit : 50
        const page = await store.read(resultRef, offset, limit)
        if (page.error !== undefined) {
          const message = page.error
          return {
            error: { code: 'TOOL_OUTPUT_UNAVAILABLE', message },
            wire: buildToolErrorObservation(toolCall.name, 'TOOL_OUTPUT_UNAVAILABLE', message),
          }
        }
        return { result: page, wire: buildToolSuccessObservation(toolCall.name, page) }
      }
      if (navisworksUnavailable !== undefined) {
        throw new NavisworksTargetError(navisworksUnavailable.code, navisworksUnavailable.message)
      }
      const normalizedArguments = toolRegistry.normalizeArguments(toolCall.name, toolCall.arguments)
      if (isModifying) {
        documentAtRequest = navisworksBinding?.documentInstanceId
          ?? this.#contextState?.documentInstanceId
          ?? undefined
        const argumentsHash = hashArguments(normalizedArguments)
        const ambiguous = ledger?.findAmbiguous({
          instanceId: navisworksBinding?.instanceId,
          documentInstanceId: documentAtRequest,
          toolName: toolCall.name,
          argumentsHash,
        })
        if (ambiguous !== undefined && !allowAmbiguousRetry) {
          const message = '上一次相同修改的结果不确定，已阻止自动重试。请先确认当前状态，或明确要求仍然执行。'
          return {
            error: { code: 'AMBIGUOUS_RETRY_BLOCKED', message, ambiguousOutcome: true },
            wire: buildToolErrorObservation(
              toolCall.name,
              'AMBIGUOUS_RETRY_BLOCKED',
              message,
              true,
            ),
          }
        }
        await ledger?.begin({
          runId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          argumentsHash,
          ...(navisworksBinding === undefined
            ? {}
            : {
                instanceId: navisworksBinding.instanceId,
                bridgeSessionId: navisworksBinding.bridgeSessionId,
              }),
          documentInstanceId: documentAtRequest,
        })
        ledgerStarted = ledger !== undefined
        await ledger?.mark(runId, toolCall.id, 'awaiting-approval')
        // permission=allow means the user explicitly opted out of per-call
        // prompts for this tool; ask still goes through the approval flow.
        // Existing ledger/safety checks above stay untouched.
        const approved = permission === 'allow'
          ? true
          : requestToolApproval
          ? await requestToolApproval({
              runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name as AgentToolName,
              arguments: normalizedArguments,
              argumentsHash,
              ...(navisworksBinding === undefined
                ? {}
                : {
                    instanceId: navisworksBinding.instanceId,
                    bridgeSessionId: navisworksBinding.bridgeSessionId,
                  }),
              ...(documentAtRequest === undefined ? {} : { documentInstanceId: documentAtRequest }),
              ...(ambiguous === undefined ? {} : { ambiguousRetry: true }),
            })
          : false
        if (!approved) {
          await ledger?.mark(runId, toolCall.id, 'cancelled')
          const message = '用户取消了本次视图操作。'
          return {
            error: { code: 'TOOL_CANCELLED', message },
            wire: buildToolErrorObservation(toolCall.name, 'TOOL_CANCELLED', message),
          }
        }
        throwIfAborted(signal)
        await ledger?.mark(runId, toolCall.id, 'approved')
        if (navisworksBinding !== undefined) {
          try {
            await validateNavisworksRunBinding(
              this.#bridgeClient as AgentBridgeClient & Pick<NavisworksBridgeClient, 'callToEndpoint'>,
              navisworksBinding,
              { signal },
            )
          } catch (error) {
            if (!(error instanceof NavisworksTargetError)) throw error
            await ledger?.mark(runId, toolCall.id, 'cancelled', 'TARGET_CHANGED')
            const message = '当前 Navisworks 目标已变化，本次操作已取消。'
            return {
              error: { code: 'TARGET_CHANGED', message },
              wire: buildToolErrorObservation(toolCall.name, 'TARGET_CHANGED', message),
            }
          }
        } else if (this.#contextState !== undefined
          && !this.#contextState.canUseDocumentReference(documentAtRequest)) {
          await ledger?.mark(runId, toolCall.id, 'cancelled', 'DOCUMENT_CHANGED')
          const message = '文档已变化，已取消本次视图操作，请重新选择目标后重试。'
          return {
            error: { code: 'DOCUMENT_CHANGED', message },
            wire: buildToolErrorObservation(toolCall.name, 'DOCUMENT_CHANGED', message),
          }
        }
        if (hashArguments(normalizedArguments) !== argumentsHash) {
          await ledger?.mark(runId, toolCall.id, 'cancelled', 'ARGUMENTS_CHANGED')
          const message = '工具参数在审批后发生变化，已取消执行。'
          return {
            error: { code: 'ARGUMENTS_CHANGED', message },
            wire: buildToolErrorObservation(toolCall.name, 'ARGUMENTS_CHANGED', message),
          }
        }
        if (ambiguous !== undefined) {
          await ledger?.resolveAmbiguous(ambiguous, 'USER_CONFIRMED_RETRY')
        }
      }
      // A read-only tool the user set to ask: gate on approval without the
      // modifying-call ledger machinery. Refusal is a PERMISSION result — the
      // model must know the user said no, not that the tool failed.
      if (permission === 'ask' && !isModifying) {
        const approved = requestToolApproval
          ? await requestToolApproval({
              runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name as AgentToolName,
              arguments: normalizedArguments,
              argumentsHash: hashArguments(normalizedArguments),
              ...(navisworksBinding === undefined
                ? {}
                : {
                    instanceId: navisworksBinding.instanceId,
                    bridgeSessionId: navisworksBinding.bridgeSessionId,
                  }),
            })
          : false
        if (!approved) {
          const message = `用户拒绝了本次工具调用（权限设置为每次询问）：${toolCall.name}`
          return {
            error: { code: 'PERMISSION_DENIED', message },
            wire: buildToolErrorObservation(toolCall.name, 'PERMISSION_DENIED', message),
          }
        }
      }

      const callBridge = () => navisworksBinding === undefined
        ? this.#bridgeClient.call(toolCall.name, normalizedArguments, { signal })
        : callWithNavisworksRunBinding(
            this.#bridgeClient as AgentBridgeClient & Pick<NavisworksBridgeClient, 'callToEndpoint'>,
            navisworksBinding,
            toolCall.name,
            normalizedArguments,
            { signal },
          )
      const execute = async (): Promise<unknown> => {
        if (isModifying) {
          if (navisworksBinding === undefined
            && this.#contextState !== undefined
            && !this.#contextState.canUseDocumentReference(documentAtRequest)) {
            await ledger?.mark(runId, toolCall.id, 'cancelled', 'DOCUMENT_CHANGED')
            throw new ToolExecutionGuardError(
              'DOCUMENT_CHANGED',
              '文档已变化，已取消本次视图操作，请重新选择目标后重试。',
            )
          }
          await ledger?.mark(runId, toolCall.id, 'executing')
          executing = true
        }
        return callBridge()
      }
      const result = isModifying && this.#operationCoordinator !== undefined
        ? await this.#operationCoordinator.runExclusive(
            navisworksBinding === undefined
              ? documentAtRequest
              : `${navisworksBinding.instanceId}\u0000${documentAtRequest ?? ''}`,
            execute,
          )
        : await execute()
      if (isModifying) await ledger?.mark(runId, toolCall.id, 'success')
      return {
        result,
        wire: buildToolSuccessObservation(toolCall.name, result),
      }
    } catch (error) {
      if (error instanceof NavisworksTargetError) {
        if (isModifying && ledgerStarted) {
          const current = ledger?.get(runId, toolCall.id)
          if (current?.status === 'executing') {
            await ledger?.mark(runId, toolCall.id, 'failed', error.code)
          } else if (current?.status === 'awaiting-approval' || current?.status === 'approved') {
            await ledger?.mark(runId, toolCall.id, 'cancelled', error.code)
          }
        }
        throw error
      }
      if (signal?.aborted) {
        if (isModifying && ledgerStarted) {
          const current = ledger?.get(runId, toolCall.id)
          if (executing && current?.status === 'executing') {
            await ledger?.mark(runId, toolCall.id, 'ambiguous', 'ABORTED_DURING_EXECUTION')
          } else if (current?.status === 'awaiting-approval' || current?.status === 'approved') {
            await ledger?.mark(runId, toolCall.id, 'cancelled', 'ABORTED_BEFORE_EXECUTION')
          }
        }
        throw error
      }
      const code = error instanceof BridgeError
        ? error.code
        : error instanceof ToolExecutionGuardError
          ? error.code
        : error instanceof ToolCatalogError
          ? error.code
          : 'TOOL_EXECUTION_FAILED'
      const message = errorMessage(error)
      const ambiguousOutcome = error instanceof BridgeError && error.ambiguousOutcome
      // Invariant F: a modifying call whose outcome the bridge could not confirm is
      // recorded ambiguous (never auto-retried); a clean failure records failed.
      if (isModifying && ledgerStarted) {
        const current = ledger?.get(runId, toolCall.id)
        if (current?.status === 'executing') {
          await ledger?.mark(
            runId,
            toolCall.id,
            ambiguousOutcome ? 'ambiguous' : 'failed',
            code,
          )
        }
      }
      const errorShape = { code, message, ambiguousOutcome }
      return {
        error: errorShape,
        wire: buildToolErrorObservation(toolCall.name, code, message, ambiguousOutcome),
      }
    }
  }

  /**
   * Auto-compaction: summarizes everything except the leading system prompt
   * and the most recent rounds into one system message, freeing window space
   * while live tool-result IDs stay verbatim. Summarization prefers the
   * the local model. Best-effort: any failure is swallowed.
   */
  async #compactMessages(
    contextManager: ContextManager,
    input: AgentRunInput,
    options: RunAgentOptions,
    runtimeConfig: AgentRuntimeSettings,
  ): Promise<string | null> {
    const summarizer = this.#router.local()
    const summarizerModel = input.model?.trim() || this.#model
    let producedSummary = ''
    const config: CompactConfig = {
      summarizerModel,
      signal: options.signal,
      keepRecentFrames: runtimeConfig.compactKeepRecentFrames,
      maxTranscriptChars: runtimeConfig.compactMaxTranscriptChars,
      // tryCompact hands back the [system, transcript] pair to summarize; send it
      // verbatim (no window) exactly as the pre-refactor auto-compaction did.
      summarize: async (summaryMessages) =>
        (await this.#completeWith(
          summarizer,
          this.#summarizerRequest(summarizerModel, summaryMessages, options.signal),
        )).content,
      onSummary: (summary) => { producedSummary = summary },
    }
    const changed = await contextManager.tryCompact(config)
    return changed ? producedSummary : null
  }

  /** A windowless summarizer request carrying the model and the built [system, transcript]. */
  #summarizerRequest(model: string, messages: ChatMessage[], signal?: AbortSignal): AgentRequest {
    return {
      model,
      messages,
      sampling: { temperature: 0.2, maxTokens: 1024 },
      ...(signal ? { signal } : {}),
    }
  }

  /**
   * Route a request to the provider, applying the ContextManager window policy once
   * (Invariants G and §五): a context window is only ever sent to the local Ollama
   * provider — whose wire maps `num_ctx` from it — and never to OpenAI-compatible
   * endpoints, whose server sizes its own context. This keeps the emitted request body
   * byte-identical to the pre-refactor inline calls for both providers.
   */
  async #completeWith(provider: ModelProvider, request: AgentRequest): Promise<CompleteResult> {
    // ContextManager already decided the window (omitting `contextWindow` for cloud
    // requests and for windowless summarizer calls). A context window is only ever
    // consumed by the local Ollama provider (whose wire maps it to `num_ctx`); for any
    // other provider we strip it, so the emitted body is byte-identical to the
    // pre-refactor inline calls for both providers.
    const carriedWindow = request.sampling?.contextWindow
    if (providerSendsContextWindow(provider.kind, carriedWindow !== undefined, carriedWindow ?? 0)) {
      return provider.complete(request)
    }
    return provider.complete({
      ...request,
      sampling: request.sampling
        ? { temperature: request.sampling.temperature, maxTokens: request.sampling.maxTokens }
        : undefined,
    })
  }

  /**
   * Build the API provider for an endpoint, carrying the profile's advanced
   * settings (timeout, window, wire compatibility) so the request shape is
   * profile-driven rather than hardcoded.
   */
  #apiProvider(api: ApiEndpointConfig): ModelProvider {
    const advanced = api.advanced
    return this.#router.forEndpoint({
      kind: 'openai',
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      ...(advanced === undefined ? {} : {
        requestTimeoutMs: advanced.requestTimeoutMs,
        contextWindow: advanced.contextWindowTokens ?? undefined,
        compatibility: {
          temperature: advanced.temperature,
          maxTokensParameter: advanced.maxTokensParameter,
          sendReasoningEffort: advanced.sendReasoningEffort,
          sendStreamOptions: advanced.sendStreamOptions,
        },
      }),
    })
  }

  dispose(): void {
    // Providers and the bridge client hold no persistent connections here.
  }

  /**
   * Manual /compact: summarizes a whole conversation transcript into one
   * short summary string. It follows the currently selected API/local model.
   */
  async compactConversation(
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
    input: { model?: string; api?: ApiEndpointConfig } = {},
    signal?: AbortSignal,
  ): Promise<string> {
    if (messages.length === 0) {
      throw new AgentRuntimeError('EMPTY_INPUT', '没有可压缩的对话内容。')
    }
    const api = input.api
    const apiActive = Boolean(api?.baseUrl && api.model?.trim())
    const summarizer = apiActive
      ? this.#apiProvider(api!)
      : this.#router.local()
    const summarizerModel = apiActive
      ? api!.model!.trim()
      : (input.model?.trim() || this.#model)
    const summarizerCapabilities = summarizer.capabilities(summarizerModel)
    const summarizerWindow = summarizer.kind === 'ollama'
      ? clampLocalContextWindow(this.#contextWindow)
      : Math.max(1024, summarizerCapabilities.maxContextWindow
        ?? summarizerCapabilities.defaultContextWindow
        ?? this.#contextWindow)
    const transcript = messages
      .map((message) => `[${message.role}] ${message.content}`)
      .join('\n\n')
    const built = buildAgentRequest({
      systemPrompt: COMPACT_SYSTEM_PROMPT,
      history: [],
      currentInput: clip(transcript, COMPACT_MAX_TRANSCRIPT_CHARS),
      tools: [],
      temperature: 0.2,
      maxTokens: 1024,
      effectiveWindow: summarizerWindow,
      sendContextWindow: summarizer.kind === 'ollama',
    })
    const response = await this.#completeWith(
      summarizer,
      { ...built, model: summarizerModel, ...(signal ? { signal } : {}) },
    )
    const summary = response.content.trim()
    if (!summary) {
      throw new AgentRuntimeError('MODEL_EMPTY_RESPONSE', '压缩未产生摘要，请重试。')
    }
    return summary
  }
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…[已截断]`
}

/**
 * History enters ContextManager in FULL under the default 'auto' mode: frame
 * trimming is the ContextManager's token-budget job, not a hard message count.
 * 'fixed' mode pre-slices for users who want the old predictability.
 */
function normalizeHistory(history: readonly AgentHistoryEntry[], config: AgentRuntimeSettings): ChatMessage[] {
  const bounded = config.historyMode === 'fixed' && config.historyMessageLimit
    ? history.slice(-config.historyMessageLimit)
    : history
  return bounded
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => ({
      role: entry.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: entry.content,
    }))
}

function hasExplicitAmbiguousRetryConfirmation(input: string): boolean {
  return /(?:仍然|继续|再次|重新)执行|确认重试/.test(input)
}

function buildToolSuccessObservation(toolName: string, result: unknown): Record<string, unknown> {
  const record = payloadIsRecord(result) ? result : undefined
  return {
    status: 'success',
    tool: toolName,
    summary: summarizeToolSuccess(toolName, record),
    next_actions: toolSuccessNextActions(toolName, record),
    artifacts: collectToolArtifacts(record),
    result,
  }
}

function summarizeToolSuccess(
  toolName: string,
  result: Record<string, unknown> | undefined,
): string {
  if (toolName === 'navisworks_status' && typeof result?.connected === 'boolean') {
    return result.connected ? 'Navisworks 已连接。' : 'Navisworks 未连接。'
  }
  if (toolName === 'navisworks_find_items') {
    const count = Array.isArray(result?.items) ? result.items.length : 0
    const total = typeof result?.total === 'number' ? result.total : undefined
    const totalText = total === undefined ? '' : `，共 ${total} 个`
    const truncatedText = result?.truncated === true ? '，结果尚未完整' : ''
    return `搜索完成：返回 ${count} 个构件${totalText}${truncatedText}。`
  }
  if (toolName === 'navisworks_get_selection') {
    const count = Array.isArray(result?.items)
      ? result.items.length
      : (typeof result?.selectionCount === 'number' ? result.selectionCount : 0)
    return `已读取当前选择：${count} 个构件。`
  }
  if (toolName === 'navisworks_list_viewpoints') {
    const count = Array.isArray(result?.viewpoints) ? result.viewpoints.length : 0
    return `已读取保存视点：返回 ${count} 个。`
  }
  if (toolName === 'navisworks_get_item_properties') {
    const count = Array.isArray(result?.items) ? result.items.length : 0
    return `已读取 ${count} 个构件的属性。`
  }
  return `${toolName} 执行成功。`
}

function toolSuccessNextActions(
  toolName: string,
  result: Record<string, unknown> | undefined,
): string[] {
  if (result?.truncated !== true) return []
  if (toolName === 'navisworks_find_items') {
    return ['如果任务仍需要更多结果，使用完全相同的搜索参数继续调用 navisworks_find_items；否则停止续查并回答。']
  }
  return ['结果未完整；仅在当前任务确实需要更多数据时继续分页。']
}

function collectToolArtifacts(result: Record<string, unknown> | undefined): string[] {
  if (result === undefined) return []
  const artifacts = new Set<string>()
  for (const key of ['items', 'viewpoints', 'results']) {
    const entries = result[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!payloadIsRecord(entry)) continue
      const id = entry.id ?? entry.itemId ?? entry.viewpointId ?? entry.guid
      if (typeof id === 'string' && id.trim()) artifacts.add(id.trim())
      if (artifacts.size >= 20) return [...artifacts]
    }
  }
  return [...artifacts]
}

function buildToolErrorObservation(
  toolName: string,
  code: string,
  summary: string,
  ambiguousOutcome?: boolean,
): Record<string, unknown> {
  return {
    status: 'error',
    tool: toolName,
    code,
    summary,
    next_actions: toolErrorNextActions(code),
    artifacts: [],
    ...(ambiguousOutcome === undefined ? {} : { ambiguousOutcome }),
  }
}

function toolErrorNextActions(code: string): string[] {
  switch (code) {
    case 'AMBIGUOUS_RETRY_BLOCKED':
      return [
        '先调用只读工具确认当前状态。',
        '除非用户明确确认仍要执行，否则停止并不得自动重试相同修改。',
      ]
    case 'TOOL_CANCELLED':
      return ['停止本次修改，等待用户给出新的明确指令。']
    case 'TARGET_CHANGED':
    case 'DOCUMENT_CHANGED':
    case 'INSTANCE_CHANGED':
      return [
        '重新读取当前 Navisworks 目标和文档状态后再规划。',
        '不得自动重试原修改操作。',
      ]
    case 'ARGUMENTS_CHANGED':
      return ['重新生成稳定参数，并对修改操作重新请求审批。']
    case 'TOOL_NOT_ALLOWED':
    case 'PERMISSION_DENIED':
      return ['改用允许列表中的最小必要工具；不需要实时数据时直接回答。']
    case 'TOOL_OUTPUT_UNAVAILABLE':
      return [
        '该结果已过期或不可用；如仍需要数据，请用相同参数重新调用原工具。',
      ]
    default:
      return [
        '确认 Navisworks Manage 2023 已启动。',
        '确认模型文档已打开，并已加载 Navisworks MCP 插件。',
        '如果条件未变且相同错误再次出现，停止重试并向用户说明。',
      ]
  }
}

function truncateToolResult(toolName: string, result: string, maxChars: number): string {
  if (result.length <= maxChars) {
    return result
  }
  let clipped = result.slice(0, maxChars)
  const finalCodeUnit = clipped.charCodeAt(clipped.length - 1)
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) {
    clipped = clipped.slice(0, -1)
  }
  // P3: prepend a compact structural summary of what was cut, so the truncation is not a
  // blind slice — the model still sees the shape (counts / keys) of the elided payload.
  const summary = summarizeTruncatedPayload(result)
  return `${clipped}\n\n[工具 ${toolName} 的结果过大（原始 ${result.length} 字符）` +
    `${summary ? `；${summary}` : ''}，已截断至 ${maxChars} 字符。完整结果仍保留在本地，` +
    '需要更多时请缩小查询范围重试：降低 limit、改用 category/property 过滤参数，或减少 itemIds 数量。]'
}

/** Best-effort "N items, keys: …" digest of a JSON tool payload; empty on non-JSON.
 * The wire wraps data as `{status, tool, result}` so we descend into `result` first. */
function summarizeTruncatedPayload(result: string): string {
  try {
    const parsed: unknown = JSON.parse(result)
    const payload = unwrapWire(payloadIsRecord(parsed) ? parsed.result : parsed)
    if (Array.isArray(payload)) return `结构：数组长度=${payload.length}`
    if (payloadIsRecord(payload)) {
      const parts: string[] = []
      for (const key of ['items', 'viewpoints', 'models', 'properties', 'results']) {
        const value = payload[key]
        if (Array.isArray(value)) parts.push(`${key}=${value.length}`)
      }
      const listed = new Set(parts.map((part) => part.split('=')[0] as string))
      const otherKeys = Object.keys(payload).filter((key) => !listed.has(key))
      if (parts.length > 0) {
        return `结构：${parts.join(', ')}${otherKeys.length ? `；字段：${otherKeys.join('/')}` : ''}`
      }
      return `字段：${otherKeys.join('/') || '无'}`
    }
  } catch {
    // Not JSON (already-a-string wire shape) → no digest.
  }
  return ''
}

function payloadIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapWire(value: unknown): unknown {
  // `navisworks_*` results come back wrapped as `{status, tool, result}`; if the payload
  // still carries that wrapper, unwrap it one layer so counts/keys reflect the inner data.
  if (payloadIsRecord(value) && 'status' in value && 'result' in value) {
    return (value as { result: unknown }).result
  }
  return value
}

const COMPACT_SYSTEM_PROMPT = '你是会话压缩器。把提供的对话与工具过程压缩为一份简洁的工作摘要，必须保留：用户目标、已验证的关键事实（构件 ID、名称、数量、属性要点）、已执行的操作及结果、重要错误、未完成的步骤。不要编造，不要添加建议，只输出摘要本身。'
