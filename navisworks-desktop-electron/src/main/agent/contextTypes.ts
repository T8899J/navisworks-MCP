import type { ChatMessage } from '../model/types'
import type { AgentToolContract } from '../toolCatalog'

/** Re-exported so the agent/ layer does not reach into model/ for the shared frame type. */
export type { ChatMessage }

/**
 * State scopes (docs/context-runtime.md §一). Document and Conversation are ORTHOGONAL,
 * never parent/child; Run binds the current Conversation to the current Document.
 */
export type ScopeKind = 'app' | 'document' | 'conversation' | 'run'

/**
 * The token budget that bounds the model request's context.
 * contextBudget = effectiveContextWindow - outputReserve - providerOverhead - safetyMargin.
 * `effectiveContextWindow` is supplied by the caller (already clamped against
 * ModelCapabilities.maxContextWindow); ContextManager never decides local vs cloud.
 */
export interface ContextBudgetConfig {
  effectiveContextWindow: number
  outputReserve: number
  providerOverhead: number
  safetyMargin: number
}

/** Per-request diagnostics of one context assembly (docs/context-runtime.md §六). */
export interface ContextBuildReport {
  contextWindow: number
  estimatedInputTokens: number
  outputReserve: number
  safetyMargin: number
  systemTokens: number
  toolSchemaTokens: number
  semanticMemoryTokens: number
  workingStateTokens: number
  verifiedFactTokens: number
  recentFrameTokens: number
  framesIncluded: number
  framesDropped: number
  compacted: boolean
}

/**
 * A single provider request produced by ContextManager: the exact message array,
 * the sampled tool definitions, the provider-neutral sampling fields, and the report.
 * `sampling.contextWindow` is `undefined` when the effective window is not finite
 * (the local provider must then send no num_ctx, matching the pre-refactor shape).
 */
export interface BuiltAgentRequest {
  messages: ChatMessage[]
  tools: AgentToolContract[]
  sampling: {
    temperature: number
    maxTokens: number
    contextWindow?: number
  }
  report: ContextBuildReport
}
