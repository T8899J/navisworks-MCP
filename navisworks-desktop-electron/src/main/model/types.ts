import type { BridgeCallOptions } from '../bridgeClient'
import type { AgentToolContract } from '../toolCatalog'

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
  /** Prompt + completion tokens when reported; 0 when the backend is silent. */
  contextTokensUsed: number
  /** Cached prompt tokens / prompt tokens, when the backend reports it. */
  cacheHitRate?: number
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

export class AgentRuntimeError extends Error {
  readonly code: AgentErrorCode

  constructor(code: AgentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentRuntimeError'
    this.code = code
  }
}
