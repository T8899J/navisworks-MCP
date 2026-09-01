import type { DocumentIdentity } from './documentScope'
import { DocumentScopeRegistry } from './documentScope'
import { VerifiedFactStore, extractVerifiedFacts, type VerifiedFact } from './facts'
import {
  ReferenceSetStore,
  extractReferenceSet,
  type ReferenceSet,
} from './referenceSets'
import { ToolResultIndex } from './toolResultIndex'

/**
 * The live Document Scope for one main process (docs/context-runtime.md §一). It ties the
 * identity registry to the per-document fact and reference-set stores: observing a new
 * `documentInstanceId` invalidates the previous document's facts and sets in one place, so
 * no stale engineering reference can survive a document switch (Invariants A/B/C).
 *
 * It is transport-agnostic — the runtime feeds it from the polled `navisworks_status` and
 * from every tool result the agent executes.
 */
export class ContextState {
  readonly registry = new DocumentScopeRegistry()
  readonly facts = new VerifiedFactStore()
  readonly referenceSets = new ReferenceSetStore()
  /** P3 tool-result index over persisted messages; no second Session Store. */
  readonly toolResults = new ToolResultIndex()

  constructor() {
    this.registry.onInvalidate((previous) => {
      this.facts.invalidate(previous)
      this.referenceSets.invalidate(previous)
    })
  }

  get documentInstanceId(): string | null {
    return this.registry.documentInstanceId
  }

  /** Record the latest bridge status; triggers cross-store invalidation on a change. */
  observe(identity: DocumentIdentity | null): void {
    this.registry.observe(identity)
  }

  /**
   * Deterministically lift facts + an ordered reference set out of a tool result and
   * attribute them to the current document instance. A no-op when no document is active.
   *
   * `navisworks_status` / `navisworks_get_document` themselves carry the document identity,
   * so ingesting one first updates the registry — the agent loop stays identity-correct even
   * before the 5 s poll has observed a switch.
   */
  ingestToolResult(
    toolName: string,
    result: unknown,
    sourceToolCallId: string,
    conversationId?: string,
  ): void {
    if (toolName === 'navisworks_status' || toolName === 'navisworks_get_document') {
      const identity = readIdentity(result)
      if (identity !== null) this.registry.observe(identity)
    }
    const documentInstanceId = this.registry.documentInstanceId
    if (documentInstanceId === null) return
    const now = () => Date.now()
    const facts = extractVerifiedFacts(toolName, result, { documentInstanceId, sourceToolCallId, now })
    this.facts.addAll(documentInstanceId, facts)
    const set = extractReferenceSet(toolName, result, {
      documentInstanceId,
      sourceToolCallId,
      ...(conversationId === undefined ? {} : { conversationId }),
      now,
    })
    if (set !== null) this.referenceSets.add(set)
  }

  factsForCurrentDocument(): VerifiedFact[] {
    return this.facts.list(this.registry.documentInstanceId ?? undefined)
  }

  lastRelevantReferenceSet(conversationId?: string): ReferenceSet | undefined {
    const id = this.registry.documentInstanceId
    return id === null ? undefined : this.referenceSets.lastRelevantSet(id, conversationId)
  }

  canUseDocumentReference(referenceDocumentInstanceId: string | undefined | null): boolean {
    return this.registry.canUseDocumentReference(referenceDocumentInstanceId)
  }

  /** Refresh the P3 index from a session's persisted messages (no separate store copy). */
  ingestConversationMessages(
    sessionId: string,
    messages: Parameters<ToolResultIndex['replaceSession']>[1],
  ): void {
    this.toolResults.replaceSession(sessionId, messages)
  }

  /** Drop a deleted session's index entries. */
  forgetSession(sessionId: string): void {
    this.toolResults.deleteSession(sessionId)
    this.referenceSets.forgetConversation(sessionId)
  }

  /**
   * Runtime-internal recall: latest tool result for a tool in a session, with an
   * externalized payload resolved to full JSON (P3 §五 — no LLM-visible read tool yet).
   */
  async recallLatestToolResult(
    sessionId: string,
    toolName: string,
    resolve: (value: unknown) => Promise<unknown> = async (value) => value,
  ): Promise<unknown | undefined> {
    const entry = this.toolResults.getLatestByTool(sessionId, toolName)
    if (entry === undefined) return undefined
    return resolve(entry.result)
  }

  async recallToolResult(
    sessionId: string,
    toolCallId: string,
    resolve: (value: unknown) => Promise<unknown> = async (value) => value,
  ): Promise<unknown | undefined> {
    const value = this.toolResults.getReferenceSetSource(sessionId, toolCallId)
    return value === undefined ? undefined : resolve(value)
  }
}

function readIdentity(result: unknown): DocumentIdentity | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
  const record = result as Record<string, unknown>
  const documentInstanceId = typeof record.documentInstanceId === 'string' ? record.documentInstanceId : undefined
  const bridgeSessionId = typeof record.bridgeSessionId === 'string' ? record.bridgeSessionId : undefined
  if (documentInstanceId === undefined && bridgeSessionId === undefined) return null
  return { ...(documentInstanceId === undefined ? {} : { documentInstanceId }), ...(bridgeSessionId === undefined ? {} : { bridgeSessionId }) }
}

/**
 * Render the current document's last result set as a compact, order-preserving block for
 * injection into the agent context, so "第一个 / 第三个" resolves against machine-tracked
 * ids instead of a weak model re-reading chat text (P2-D goal). Returns '' when there is
 * no active document or no prior set.
 */
export function renderReferenceSetBlock(set: ReferenceSet | undefined | null): string {
  if (set === undefined || set === null || set.orderedRefs.length === 0) return ''
  const lines = set.orderedRefs
    .slice(0, 50)
    .map((ref, index) => `${index + 1}. ${ref}`)
    .join('\n')
  const more = set.orderedRefs.length > 50 ? `\n（共 ${set.orderedRefs.length} 项，仅列出前 50）` : ''
  const kind = set.kind === 'viewpoints' ? '视点' : set.kind === 'selection' ? '当前选择' : '最近结果集'
  return `【${kind}（按结果顺序，可被“第 N 个”引用）】\n${lines}${more}`
}
