import { Buffer } from 'node:buffer'
import type { ChatMessage } from '../model/types'
import type { AgentToolContract } from '../toolCatalog'
import { estimateTokens } from './tokenBudget'

/**
 * Tool Result Delivery v2 — the SEAM that decides how a full tool result reaches
 * the model, deliberately split from persistence (the ToolOutputStore only
 * saves; THIS decides).
 *
 * The invariant (§三): a tool result is NEVER silently dropped because of a
 * fixed Curi threshold (50KB / 32K chars / 50 items). The only thing that can
 * keep the full result out of the current turn is the model's finite context
 * window — and even then NOTHING is lost: the complete result is stored and
 * returned as a PAGED reference the model reads back via `read_tool_result`.
 * Paged ≠ Truncated.
 */
export type ToolResultDelivery =
  | {
      /** The full result is in the tool message (may ALSO carry a resultRef for
       *  recovery when §六 proactive-save applies). */
      mode: 'full'
      content: unknown
      resultRef?: string
    }
  | {
      /** The full result is stored; the tool message carries a paging pointer. */
      mode: 'paged'
      resultRef: string
      totalBytes: number
      estimatedTokens: number
      reason: 'context-capacity'
    }

/** The model-visible message for a paged (context-overflow) result (§七/§十). */
export const PAGED_TOOL_RESULT_MODEL_MESSAGE
  = '完整工具结果已保存。单次上下文无法完整容纳，请使用 read_tool_result 分页读取；数据未丢失。'

/** The paged content object injected into the tool message (§七). No slice, no
 *  fake "truncated": the full result is on disk behind `resultRef`. */
export function buildPagedResultContent(
  resultRef: string,
  totalBytes: number,
  estimatedTokens: number,
): Record<string, unknown> {
  return {
    delivery: 'paged',
    resultRef,
    totalBytes,
    estimatedTokens,
    message: PAGED_TOOL_RESULT_MODEL_MESSAGE,
  }
}

export function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
}

/** Rough token count of a serialized payload (CJK-dense, mirrors estimateTokens). */
export function estimatedTokensOfSerialized(serialized: string): number {
  return estimateTokens(serialized)
}

/**
 * §八 decision order (NEVER "slice first"):
 *   full result → estimate the full next request → (ContextManager may still
 *   drop removable HISTORY, but never the protected current exchange) →
 *   fits? full : paged.
 *
 * `fits` is the protected-floor predicate from ContextManager: system + context
 * blocks + protected frames (this turn) + the candidate exchange + tool schemas
 * all fit under the context budget. When true the full result goes inline.
 */
export function decideToolResultDelivery(input: {
  fits: boolean
  data: unknown
  /** When set, the full result is ALSO persisted for recovery (§六); the model
   *  still receives the complete content, not a preview. */
  proactiveResultRef?: string
}): ToolResultDelivery {
  if (input.fits) {
    return {
      mode: 'full',
      content: input.data,
      ...(input.proactiveResultRef === undefined ? {} : { resultRef: input.proactiveResultRef }),
    }
  }
  // Not fitting but no stored handle yet — the caller MUST store() before
  // calling; a paged delivery without a ref would be the silent-loss bug we are
  // fixing, so refuse to construct one here.
  if (input.proactiveResultRef === undefined) {
    throw new Error('paged tool result requires a resultRef (store the full result first)')
  }
  const serialized = JSON.stringify(input.data) ?? 'null'
  return {
    mode: 'paged',
    resultRef: input.proactiveResultRef,
    totalBytes: Buffer.byteLength(serialized, 'utf8'),
    estimatedTokens: estimatedTokensOfSerialized(serialized),
    reason: 'context-capacity',
  }
}

/**
 * Projected messages for the CURRENT round's tool exchange: the assistant
 * tool-call message plus every tool-result message about to be added. The
 * delivery policy sizes THIS against the context budget.
 */
export function candidateExchangeMessages(
  assistant: ChatMessage,
  results: readonly ChatMessage[],
): ChatMessage[] {
  return [assistant, ...results]
}

/** Tool contracts used only for token sizing in the delivery predicate. */
export type ToolsForSizing = readonly AgentToolContract[]
