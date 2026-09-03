import { BridgeError, type BridgeCallOptions } from './bridgeClient'
import type { NavisworksBridgeClient } from './bridgeClient'
import { randomUUID } from 'node:crypto'
import {
  AGENT_TOOL_DEFINITIONS,
  toolCatalog,
  type AgentToolName,
  ToolCatalogError,
} from './toolCatalog'
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
import { localThinkForEffort, type ReasoningEffort } from '../shared/reasoning'
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
  NAVISWORKS_WORKSPACE_PROMPT,
} from './agent/prompts'

type AgentRequest = Omit<CompletionRequest, 'sampling'> & { sampling?: SamplingOptions }
type CompleteResult = Awaited<ReturnType<ModelProvider['complete']>>

const DEFAULT_MODEL = 'qwen3.5:9b-q4_K_M'
const MAX_TOOL_ROUNDS = 8
const MAX_HISTORY_MESSAGES = 24
const MAX_TOOL_RESULT_CHARS = 4_000

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
  api?: ApiEndpointConfig
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
  contextTokensUsed: number
  thinkingText?: string
  /** Cached prompt tokens / prompt tokens of the last round, when reported. */
  cacheHitRate?: number
  /**
   * The finite context window this run actually budgeted against — the local
   * clamp for Ollama, the provider/model capability window (or the configured
   * fallback) for API endpoints. Reported so the UI's usage ring measures
   * against the real budget instead of guessing the provider's window.
   */
  contextWindowTokens?: number
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
}

export { AgentRuntimeError } from './model/types'
export type { AgentBridgeClient } from './model/types'

export class AgentRuntime {
  readonly #bridgeClient: AgentBridgeClient
  readonly #router: ModelRouter
  readonly #model: string
  readonly #think: boolean
  readonly #contextWindow: number
  readonly #numPredict: number
  readonly #maxToolRounds: number
  readonly #disabledTools: Set<string>
  readonly #contextState: ContextState | undefined
  readonly #executionLedger: ToolExecutionLedger | undefined
  readonly #operationCoordinator: DocumentOperationCoordinator | undefined
  readonly #resolveToolResult: ((value: unknown) => Promise<unknown>) | undefined

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
    this.#disabledTools = new Set<string>()
    this.#contextState = options.contextState
    this.#executionLedger = options.executionLedger
    this.#operationCoordinator = options.operationCoordinator
    this.#resolveToolResult = options.resolveToolResult
  }

  async summarizeTitle(text: string, signal?: AbortSignal): Promise<string> {
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
    const provider = apiActive
      ? this.#router.forEndpoint({
          kind: 'openai',
          baseUrl: api!.baseUrl,
          apiKey: api!.apiKey,
        })
      : this.#router.local()
    const disabledTools = new Set(input.disabledTools ?? [])
    const model = apiActive
      ? api!.model!.trim()
      : (input.model?.trim() || this.#model)
    const effort = input.reasoningMode
    const think = apiActive
      ? false
      : (effort === undefined ? this.#think : localThinkForEffort(effort))
    const tools = AGENT_TOOL_DEFINITIONS.filter((definition) => !disabledTools.has(definition.function.name))
    // A single execution scope id for this run; the P5 ledger attributes modifying calls
    // to it so crash recovery / approval re-checks can correlate a call with its run.
    const runId = input.runId?.trim() || randomUUID()
    // Effective context window for compaction/pressure (Section 二: finite, never Infinity).
    // - Local Ollama: the CONFIGURED window, clamped by the provider's hard ceiling (32768).
    //   The clamp — not capabilities.defaultContextWindow — is what Ollama actually receives.
    // - API: no num_ctx is sent, but we budget against the provider/model capability window,
    //   falling back to the configured window when it reports none. Never Infinity, so facts
    //   / reference sets / compaction apply to cloud too (Invariant G).
    const capabilities = provider.capabilities(model)
    const effectiveWindow = provider.kind === 'ollama'
      ? clampLocalContextWindow(this.#contextWindow)
      : Math.max(1024, capabilities.maxContextWindow
        ?? capabilities.defaultContextWindow
        ?? this.#contextWindow)
    const contextBlocks: ContextBlock[] = [
      {
        kind: 'other',
        message: {
          role: 'system',
          content: NAVISWORKS_WORKSPACE_PROMPT,
        },
      },
    ]
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
      history: normalizeHistory(input.history ?? []),
      contextBlocks,
    })
    contextManager.addUserTurn({ role: 'user', content: trimmedInput })
    let latestContextTokens = 0
    let latestCacheHitRate: number | undefined
    let lastAssistantText = ''
    let didCompactRun = false
    let capturedSummary: string | undefined
    try {
      // Section 一/1.3: budget-check BEFORE the first model call, not just on later rounds.
      const initialTokens = contextManager.estimateRequestTokens(tools, this.#numPredict)
      if (ContextManager.contextPressure(initialTokens, effectiveWindow) === 'compact') {
        const compacted = await this.#compactMessages(contextManager, input, options)
        if (compacted) {
          didCompactRun = true
          capturedSummary = compacted
        }
      }
      for (let round = 0; round < this.#maxToolRounds; round += 1) {
        throwIfAborted(options.signal)
        // Auto-compaction (P4): usage/effectiveWindow decides pressure — the SAME rule for
        // local and cloud (Invariant G).
        if (ContextManager.contextPressure(latestContextTokens, effectiveWindow) === 'compact') {
          const compacted = await this.#compactMessages(contextManager, input, options)
          if (compacted) {
            didCompactRun = true
            capturedSummary = compacted
          }
        }
        const built = contextManager.assembleBudgetedFrames({
          tools,
          temperature: 0.1,
          maxTokens: this.#numPredict,
          effectiveWindow,
          sendContextWindow: provider.kind === 'ollama',
        })
        const response = await provider.complete({
          model,
          messages: built.messages,
          tools: built.tools,
          think,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          sampling: built.sampling,
          signal: options.signal,
          onDelta: (delta) => {
            if (delta.text !== undefined) options.onEvent?.({ phase: 'text', delta: delta.text })
            if (delta.thinking !== undefined) options.onEvent?.({ phase: 'thinking', delta: delta.thinking })
          },
        })
        latestContextTokens = response.contextTokensUsed
        latestCacheHitRate = response.cacheHitRate
        lastAssistantText = response.content.trim()

        if (response.toolCalls.length === 0) {
          if (!lastAssistantText) {
            return {
              isSuccess: false,
              message: '模型没有返回文本或工具调用，请重试或更换模型。',
              contextTokensUsed: latestContextTokens,
              contextWindowTokens: effectiveWindow,
              errorCode: 'MODEL_EMPTY_RESPONSE',
            }
          }
          return {
            isSuccess: true,
            message: lastAssistantText,
            contextTokensUsed: latestContextTokens,
            contextWindowTokens: effectiveWindow,
            ...(response.thinking.trim() ? { thinkingText: response.thinking } : {}),
            ...(latestCacheHitRate === undefined ? {} : { cacheHitRate: latestCacheHitRate }),
            ...(didCompactRun ? { compacted: true } : {}),
            ...(capturedSummary === undefined || capturedSummary === '' ? {} : { compactSummary: capturedSummary }),
            ...(semanticMemory === undefined ? {} : { semanticMemory }),
          }
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

        for (const toolCall of response.toolCalls) {
          throwIfAborted(options.signal)
          options.onEvent?.({
            phase: 'started',
            runId,
            toolCallId: toolCall.id,
            tool: toolCall.name,
            arguments: toolCall.arguments,
          })

          const toolResult = await this.#executeTool(
            toolCall,
            runId,
            disabledTools,
            options.signal,
            options.requestToolApproval,
            hasExplicitAmbiguousRetryConfirmation(trimmedInput),
            input.navisworksBinding,
            input.navisworksUnavailable,
          )
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
            content: truncateToolResult(toolCall.name, wireResult),
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
        }
        contextManager.addToolExchange(assistantToolMessage, toolResultMessages)
      }

      return {
        isSuccess: false,
        message: `工具调用超过 ${this.#maxToolRounds} 轮，已停止以避免循环。请缩小指令范围后重试。`,
        contextTokensUsed: latestContextTokens,
        contextWindowTokens: effectiveWindow,
        ...(didCompactRun ? { compacted: true } : {}),
        ...(capturedSummary === undefined || capturedSummary === '' ? {} : { compactSummary: capturedSummary }),
        errorCode: 'TOOL_ROUND_LIMIT',
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw createAbortError(options.signal.reason)
      }
      if (error instanceof AgentRuntimeError) {
        return {
          isSuccess: false,
          message: error.message,
          contextTokensUsed: latestContextTokens,
          contextWindowTokens: effectiveWindow,
          errorCode: error.code,
        }
      }
      if (error instanceof NavisworksTargetError) {
        return {
          isSuccess: false,
          message: error.message,
          contextTokensUsed: latestContextTokens,
          contextWindowTokens: effectiveWindow,
          errorCode: error.code,
        }
      }
      return {
        isSuccess: false,
        message: `模型调用失败：${errorMessage(error)}`,
        contextTokensUsed: latestContextTokens,
        contextWindowTokens: effectiveWindow,
        errorCode: 'MODEL_ERROR',
      }
    }
  }

  async #executeTool(
    toolCall: { id: string; name: string; arguments: Record<string, unknown> },
    runId: string,
    disabledTools: ReadonlySet<string>,
    signal?: AbortSignal,
    requestToolApproval?: RunAgentOptions['requestToolApproval'],
    allowAmbiguousRetry = false,
    navisworksBinding?: NavisworksRunBinding,
    navisworksUnavailable?: AgentRunInput['navisworksUnavailable'],
  ): Promise<{ result?: unknown; error?: { code: string; message: string; ambiguousOutcome?: boolean }; wire: Record<string, unknown> }> {
    const ledger = this.#executionLedger
    const isModifying = toolCatalog.get(toolCall.name)?.impact === 'view-state-change'
    let documentAtRequest: string | undefined
    let ledgerStarted = false
    let executing = false
    try {
      toolCatalog.assertAllowed(toolCall.name, toolCall.arguments)
      if (navisworksUnavailable !== undefined) {
        throw new NavisworksTargetError(navisworksUnavailable.code, navisworksUnavailable.message)
      }
      if (disabledTools.has(toolCall.name)) {
        throw new ToolCatalogError(`工具已被用户禁用：${toolCall.name}`)
      }
      const normalizedArguments = toolCatalog.normalizeArguments(toolCall.name, toolCall.arguments)
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
        const approved = requestToolApproval
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
  ): Promise<string | null> {
    const summarizer = this.#router.local()
    const summarizerModel = input.model?.trim() || this.#model
    let producedSummary = ''
    const config: CompactConfig = {
      summarizerModel,
      signal: options.signal,
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
      ? this.#router.forEndpoint({ kind: 'openai', baseUrl: api!.baseUrl, apiKey: api!.apiKey })
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

function normalizeHistory(history: readonly AgentHistoryEntry[]): ChatMessage[] {
  return history
    .slice(-MAX_HISTORY_MESSAGES)
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
      return ['改用允许列表中的最小必要工具；不需要实时数据时直接回答。']
    default:
      return [
        '确认 Navisworks Manage 2023 已启动。',
        '确认模型文档已打开，并已加载 Navisworks MCP 插件。',
        '如果条件未变且相同错误再次出现，停止重试并向用户说明。',
      ]
  }
}

function truncateToolResult(toolName: string, result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) {
    return result
  }
  let clipped = result.slice(0, MAX_TOOL_RESULT_CHARS)
  const finalCodeUnit = clipped.charCodeAt(clipped.length - 1)
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) {
    clipped = clipped.slice(0, -1)
  }
  // P3: prepend a compact structural summary of what was cut, so the truncation is not a
  // blind slice — the model still sees the shape (counts / keys) of the elided payload.
  const summary = summarizeTruncatedPayload(result)
  return `${clipped}\n\n[工具 ${toolName} 的结果过大（原始 ${result.length} 字符）` +
    `${summary ? `；${summary}` : ''}，已截断至 ${MAX_TOOL_RESULT_CHARS} 字符。完整结果仍保留在本地，` +
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
