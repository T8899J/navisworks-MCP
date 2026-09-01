/**
 * P3 Tool Result Index / Recall.
 *
 * Do NOT create a second Session Store. This module indexes over the already persisted
 * conversation messages (`session.messages[].tools[]`), because `sessions.json` already
 * stores id/name/arguments/result/error for each tool call. A minimal structural type keeps
 * this main-process module decoupled from the renderer's message classes.
 */

/** The subset of a persisted tool call the index needs. */
export interface IndexableToolCall {
  id: string
  name: string
  status?: string
  result?: unknown
  error?: string
}

/** The subset of a persisted message the index needs. */
export interface IndexableMessage {
  id: string
  createdAt: string
  tools: readonly IndexableToolCall[]
}

export interface IndexedToolResult {
  sessionId: string
  messageId: string
  toolCallId: string
  toolName: string
  status: string
  result: unknown
  error?: string
  createdAt: string
  /** Optional externalized payload pointer; raw JSON is not stored in sessions.json. */
  payloadPath?: string
}

export class ToolResultIndex {
  readonly #byToolCallId = new Map<string, IndexedToolResult>()
  readonly #bySession = new Map<string, IndexedToolResult[]>()

  replaceSession(sessionId: string, messages: readonly IndexableMessage[]): void {
    this.deleteSession(sessionId)
    for (const message of messages) {
      for (const tool of message.tools) {
        const indexed: IndexedToolResult = {
          sessionId,
          messageId: message.id,
          toolCallId: tool.id,
          toolName: tool.name,
          status: tool.status ?? 'success',
          result: tool.result,
          ...(tool.error === undefined ? {} : { error: tool.error }),
          createdAt: message.createdAt,
        }
        this.#byToolCallId.set(toolCallKey(sessionId, tool.id), indexed)
        const bucket = this.#bySession.get(sessionId) ?? []
        bucket.push(indexed)
        this.#bySession.set(sessionId, bucket)
      }
    }
  }

  get(sessionId: string, toolCallId: string): IndexedToolResult | undefined {
    return this.#byToolCallId.get(toolCallKey(sessionId, toolCallId))
  }

  getBySession(sessionId: string): IndexedToolResult[] {
    return [...(this.#bySession.get(sessionId) ?? [])]
  }

  getLatestByTool(sessionId: string, toolName: string): IndexedToolResult | undefined {
    // Use persisted order, NOT createdAt: the desktop session store stamps every message
    // with the session's updatedAt, so timestamps tie and can't identify "latest". The
    // per-session list is built in message/tool persistence order, so the LAST matching
    // entry is the most recent by construction (stable when timestamps are equal).
    let latest: IndexedToolResult | undefined
    for (const entry of this.getBySession(sessionId)) {
      if (entry.toolName === toolName) latest = entry
    }
    return latest
  }

  /**
   * Return the raw result source behind a reference-set-producing call.
   * P3 deliberately starts internal: ContextState / runtime can call this when it needs
   * more data, without exposing a new LLM-visible read tool yet.
   */
  getReferenceSetSource(sessionId: string, toolCallId: string): unknown | undefined {
    return this.get(sessionId, toolCallId)?.result
  }

  deleteSession(sessionId: string): void {
    for (const entry of this.getBySession(sessionId)) {
      this.#byToolCallId.delete(toolCallKey(sessionId, entry.toolCallId))
    }
    this.#bySession.delete(sessionId)
  }

  get size(): number {
    return this.#byToolCallId.size
  }
}

function toolCallKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`
}
