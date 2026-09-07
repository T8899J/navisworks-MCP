import type { BridgeCallOptions } from '../bridgeClient'
import type { AgentToolContract } from '../toolCatalog'
import type { ReasoningEffort } from '../../shared/reasoning'
import type { ModelInfo } from '../../shared/model'

/**
 * Provider-neutral chat message. Each provider maps this onto its own wire
 * format (Ollama ndjson vs OpenAI-compatible chat completions).
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant messages requesting tool executions. */
  toolCalls?: readonly ToolCallWire[]
  /** Tool result messages: the id of the call this content answers. */
  toolCallId?: string
}

export interface ToolCallWire {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface SamplingOptions {
  temperature?: number
  maxTokens?: number
  /** Local-request context window; cloud endpoints size their own. */
  contextWindow?: number
}

/**
 * Read-only model/provider capability surface consumed by ContextManager so it never
 * branches on "local vs cloud" itself (docs/context-runtime.md §五, Invariant G).
 * `maxContextWindow` / `defaultContextWindow` are absent when the provider does not know
 * its window — the caller then uses a configured value or a safe default, NOT an assumed 1M.
 */
export interface ModelCapabilities {
  supportsTools: boolean
  supportsThinking: boolean
  maxContextWindow?: number
  defaultContextWindow?: number
  maxOutputTokens?: number
}

export interface CompletionDelta {
  text?: string
  thinking?: string
}

export interface CompletionRequest {
  model: string
  messages: readonly ChatMessage[]
  /** Function-schema tool definitions; providers omit them when empty. */
  tools?: readonly AgentToolContract[]
  /** Local reasoning toggle (Ollama `think`); cloud providers may ignore it. */
  think?: boolean
  /** Five-step effort sent verbatim to API endpoints as `reasoning_effort`. */
  reasoningEffort?: ReasoningEffort
  sampling?: SamplingOptions
  signal?: AbortSignal
  onDelta?: (delta: CompletionDelta) => void
}

export interface ParsedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface CompletionResult {
  content: string
  thinking: string
  toolCalls: ParsedToolCall[]
  /**
   * The single source of truth for token accounting (P6). Absent only when
   * the backend reported nothing.
   */
  usage?: import('../../shared/model').ModelUsage
  /**
   * @deprecated Derived compatibility field: `totalUsedTokens(usage)`. Providers
   * must never compute this independently of `usage` — drift is a bug.
   */
  contextTokensUsed: number
  /**
   * @deprecated Derived compatibility field: `calculateCacheHitRate(usage)`;
   * undefined = the backend did not report cache info (NOT 0%).
   */
  cacheHitRate?: number
}

/**
 * Optional provider seam: a provider that knows model metadata implements
 * this. `ModelInfo.ref.providerId` is a PLACEHOLDER connection family id here
 * — the connection-scoped identity (`ollama` / `api:<profileId>`) is assigned
 * by ModelResolver/ModelCatalog, which is the only place that knows which
 * profile an endpoint belongs to.
 */
export interface ModelInfoProvider {
  modelInfo(modelId: string): ModelInfo
}

export function isModelInfoProvider(provider: unknown): provider is ModelInfoProvider {
  return typeof (provider as ModelInfoProvider | undefined)?.modelInfo === 'function'
}

export type ProviderKind = 'ollama' | 'openai'

export interface ProviderEndpoint {
  kind: ProviderKind
  baseUrl?: string
  apiKey?: string
}

export interface ProviderCheckResult {
  ok: boolean
  message: string
}

/**
 * One chat backend. Implementations own URL/auth/wire/streaming details and
 * normalize every failure into AgentRuntimeError with a generic code.
 */
export interface ModelProvider {
  readonly kind: ProviderKind
  readonly displayName: string
  complete(request: CompletionRequest): Promise<CompletionResult>
  listModels(signal?: AbortSignal): Promise<string[]>
  testConnection(model: string, signal?: AbortSignal): Promise<ProviderCheckResult>
  /** Static capability view consumed by ContextManager; never branches on local/cloud. */
  capabilities(model: string): ModelCapabilities
  /** One-shot title generation when the backend supports it cheaply. */
  summarizeTitle?(model: string, text: string, signal?: AbortSignal): Promise<string>
}

/** The bridge seam the runtime executes tools through. */
export interface AgentBridgeClient {
  call<T = unknown>(
    method: string,
    parameters?: Record<string, unknown>,
    options?: BridgeCallOptions,
  ): Promise<T>
}

export type AgentErrorCode =
  | 'MODEL_TIMEOUT'
  | 'MODEL_HTTP_ERROR'
  | 'MODEL_IO'
  | 'MODEL_INVALID_RESPONSE'
  | 'MODEL_EMPTY_RESPONSE'
  | 'EMPTY_INPUT'
  | 'TOOL_ROUND_LIMIT'
  /** The active provider has no usable model configured (P5 explicit failure). */
  | 'MODEL_NOT_CONFIGURED'

export class AgentRuntimeError extends Error {
  readonly code: AgentErrorCode

  constructor(code: AgentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentRuntimeError'
    this.code = code
  }
}
