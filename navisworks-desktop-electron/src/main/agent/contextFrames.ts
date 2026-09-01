import type { ChatMessage } from '../model/types'

/**
 * The unit of context management (docs/context-runtime.md §三). Trimming, compaction,
 * budgeting and recall operate on frames, never on individual ChatMessages, so that a
 * tool call and its result are always kept or dropped together (Invariant D).
 */
export type ContextFrame =
  | UserTurnFrame
  | AssistantTextFrame
  | ToolExchangeFrame
  | CompactSummaryFrame

export interface UserTurnFrame {
  type: 'user'
  message: ChatMessage
}

export interface AssistantTextFrame {
  type: 'assistant-text'
  message: ChatMessage
}

export interface ToolExchangeFrame {
  type: 'tool-exchange'
  /** The assistant message that requested one or more tool calls. */
  assistant: ChatMessage
  /** One result message per call id, in order. Never split from `assistant`. */
  results: ChatMessage[]
  toolCallIds: string[]
}

export interface CompactSummaryFrame {
  type: 'compact-summary'
  message: ChatMessage
}

/** Flatten frames back to provider messages, in order. */
export function contextFramesToMessages(frames: readonly ContextFrame[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const frame of frames) {
    switch (frame.type) {
      case 'user':
      case 'assistant-text':
      case 'compact-summary':
        messages.push(frame.message)
        break
      case 'tool-exchange':
        messages.push(frame.assistant, ...frame.results)
        break
    }
  }
  return messages
}

/**
 * Group a flat ChatMessage array into frames. The leading `system` prompt is NOT a
 * frame — callers hold it separately and re-prepend it. An assistant message carrying
 * `toolCalls` binds with its immediately following `tool` results into one
 * ToolExchangeFrame. Any remaining `system` message (a prior compaction summary)
 * becomes a CompactSummaryFrame; a stray/unpaired `tool` message is preserved as its
 * own user frame so nothing is silently dropped (and can be flagged by the guard).
 */
export function messagesToContextFrames(messages: readonly ChatMessage[]): ContextFrame[] {
  const frames: ContextFrame[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index] as ChatMessage
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const toolCallIds = message.toolCalls.map((call) => call.id)
      const idSet = new Set(toolCallIds)
      const results: ChatMessage[] = []
      index += 1
      for (;;) {
        const next = messages[index]
        if (
          next === undefined
          || next.role !== 'tool'
          || next.toolCallId === undefined
          || !idSet.has(next.toolCallId)
        ) break
        results.push(next)
        index += 1
      }
      frames.push({ type: 'tool-exchange', assistant: message, results, toolCallIds })
      continue
    }
    if (message.role === 'user') {
      frames.push({ type: 'user', message })
    } else if (message.role === 'assistant') {
      frames.push({ type: 'assistant-text', message })
    } else if (message.role === 'system') {
      frames.push({ type: 'compact-summary', message })
    } else {
      // Defensive: a tool message with no preceding assistant tool_calls. Kept as a
      // user frame so it survives to provider messages; the guard below flags it.
      frames.push({ type: 'user', message })
    }
    index += 1
  }
  return frames
}

/**
 * Invariant D guard: every `tool` result message must have a matching tool-call id on
 * an immediately preceding assistant message. Returns the offending ids (empty = valid).
 */
export function findOrphanToolMessages(messages: readonly ChatMessage[]): string[] {
  let pendingCallIds: Set<string> | undefined
  const orphans: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      pendingCallIds = new Set(message.toolCalls.map((call) => call.id))
      continue
    }
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || !pendingCallIds?.delete(message.toolCallId)) {
        orphans.push(message.toolCallId ?? '(missing toolCallId)')
      }
      continue
    }
    pendingCallIds = undefined
  }
  return orphans
}
