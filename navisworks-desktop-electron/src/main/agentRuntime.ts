import { randomUUID } from 'node:crypto'
import {
  type AgentToolContract,
  type AgentToolName,
  ToolCatalogError,
} from './toolCatalog'
import { toolRegistry, createToolRegistry, type ToolRegistry } from './tool/registry'
import type { CapabilityRegistry } from './capability/capabilityRegistry'
import { createLegacyNavisworksRegistry, applyLegacyNavisworksRunState } from './agent/legacyNavisworksAdapter'
import type {
  CapabilityRunOutcome,
  CapabilityRunSet,
  CapabilityToolExecutionResult,
} from './capability/types'
import { TOOL_OUTPUT_MAX_INLINE_BYTES, type ToolOutputStore } from './toolOutputStore'
import {
  buildPagedResultContent,
  decideToolResultDelivery,
  serializedByteLength,
} from './agent/toolResultDelivery'
import {
  buildToolErrorObservation,
  buildToolSuccessObservation,
  payloadIsRecord,
  summarizeToolSuccess,
} from './agent/toolObservation'
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
import type { ContextEngine } from './context/contextEngine'
import {
  COMPACT_SYSTEM_PROMPT,
  renderConversationTranscript,
} from './context/compactionService'
import {
  DoomLoopGuard,
  resultFingerprint,
  toolCallSignature,
  type DoomLoopDecision,
  type DoomLoopScope,
} from './agent/doomLoopGuard'
import type { InternalToolExecutor } from './agent/internalToolExecutor'
import type { SkillRegistry } from './skill/skillRegistry'
import type { QuestionOutcome, QuestionPrompt } from './question/types'
import type { SkillManifestEntry } from './skill/types'
import type { ContextAssembly } from './context/types'
import { localThinkForEffort, nearestReasoningEffort, type ReasoningEffort } from '../shared/reasoning'
import type { ModelInfo, ModelMetadataSourceId, ModelUsage } from '../shared/model'
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
import { CURI_CORE_PROMPT } from './agent/prompts'
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

/** The model-visible outcome of executing one tool call (bridge or internal). */
interface ToolExecutionResult {
  result?: unknown
  error?: { code: string; message: string; ambiguousOutcome?: boolean }
  wire: Record<string, unknown>
}

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
  /**
   * @deprecated Tool Result Delivery v2 (§15/§47): the runtime no longer clips
   * tool results by character count. These fields are still ACCEPTED by the
   * settings schema and mapped here purely for old settings.json compatibility;
   * the production tool-result path ignores them entirely (capacity is decided
   * by the context window, never a fixed char cap). Cleanup is deferred.
   */
  toolResultMode: 'auto' | 'fixed'
  /** @deprecated see toolResultMode. */
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

/** A provider signals a run-level abort (e.g. the bound instance vanished).
 *  The core stops the run with this code; it never interprets the cause (§53). */
class CapabilityRunTerminatingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CapabilityRunTerminatingError'
  }
}

/** Per-call dispatch context for #executeTool. */
interface ToolDispatchContext {
  runId: string
  sessionId?: string
  messageId?: string
  permission: ToolPermission
  signal?: AbortSignal
  requestToolApproval?: (request: import('./capability/types').CapabilityApprovalRequest) => Promise<boolean>
  allowAmbiguousRetry: boolean
  capabilityStates: CapabilityRunSet
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
  /**
   * P17: the run is SUSPENDED awaiting a user question answer (§14). The run
   * does not end — it resumes `generating` the moment the answer lands.
   */
  | { phase: 'awaiting-user-input' }
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
  /** @deprecated Runtime-only environment notice; PRODUCTION MUST NOT SET IT.
   *  The Navisworks capability now derives the pending document notice in
   *  prepareRun/contributeContext (§17/§30.3). Only legacy engine-less unit
   *  tests may pass it, to preserve their exact prior context assembly. */
  documentNotice?: DocumentChangeNotice
  /** @deprecated The document snapshot from the old inline preflight;
   *  PRODUCTION MUST NOT SET IT — it now comes from prepareRun's
   *  NavisworksPreparedRun.currentDocument folded into the capability's own
   *  context namespace (§44). Legacy unit tests only. */
  currentDocument?: CurrentDocumentContext
  /** @deprecated legacy preflight fields — PRODUCTION MUST NOT PASS THESE
   *  (§23/§24): ChatRunRegistry stopped generating them, and the capability
   *  now contributes binding + current document through prepareRun /
   *  contributeContext. They are honored ONLY by the legacy adapter merge,
   *  which folds them into the Navisworks capability's OWN state and never
   *  into any other provider (§26/§27), so engine-less unit tests keep their
   *  exact behavior without any Navisworks business logic in the run loop. */
  navisworksBinding?: {
    instanceId: string
    bridgeSessionId: string
    documentInstanceId?: string
    documentName?: string
  }
  /** @deprecated see `navisworksBinding`. */
  navisworksUnavailable?: { code: 'TARGET_INSTANCE_DISCONNECTED'; message: string }
  /** Capability Architecture: per-run prepared capability states (runtime-only,
   *  NEVER persisted, NEVER crosses IPC). When present, tool execution routes
   *  through the owning capability. */
  capabilityStates?: CapabilityRunSet
  /** P19: the discovered skill manifest feeds the skills/manifest baseline source. */
  skillManifestProvider?: { manifest(): readonly SkillManifestEntry[] }
}

export interface RunAgentOptions {
  signal?: AbortSignal
  onEvent?: (event: AgentRunEvent) => void
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<boolean>
  /**
   * P16: suspend the run on a `question` tool call (or a doom-loop
   * escalation). The chat.runs facade implements it as "register a pending
   * question, push the event to THIS run's sender, await the answer".
   * Absent → the question/skill tools report unavailable, never a crash.
   */
  requestQuestion?: (request: RuntimeQuestionRequest) => Promise<QuestionOutcome>
}

/** One question raised mid-run; identity fields filled by the run facade. */
export interface RuntimeQuestionRequest {
  source: 'tool' | 'doom-loop'
  questions: QuestionPrompt[]
  toolCallId?: string
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
  /**
   * Context Engine (P11/P15): epoch metadata of THIS run when the engine
   * assembled the context. Persisted on the session by the facade; surfaced
   * on chat.done so diagnostics can confirm prefix stability across turns.
   */
  contextEpochId?: string
  contextGeneration?: number
  contextBaselineHash?: string
  contextPrefixHash?: string
  contextUpdatesAdded?: number
  semanticMemory?: SemanticMemory
  errorCode?: string
}

export interface AgentRuntimeOptions {
  /** Capability Architecture v1: the registered capability providers. When
   *  present, tool execution routes exclusively through it (P26). Absent →
   *  the legacy bridgeClient path (engine-less unit tests). */
  capabilities?: CapabilityRegistry
  /**
   * P30.1 single truth: THE composed ToolRegistry (internal + capability
   * tools) this run shares with the `tools.list` IPC surface. Production
   * composition MUST pass it explicitly (§59/§60): model materialization,
   * permission resolution and the Settings UI then read one registry.
   * Absent → a compatible default is composed from `capabilities` (legacy
   * unit-test hosts only).
   */
  tools?: ToolRegistry
  /** @deprecated legacy path; ignored when `capabilities` is provided. */
  bridgeClient?: AgentBridgeClient
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
   * P17: seam that runs the internal (non-Bridge) tools read_tool_result /
   * question / skill. Absent → those tool calls report unavailable, and the
   * legacy inline read_tool_result path is not used (runtime never branches
   * on internal-tool names itself).
   */
  internalToolExecutor?: InternalToolExecutor
  /**
   * P19: discovered skills — doubles as the skills/manifest baseline provider
   * so the model sees name + description only (§52). Absent → no manifest.
   */
  skillRegistry?: SkillRegistry
  /**
   * P9–P13: Context Engine. When present AND a run carries a sessionId, the
   * WHAT of context (baseline / durable updates / volatile working blocks) is
   * assembled by registered sources through a durable per-session Epoch.
   * Absent (unit tests, session-less drafts) → the legacy in-runtime assembly,
   * byte-for-byte as before.
   */
  contextEngine?: ContextEngine
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

/** Map the resolver's metadata provenance onto the run's context-window source
 *  (§22): 'model' = the user's per-model override; unknown never reaches here. */
function mapMetadataSource(source: ModelMetadataSourceId): ContextWindowSource {
  switch (source) {
    case 'model': return 'model'
    case 'local': return 'local'
    case 'profile': return 'profile'
    case 'provider': return 'provider'
    default: return 'fallback'
  }
}
export type { AgentBridgeClient } from './model/types'

export class AgentRuntime {
  readonly #capabilities: CapabilityRegistry | undefined
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
  readonly #contextEngine: ContextEngine | undefined
  readonly #internalToolExecutor: InternalToolExecutor | undefined
  readonly #tools: ToolRegistry
  readonly #skillRegistry: SkillRegistry | undefined

  constructor(options: AgentRuntimeOptions) {
    // §107 legacy migration: a host that still passes flat navisworks deps
    // gets a real CapabilityRegistry via the quarantined adapter; a host that
    // passes neither gets a genuinely capability-free core (§36/§74).
    const capabilities = options.capabilities ?? (options.bridgeClient === undefined
      ? undefined
      : createLegacyNavisworksRegistry({
        bridgeClient: options.bridgeClient,
        ...(options.contextState === undefined ? {} : { contextState: options.contextState }),
        ...(options.executionLedger === undefined ? {} : { executionLedger: options.executionLedger }),
        ...(options.operationCoordinator === undefined ? {} : { operationCoordinator: options.operationCoordinator }),
      }))
    this.#capabilities = capabilities
    // P30.1: the composition root passes the ONE registry both this runtime
    // and the tools.list IPC use. The fallbacks below exist only for legacy
    // hosts (flat bridgeClient unit tests, capability-free core tests) —
    // production must never rely on them (§60).
    this.#tools = options.tools ?? (capabilities === undefined
      ? toolRegistry
      : createToolRegistry({ capabilities }))
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
    this.#contextEngine = options.contextEngine
    this.#internalToolExecutor = options.internalToolExecutor
    this.#skillRegistry = options.skillRegistry
  }

  /** The composed tool registry (internal + registered capabilities):
   * the tools.list IPC surface reads the SAME single truth the model sees. */
  get toolInventory(): ToolRegistry {
    return this.#tools
  }

  /** The registered capability providers (tools.list summaries + shutdown). */
  get capabilityRegistry(): CapabilityRegistry | undefined {
    return this.#capabilities
  }

  /**
   * Title generation follows the ACTIVELY routed provider: in API mode the
   * current endpoint answers (so deleting Ollama someday keeps titles working);
   * only a genuinely local run uses the local daemon.
   */
  async summarizeTitle(text: string, signal?: AbortSignal, api?: ApiEndpointConfig, model?: string): Promise<string> {
    const apiActive = Boolean(api?.baseUrl && api.model?.trim())
    if (apiActive) {
      const provider = this.#apiProvider(api!)
      const response = await provider.complete({
        model: api!.model!.trim(),
        messages: [
          { role: 'system', content: '根据用户的第一条消息生成一个简洁的会话标题：不超过 20 个字，不要标点或引号，只输出标题本身。' },
          { role: 'user', content: text },
        ],
        sampling: { temperature: 0.2, maxTokens: 4096 },
        reasoningEffort: 'low',
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
    return summarize.call(provider, model?.trim() || this.#model, text, signal)
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
    const tools = this.#tools.materialize({
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
    // P18: the Doom Loop Guard is RUN-scoped (§36) — a fresh instance per user
    // turn, so a legitimate cross-turn repeat (e.g. the user re-selected in
    // the Navisworks UI) is never blocked by the previous turn's history.
    const doomLoop = new DoomLoopGuard()
    // P18/P27: the operation scope is contributed by the OWNING capability
    // (opaque fields); the core never names document/instance concepts itself.
    const doomScopeFor = (toolName: string): Record<string, string | number | null> =>
      this.#capabilities?.executionScopeFor(toolName, capabilityStates) ?? {}
    // The question channel: ChatRunRegistry supplies it (pending registry +
    // the run's sender); absent → internal question tools report unavailable.
    const askQuestion = options.requestQuestion
    // Capability Architecture v1: prepare every registered provider's run
    // state ONCE (binding / current environment / availability). Opaque to
    // the core; execution and context contributions read it by capability id.
    const preparedStates: CapabilityRunSet = this.#capabilities === undefined
      ? new Map()
      : await this.#capabilities.prepareRuns({
        runId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    // P30.4: the deprecated flat run fields fold into ONLY the Navisworks
    // capability's own state (via the quarantined adapter) — never another
    // provider's. Production passes no flat fields (§24), so this is a no-op
    // there; only legacy engine-less unit tests reach the merge branch.
    const capabilityStates: CapabilityRunSet = input.capabilityStates
      ?? applyLegacyNavisworksRunState(this.#capabilities, preparedStates, {
        ...(input.navisworksBinding === undefined ? {} : { binding: input.navisworksBinding }),
        ...(input.navisworksUnavailable === undefined ? {} : { unavailable: input.navisworksUnavailable }),
        ...(input.currentDocument === undefined ? {} : { currentDocument: input.currentDocument }),
      })
    // P30.8: each capability contributes a context fragment NAMESPACED by its
    // id (e.g. { navisworks: { document, documentNotice, documentRevision,
    // contextState } }). The core stores it opaquely under `capabilities` and
    // reads NO field of it — Navisworks' own sources read their slice via
    // getNavisworksContext. A core-only run gets `{}` (§50/§91).
    const capabilityContext: Readonly<Record<string, unknown>> = this.#capabilities === undefined
      ? {}
      : this.#capabilities.contributeContext(capabilityStates, {
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      })
    // Model Configuration v2 (§21/§23/§35): the resolved runtimeModel already
    // absorbed the per-model override, so when it KNOWS its context window
    // (metadataSource 'model'/'profile'/'provider'/'local', never 'fallback') it
    // is the single truth — the runtime uses it verbatim (a 1M config really
    // budgets 1M, §35), and the profile/legacy resolution below never overrides
    // it. Priority: ModelConfiguration > profile advanced > provider > fallback.
    const advanced = apiActive ? api!.advanced ?? undefined : undefined
    const capabilities = provider.capabilities(model)
    const modelContext = input.runtimeModel?.limits.context
    const modelContextKnown = input.runtimeModel !== undefined
      && input.runtimeModel.metadataSource !== 'unknown'
      && typeof modelContext === 'number' && modelContext > 0
    const usingLocalWindow = provider.kind === 'ollama'
    const localWindow = clampLocalContextWindow(this.#contextWindow)
    const apiResolution = resolveApiContextWindow(
      advanced?.contextWindowTokens,
      capabilities,
      this.#contextWindow,
    )
    const effectiveWindow = modelContextKnown
      ? clampLocalContextWindow(modelContext ?? 0)
      : usingLocalWindow ? localWindow : apiResolution.window
    const contextWindowSource: ContextWindowSource = modelContextKnown
      ? mapMetadataSource(input.runtimeModel!.metadataSource)
      : usingLocalWindow ? 'local' : apiResolution.source
    // Output reserve (§38/§39): a known ModelConfiguration max output caps BOTH
    // the budget reserve and the WIRE limit, so the UI and the request never
    // disagree (no "UI 128K / wire 4096"). The model's output cap is clamped
    // under the effective window so a too-large config can't reserve the whole
    // budget; an unknown output falls back to the legacy profile/numPredict.
    const outputCapFromModel = input.runtimeModel?.limits.output
    const legacyOutputCap = apiActive
      ? (advanced?.maxOutputTokens ?? null)
      : this.#numPredict
    const outputCap = typeof outputCapFromModel === 'number' && outputCapFromModel > 0
      ? outputCapFromModel
      : legacyOutputCap
    const outputReserve = outputCap == null
      ? (apiActive ? 4_096 : this.#numPredict)
      : Math.min(outputCap, Math.max(256, effectiveWindow - 1_024))
    const maxToolRounds = runtimeConfig.maxToolRounds
    // Task System v1: resume the session's latest unfinished task as Active
    // Task Context. A paused task never auto-executes — it re-enters running
    // only when the model produces tool calls again during THIS run (§14).
    const taskManager = this.#taskManager
    const sessionId = input.sessionId
    let activeTask: CuriTask | undefined
    if (taskManager !== undefined && sessionId !== undefined) {
      activeTask = taskManager.getResumableTaskForSession(sessionId)
    }
    const semanticMemory = input.sessionId === undefined
      ? input.semanticMemory
      : updateSemanticMemory(input.semanticMemory, trimmedInput)
    const currentDocumentBlock = renderCurrentDocumentContext(
      input.currentDocument ?? this.#contextState?.currentDocument,
    )

    // Context Engine v1 (P9–P13): the WHAT of the model context — baseline,
    // durable append-only updates, volatile working blocks — is assembled by
    // registered sources through a durable per-session Epoch. ContextManager
    // keeps the HOW MUCH (token budget). Without an engine or a session id
    // (unit tests, drafts) the legacy manual assembly below runs unchanged —
    // this seam is why the runtime no longer hand-pushes context blocks.
    let contextAssembly: ContextAssembly | undefined
    let baseline = CURI_CORE_PROMPT
    let contextBlocks: ContextBlock[]
    if (this.#contextEngine !== undefined && sessionId !== undefined) {
      contextAssembly = await this.#contextEngine.prepare(sessionId, {
        sessionId,
        // P30.8: NO top-level Navisworks fields. Each capability's document /
        // notice / revision / ContextState handle ride inside their own
        // namespaced slice under `capabilities`; the core environment stays
        // provider-neutral (§43/§44/§99). A legacy host that still supplies a
        // runtime-owned ContextState contributes NOTHING here — such hosts run
        // the engine-less branch (no contextEngine) instead.
        capabilities: capabilityContext,
        ...(activeTask === undefined ? {} : { activeTask }),
        ...(semanticMemory === undefined ? {} : { semanticMemory }),
        ...(input.compactSummary?.trim()
          ? { compactSummary: input.compactSummary.trim() }
          : {}),
        ...(this.#resolveToolResult === undefined ? {} : { resolveToolResult: this.#resolveToolResult }),
        ...(input.skillManifestProvider === undefined && this.#skillRegistry === undefined
          ? {}
          : { skillManifestProvider: input.skillManifestProvider ?? this.#skillRegistry }),
      })
      baseline = contextAssembly.baseline
      contextBlocks = [...contextAssembly.blocks]
    } else {
      contextBlocks = await this.#capabilityBaselineBlocks()
      if (activeTask !== undefined) {
        contextBlocks.push({
          kind: 'task-state',
          message: { role: 'system', content: renderTaskContext(activeTask) },
        })
      }
      if (currentDocumentBlock) contextBlocks.push({
        kind: 'document-transition',
        message: { role: 'system', content: currentDocumentBlock },
      })
      const documentTransitionBlock = renderDocumentTransition(input.documentNotice)
      if (documentTransitionBlock) contextBlocks.push({
        kind: 'document-transition',
        message: { role: 'system', content: documentTransitionBlock },
      })
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
    }
    const contextManager = new ContextManager({
      systemPrompt: baseline,
      history: normalizeHistory(input.history ?? [], runtimeConfig),
      contextBlocks,
    })
    contextManager.addUserTurn({ role: 'user', content: trimmedInput })
    // Tool Result Delivery v2 (§六): proactive recovery refs. A large-but-fitting
    // result is still persisted (so a later turn can re-read it) while the model
    // keeps the COMPLETE content inline. Keyed by toolCallId to store once.
    const proactiveRefs = new Map<string, string>()
    let latestContextTokens = 0
    let latestUsage: ModelUsage | undefined
    let latestCacheHitRate: number | undefined
    let lastAssistantText = ''
    let didCompactRun = false
    let capturedSummary: string | undefined
    // One commit per successful settlement; the compact-rollover replaces the
    // commit (new seeded epoch is persisted by rollOverForCompaction itself).
    let contextEpochSettled = false
    const settleContextEpoch = async (): Promise<void> => {
      if (contextEpochSettled) return
      contextEpochSettled = true
      if (this.#contextEngine === undefined || contextAssembly === undefined || sessionId === undefined) {
        return
      }
      try {
        if (didCompactRun && capturedSummary !== undefined && capturedSummary !== '') {
          // Auto compaction succeeded AND the run completes: the summary becomes
          // the new epoch's seed, generation +1, fresh durable snapshots (§38/§39).
          await this.#contextEngine.rollOverForCompaction(sessionId, capturedSummary, contextAssembly.epoch)
        } else {
          await this.#contextEngine.commit(contextAssembly.epoch)
        }
      } catch (commitError) {
        // Commit failure is durability-degrade, not user-visible (§9).
        console.debug(`[context] epoch persist failed: ${errorMessage(commitError)}`)
      }
    }

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
    // P30.5: the run's outcome drives Capability finishRuns (§32). Only a run
    // that produced an answer (every success return routes through
    // finishSuccess) counts as 'completed' — exactly the condition under which
    // the old ChatRunRegistry called contextState.markDocumentSeen. Failed and
    // aborted runs leave their pending document transition unconsumed.
    let settledAsCompleted = false
    const finishCapabilityRun = async (): Promise<void> => {
      const outcome: CapabilityRunOutcome = options.signal?.aborted === true
        ? 'aborted'
        : settledAsCompleted
          ? 'completed'
          : 'failed'
      await this.#capabilities?.finishRuns(capabilityStates, outcome, {
        runId,
        ...(sessionId === undefined ? {} : { sessionId }),
      })
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
        // No output cap at all (neither a ModelConfiguration max-output nor a
        // profile advanced.maxOutputTokens) → API sends NO output-limit
        // parameter (Auto). Any configured cap — model or profile — rides
        // through on the wire with the SAME value the budget reserved (§39).
        const requestSampling = apiActive && outputCap == null
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

        // Success settlement is the ONLY point the working epoch is committed
        // (§40): a later abort/error returns through the catch/round-limit
        // paths which never call finishSuccess, so the durable epoch stays the
        // pre-run one and the next prepare() re-reconciles from it unchanged.
        const finishSuccess = async (message: string = lastAssistantText): Promise<AgentRunResult> => {
          await settleContextEpoch()
          settledAsCompleted = true
          return {
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
            ...(contextAssembly === undefined ? {} : {
              contextEpochId: contextAssembly.epochId,
              contextGeneration: contextAssembly.generation,
              contextBaselineHash: contextAssembly.baselineHash,
              contextPrefixHash: contextAssembly.prefixHash,
              contextUpdatesAdded: contextAssembly.updatesAdded,
            }),
          }
        }

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
                  result: await finishSuccess(
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
              ? { kind: 'stop', result: await finishSuccess() }
              : { kind: 'continue' }
          }
          if (verification.verdict === 'blocked') {
            activeTask = await taskManager.block(activeTask.id, verification.blockedReason ?? 'BLOCKED')
            refreshTaskContext()
            const blocker = `任务已阻塞：${verification.reason}`
              + (verification.nextAction ? ` 下一步：${verification.nextAction}` : '')
            return { kind: 'stop', result: await finishSuccess(blocker) }
          }
          if (verification.verdict === 'replan') {
            if (activeTask.replanCount >= runtimeConfig.maxTaskReplans) {
              activeTask = await taskManager.block(activeTask.id, REPLAN_LIMIT_REASON)
              refreshTaskContext()
              return {
                kind: 'stop',
                result: await finishSuccess(`任务已阻塞（重规划次数已达上限）：${verification.reason}`),
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
                    result: await finishSuccess(
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
            return await finishSuccess()
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

          // P17/§75: internal (non-Bridge) tools run through the executor
          // seam. `question` raises the awaiting-user-input phase and (via
          // askQuestion) SUSPENDS this run without ending it (§2/§14). It is
          // NEVER doom-loop checked (§82) — a question suspends, it can't spin.
          const executor = this.#internalToolExecutor
          let toolResult: ToolExecutionResult
          if (executor !== undefined && executor.canExecute(toolCall.name)) {
            const isQuestion = toolCall.name === 'question'
            if (isQuestion) options.onEvent?.({ phase: 'awaiting-user-input' })
            try {
              const executed = await executor.execute(
                toolCall.name,
                this.#tools.normalizeArguments(toolCall.name, toolCall.arguments),
                {
                  runId,
                  sessionId: input.sessionId ?? '',
                  toolCallId: toolCall.id,
                  ...(askQuestion === undefined
                    ? {
                      askQuestion: async () => {
                        throw new Error('question channel unavailable')
                      },
                    }
                    : { askQuestion: (req: Parameters<NonNullable<RunAgentOptions['requestQuestion']>>[0]) => askQuestion(req) }),
                  ...(options.signal === undefined ? {} : { signal: options.signal }),
                },
              )
              toolResult = executed.ok
                ? { result: executed.result, wire: buildToolSuccessObservation(toolCall.name, executed.result) }
                : { error: { code: executed.code, message: executed.message }, wire: buildToolErrorObservation(toolCall.name, executed.code, executed.message) }
            } finally {
              if (isQuestion) options.onEvent?.({ phase: 'generating' })
            }
            // question/skill/read results are small; no ToolOutputStore bounding.
            options.onEvent?.({
              phase: 'completed',
              runId,
              toolCallId: toolCall.id,
              tool: toolCall.name,
              arguments: toolCall.arguments,
              result: toolResult.result,
              error: toolResult.error,
            })
            toolResultMessages.push({
              role: 'tool',
              toolCallId: toolCall.id,
              content: JSON.stringify(toolResult.wire),
            })
            continue
          }

          // P18: the Doom Loop pre-check runs AFTER permission resolution but
          // BEFORE approval (§37) — a call the guard will recover/escalate must
          // never pop a Tool Approval the user would then "approve" for nothing.
          const doomSignature = toolCallSignature({
            toolName: toolCall.name,
            normalizedArguments: this.#tools.normalizeArguments(toolCall.name, toolCall.arguments),
            scope: doomScopeFor(toolCall.name),
          })
          const doomDecision = doomLoop.beforeCall(doomSignature)
          if (doomDecision.action !== 'execute') {
            const synthetic = await this.#handleDoomLoop(
              doomDecision,
              toolCall,
              doomLoop,
              doomSignature,
              askQuestion,
            )
            options.onEvent?.({
              phase: 'completed',
              runId,
              toolCallId: toolCall.id,
              tool: toolCall.name,
              arguments: toolCall.arguments,
              result: synthetic.result,
              error: synthetic.error,
            })
            toolResultMessages.push({
              role: 'tool',
              toolCallId: toolCall.id,
              content: JSON.stringify(synthetic.wire),
            })
            if (synthetic.error?.code === 'DOOM_LOOP_TERMINATED') {
              roundHadToolFailure = true
            }
            continue
          }

          toolResult = await this.#executeTool(toolCall, {
            runId,
            ...(sessionId === undefined ? {} : { sessionId }),
            permission: this.#tools.resolvePermission(toolCall.name, {
              permissions: input.toolPermissions,
              legacyDisabled: disabledTools,
            }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.requestToolApproval === undefined
              ? {}
              : { requestToolApproval: options.requestToolApproval }),
            allowAmbiguousRetry: hasExplicitAmbiguousRetryConfirmation(trimmedInput),
            capabilityStates,
          })
          // Record the real result's fingerprint so a REPEAT with no new
          // information is detectable (§29); different results reset nothing.
          if (toolResult.error === undefined) {
            doomLoop.recordResult(doomSignature, resultFingerprint(toolResult.wire))
          }
          // Tool Result Delivery v2 (§一/§三/§八): NO fixed character clipping
          // and NO 50KB preview. The FULL result is kept; the ONLY thing that
          // can keep it out of the current tool message is the model's context
          // window, measured against the protected floor (history may still be
          // dropped, the current exchange may not). Fits → full inline (§六
          // proactively stores a recovery ref); does not fit → store full + page.
          if (toolResult.error === undefined) {
            const delivered = await this.#deliverToolResult({
              toolName: toolCall.name,
              toolCallId: toolCall.id,
              result: toolResult.result,
              assistantMessage: assistantToolMessage,
              priorResultsThisRound: toolResultMessages,
              tools,
              effectiveWindow,
              outputReserve,
              contextManager,
              proactiveRefs,
            })
            toolResult = { result: delivered.content, wire: delivered.wire }
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

          // The COMPLETE (or paged-reference) tool result — never sliced.
          toolResultMessages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            content: JSON.stringify(toolResult.wire),
          })

          // P2/§55: result mining (Verified Facts + ordered Reference Set) is
          // the OWNING capability's professional state — fan it out through the
          // registry; no-op when the provider has no ingest hook.
          if (toolResult.error === undefined && toolResult.result !== undefined) {
            this.#capabilities?.observeModelResult(toolCall.name, {
              toolName: toolCall.name,
              result: toolResult.result,
              toolCallId: toolCall.id,
              ...(sessionId === undefined ? {} : { sessionId }),
            })
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
      if (error instanceof CapabilityRunTerminatingError) {
        // P27: the capability said the environment is gone (e.g. the bound
        // Navisworks instance disconnected mid-run). Stop with its code — the
        // core never interprets WHY; the error code stays model-visible.
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
    } finally {
      // prepareRuns → run → finally finishRuns (§32). finishCapabilityRun never
      // throws (the registry isolates provider failures), so it can never
      // overwrite the model/tool error the run is already unwinding with.
      await finishCapabilityRun()
    }
  }

  /**
   * Tool Result Delivery v2 (§三/§四/§五/§六/§七/§八): decide how a COMPLETE tool
   * result reaches the model. There is no fixed character cap and no 50KB
   * preview — the model's context window is the only limiter, measured by
   * ContextManager against the protected floor (history may be dropped, the
   * current exchange may not). Fits → the full result inline (with a §六
   * proactive recovery ref when large); does not fit → store the FULL result and
   * return a PAGED reference. Paged never loses data: read_tool_result recovers
   * 100% of it. This is a no-op when no ToolOutputStore is configured (the
   * result simply goes inline — still never sliced).
   */
  async #deliverToolResult(input: {
    toolName: string
    toolCallId: string
    result: unknown
    assistantMessage: ChatMessage
    priorResultsThisRound: readonly ChatMessage[]
    tools: readonly AgentToolContract[]
    effectiveWindow: number
    outputReserve: number
    contextManager: ContextManager
    proactiveRefs: Map<string, string>
  }): Promise<{ content: unknown; wire: Record<string, unknown> }> {
    const store = this.#toolOutputStore
    const fullWire = buildToolSuccessObservation(input.toolName, input.result)
    // No store (unit tests / unconfigured) → the complete result goes inline.
    if (store === undefined) {
      return { content: input.result, wire: fullWire }
    }
    // Would the CURRENT round's whole exchange (assistant call + prior result
    // pages + this complete result) still fit the context budget? §八 order:
    // estimate the full next request first; never slice before asking.
    const candidateMessages: ChatMessage[] = [
      input.assistantMessage,
      ...input.priorResultsThisRound,
      { role: 'tool', toolCallId: input.toolCallId, content: JSON.stringify(fullWire) },
    ]
    const fits = input.contextManager.fitsProjectedToolExchange({
      tools: input.tools,
      outputReserve: input.outputReserve,
      effectiveWindow: input.effectiveWindow,
      candidateMessages,
    })
    // §六 proactive recovery ref: a large result that still FITS is persisted so
    // a LATER turn can re-read it, but the model receives the COMPLETE content.
    const serializedSize = serializedByteLength(input.result)
    let proactiveResultRef = input.proactiveRefs.get(input.toolCallId)
    if (fits) {
      if (proactiveResultRef === undefined && serializedSize > TOOL_OUTPUT_MAX_INLINE_BYTES) {
        try {
          const stored = await store.store({
            sessionId: '',
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            data: input.result,
          })
          proactiveResultRef = stored.resultRef
          input.proactiveRefs.set(input.toolCallId, stored.resultRef)
        } catch {
          proactiveResultRef = undefined
        }
      }
      // §六: the ref is persisted for later recovery, but the model receives the
      // COMPLETE, UNMODIFIED result — never a preview, never an injected field.
      return { content: input.result, wire: fullWire }
    }
    // Does NOT fit → persist the FULL result and hand back a paging pointer.
    let resultRef = proactiveResultRef
    if (resultRef === undefined) {
      const stored = await store.store({
        sessionId: '',
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        data: input.result,
      })
      resultRef = stored.resultRef
      input.proactiveRefs.set(input.toolCallId, stored.resultRef)
    }
    const paged = decideToolResultDelivery({ fits: false, data: input.result, proactiveResultRef: resultRef })
    // decideToolResultDelivery returns the paged content object (never a slice).
    const content = paged.mode === 'paged'
      ? buildPagedResultContent(paged.resultRef, paged.totalBytes, paged.estimatedTokens)
      : input.result
    return { content, wire: buildToolSuccessObservation(input.toolName, content) }
  }

  /**
   * P18: turn a non-execute DoomLoop decision into a SYNTHETIC tool
   * observation — never the bridge, never a ledger entry, never a Navisworks
   * side effect (§32). 'recover' warns; 'escalate' asks the user (Question,
   * source 'doom-loop') and records their replan/stop decision; 'terminate'
   * ends the run with a DOOM_LOOP error (§35, runtime safety over tokens).
   */
  async #handleDoomLoop(
    decision: Extract<DoomLoopDecision, { action: 'recover' | 'escalate' | 'terminate' }>,
    toolCall: { id: string; name: string },
    doomLoop: DoomLoopGuard,
    signature: string,
    askQuestion: RunAgentOptions['requestQuestion'],
  ): Promise<ToolExecutionResult> {
    if (decision.action === 'terminate') {
      const message = '检测到对同一操作的无休止重复调用，已停止本次运行以避免失控。请换一种问法或缩小指令范围。'
      return {
        error: { code: 'DOOM_LOOP_TERMINATED', message },
        wire: buildToolErrorObservation(toolCall.name, 'DOOM_LOOP', message),
      }
    }
    if (decision.action === 'recover') {
      doomLoop.recordRecovery(signature)
      const result = {
        type: 'doom_loop_detected',
        tool: toolCall.name,
        message: '你正在重复完全相同的工具调用，并且前两次没有获得新的信息。请改变参数、使用其他工具，或向用户提问。',
      }
      return { result, wire: buildToolSuccessObservation(toolCall.name, result) }
    }
    // escalate — ask the user how to proceed (换一种方法 / 停止当前任务).
    let decisionValue: 'replan' | 'stop' = 'stop'
    if (askQuestion !== undefined) {
      try {
        const outcome = await askQuestion({
          source: 'doom-loop',
          questions: [{
            question: 'Curi 正在重复同一操作，但没有获得新信息。接下来怎么处理？',
            kind: 'single',
            options: [
              { label: '换一种方法', description: '不要用完全相同的调用，改用其他参数或工具。' },
              { label: '停止当前任务', description: '结束本次任务并给出简短说明。' },
            ],
          }],
          toolCallId: toolCall.id,
        })
        decisionValue = outcome.kind === 'answered'
          && outcome.answers.some((a) => a.values.includes('换一种方法'))
          ? 'replan' : 'stop'
      } catch {
        decisionValue = 'stop'
      }
    }
    doomLoop.applyUserDecision(signature, decisionValue)
    const result = decisionValue === 'replan'
      ? {
        type: 'doom_loop_user_decision',
        decision: 'replan',
        message: '用户要求换一种方法，不要重复此前完全相同的工具调用。',
      }
      : {
        type: 'doom_loop_user_decision',
        decision: 'stop',
        message: '用户要求停止当前任务。不要再调用工具，请简短结束。',
      }
    doomLoop.recordRecovery(signature)
    return { result, wire: buildToolSuccessObservation(toolCall.name, result) }
  }

  /**
   * Capability-provided BASELINE blocks for the engine-less legacy path:
   * renders each registered capability's baseline context sources. The core
   * never names a capability or its prompt — the policy text arrives because
   * the capability is registered, and NOTHING appears when none is (§37).
   */
  async #capabilityBaselineBlocks(): Promise<ContextBlock[]> {
    const blocks: ContextBlock[] = []
    const capabilities = this.#capabilities
    if (capabilities === undefined) return blocks
    for (const source of capabilities.contextSourcesByMode('baseline')) {
      try {
        const value = await source.load({})
        if (value === undefined) continue
        blocks.push({ kind: 'other', message: { role: 'system', content: source.render(value) } })
      } catch (error) {
        console.debug(`[capability] baseline source failed: ${source.key}`)
      }
    }
    return blocks
  }

  /**
   * Capability Architecture v1: the dispatch table. Core owns assertAllowed,
   * deny short-circuit and the internal read_tool_result path (§47); every
   * other tool routes through the CapabilityRegistry by OWNER (§98 — never a
   * name prefix) into the provider's executeTool, which carries the whole
   * professional safety ladder. runTerminating signals a provider-level run
   * abort (e.g. the bound instance vanished); the core stops the run with the
   * given code without ever interpreting the cause (§53).
   */
  async #executeTool(
    toolCall: { id: string; name: string; arguments: Record<string, unknown> },
    ctx: ToolDispatchContext,
  ): Promise<ToolExecutionResult> {
    const permission = ctx.permission
    try {
      this.#tools.assertAllowed(toolCall.name, toolCall.arguments)
      if (permission === 'deny') {
        const message = `该工具已被用户禁用：${toolCall.name}`
        return {
          error: { code: 'PERMISSION_DENIED', message },
          wire: buildToolErrorObservation(toolCall.name, 'PERMISSION_DENIED', message),
        }
      }
      // Internal tool: reads Curi's own stored tool outputs — no capability
      // and no bridge dependency, so it works while every instance is offline.
      if (toolCall.name === 'read_tool_result') {
        const store = this.#toolOutputStore
        if (store === undefined) {
          const message = '工具结果存储在当前运行中不可用。'
          return {
            error: { code: 'TOOL_OUTPUT_UNAVAILABLE', message },
            wire: buildToolErrorObservation(toolCall.name, 'TOOL_OUTPUT_UNAVAILABLE', message),
          }
        }
        const normalizedArguments = this.#tools.normalizeArguments(toolCall.name, toolCall.arguments)
        const resultRef = typeof normalizedArguments.resultRef === 'string' ? normalizedArguments.resultRef : ''
        const offset = typeof normalizedArguments.offset === 'number' ? normalizedArguments.offset : 0
        const limit = typeof normalizedArguments.limit === 'number' ? normalizedArguments.limit : 50
        const page = await store.read(resultRef, offset, limit)
        if (page.error !== undefined) {
          return {
            error: { code: 'TOOL_OUTPUT_UNAVAILABLE', message: page.error },
            wire: buildToolErrorObservation(toolCall.name, 'TOOL_OUTPUT_UNAVAILABLE', page.error),
          }
        }
        return { result: page, wire: buildToolSuccessObservation(toolCall.name, page) }
      }
      const capabilities = this.#capabilities
      if (capabilities === undefined) {
        throw new ToolCatalogError(`当前运行未注册任何 Capability：${toolCall.name}`)
      }
      const owner = capabilities.ownerForTool(toolCall.name)
      if (owner === undefined) {
        // §111: unknown tools never fan out to providers.
        throw new ToolCatalogError(`工具不在允许列表中：${toolCall.name || '(empty)'}`)
      }
      const prepared = ctx.capabilityStates.get(owner.manifest.id)
      const normalizedArguments = this.#tools.normalizeArguments(toolCall.name, toolCall.arguments)
      const executed = await owner.executeTool({
        runId: ctx.runId,
        ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
        toolCallId: toolCall.id,
        ...(ctx.messageId === undefined ? {} : { messageId: ctx.messageId }),
        toolName: toolCall.name,
        arguments: normalizedArguments,
        permission,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.requestToolApproval === undefined
          ? {}
          : { requestApproval: ctx.requestToolApproval }),
        allowAmbiguousRetry: ctx.allowAmbiguousRetry,
        state: prepared?.state,
      })
      if (executed.error !== undefined) {
        const { code, message, ambiguousOutcome, runTerminating } = executed.error
        if (runTerminating === true) {
          throw new CapabilityRunTerminatingError(code, message)
        }
        return {
          error: { code, message, ...(ambiguousOutcome === undefined ? {} : { ambiguousOutcome }) },
          wire: buildToolErrorObservation(toolCall.name, code, message, ambiguousOutcome),
        }
      }
      return { result: executed.result, wire: buildToolSuccessObservation(toolCall.name, executed.result) }
    } catch (error) {
      if (error instanceof CapabilityRunTerminatingError) {
        throw error
      }
      if (ctx.signal?.aborted) {
        throw error
      }
      const code = error instanceof ToolExecutionGuardError
        ? error.code
        : error instanceof ToolCatalogError
          ? error.code
          : 'TOOL_EXECUTION_FAILED'
      const message = errorMessage(error)
      return {
        error: { code, message },
        wire: buildToolErrorObservation(toolCall.name, code, message),
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
    // P14: the SAME transcript shape + summary prompt as the automatic path —
    // manual /compact never maintains a second summarization rule (§41/§66).
    const transcript = renderConversationTranscript(messages)
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

// Tool Result Delivery v2 (§一/§47): the old character-level truncators
// (truncateToolResult / summarizeTruncatedPayload / resolveToolResultCharLimit)
// are GONE — production usage was forced to 0. A full tool result is now either
// inlined complete (fits the context) or stored-and-paged (never sliced), per
// ./agent/toolResultDelivery.

