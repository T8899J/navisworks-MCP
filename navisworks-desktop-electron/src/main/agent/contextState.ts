import type { DocumentIdentity } from './documentScope'
import { DocumentScopeRegistry, documentScopeKey } from './documentScope'
import { VerifiedFactStore, extractVerifiedFacts, type VerifiedFact } from './facts'
import {
  ReferenceSetStore,
  extractReferenceSet,
  type ReferenceSet,
} from './referenceSets'
import { ToolResultIndex } from './toolResultIndex'

export interface DocumentDescriptor {
  instanceId?: string
  bridgeSessionId?: string
  documentInstanceId?: string
  documentName?: string
}

export interface CurrentDocumentContext extends DocumentDescriptor {
  connected: boolean
}

export type DocumentTransitionReason =
  | 'instance-changed'
  | 'document-changed'
  | 'bridge-restarted'
  | 'document-closed'
  | 'document-opened'

export interface DocumentTransition {
  revision: number
  previous?: DocumentDescriptor
  current?: DocumentDescriptor
  changedAt: number
  reason: DocumentTransitionReason
}

export type DocumentChangeNotice = DocumentTransition

type DocumentObservation = DocumentIdentity & {
  connected?: boolean
  documentName?: string
  documentTitle?: string
}

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
  readonly #lastSeenDocumentRevision = new Map<string, number>()
  readonly #documentTransitions: DocumentTransition[] = []
  #documentRevision = 0
  #hasObservedDocumentState = false
  #currentDocument: CurrentDocumentContext | undefined
  #lastActiveDocument: DocumentDescriptor | undefined

  constructor() {
    this.registry.onInvalidate((previous) => {
      this.facts.invalidate(previous)
      this.referenceSets.invalidate(previous)
    })
  }

  get documentInstanceId(): string | null {
    return this.registry.documentInstanceId
  }

  get instanceId(): string | null {
    return this.registry.current?.instanceId ?? null
  }

  get documentRevision(): number {
    return this.#documentRevision
  }

  get currentDocument(): CurrentDocumentContext | undefined {
    return this.#currentDocument === undefined ? undefined : { ...this.#currentDocument }
  }

  /** Record the latest bridge status; triggers cross-store invalidation on a change. */
  observe(observation: DocumentObservation | null): void {
    const next = normalizeObservation(observation)
    const previous = this.#currentDocument
    const identityChanged = !sameDocumentIdentity(previous, next)

    this.registry.observe(toDocumentIdentity(next))
    this.#currentDocument = next

    if (!this.#hasObservedDocumentState) {
      this.#hasObservedDocumentState = true
      if (hasDocument(next)) this.#lastActiveDocument = toDescriptor(next)
      return
    }
    if (!identityChanged) {
      if (hasDocument(next)) this.#lastActiveDocument = toDescriptor(next)
      return
    }

    this.#documentRevision += 1
    const transitionPrevious = hasDocument(previous)
      ? toDescriptor(previous)
      : (hasDocument(next) ? this.#lastActiveDocument : toDescriptor(previous))
    const transition: DocumentTransition = {
      revision: this.#documentRevision,
      ...(transitionPrevious === undefined ? {} : { previous: transitionPrevious }),
      ...(hasIdentity(next) ? { current: toDescriptor(next) } : {}),
      changedAt: Date.now(),
      reason: transitionReason(previous, next),
    }
    this.#documentTransitions.push(transition)
    if (hasDocument(next)) this.#lastActiveDocument = toDescriptor(next)
  }

  /** Return, but do not consume, the document changes pending for one conversation. */
  documentNoticeForSession(sessionId: string): DocumentChangeNotice | undefined {
    const lastSeen = this.#lastSeenDocumentRevision.get(sessionId)
    if (lastSeen === undefined || lastSeen >= this.#documentRevision) return undefined
    const pending = this.#documentTransitions.filter((item) => item.revision > lastSeen)
    const first = pending[0]
    const latest = pending.at(-1)
    if (first === undefined || latest === undefined) return undefined
    return {
      revision: latest.revision,
      ...(first.previous === undefined ? {} : { previous: { ...first.previous } }),
      ...(latest.current === undefined ? {} : { current: { ...latest.current } }),
      changedAt: latest.changedAt,
      reason: latest.reason,
    }
  }

  /** Advance only after a run succeeds; failures and aborts deliberately leave it pending. */
  markDocumentSeen(sessionId: string, revision: number): void {
    const boundedRevision = Math.min(Math.max(0, Math.trunc(revision)), this.#documentRevision)
    const previous = this.#lastSeenDocumentRevision.get(sessionId)
    if (previous === undefined || boundedRevision > previous) {
      this.#lastSeenDocumentRevision.set(sessionId, boundedRevision)
    }
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
      const observation = readObservation(result)
      if (observation !== null) {
        const current = this.registry.current
        const instanceId = observation.instanceId
          ?? (observation.bridgeSessionId === current?.bridgeSessionId ? current?.instanceId : undefined)
        this.observe({
          ...observation,
          ...(instanceId === undefined ? {} : { instanceId }),
        })
      }
    }
    const documentInstanceId = this.registry.documentInstanceId
    if (documentInstanceId === null) return
    const scopeKey = documentScopeKey(this.registry.current)
    if (scopeKey === undefined) return
    const now = () => Date.now()
    const facts = extractVerifiedFacts(toolName, result, { documentInstanceId, sourceToolCallId, now })
    this.facts.addAll(scopeKey, facts)
    const set = extractReferenceSet(toolName, result, {
      documentInstanceId,
      sourceToolCallId,
      ...(conversationId === undefined ? {} : { conversationId }),
      now,
    })
    if (set !== null) this.referenceSets.add(set, scopeKey)
  }

  factsForCurrentDocument(): VerifiedFact[] {
    return this.facts.list(documentScopeKey(this.registry.current))
  }

  lastRelevantReferenceSet(conversationId?: string): ReferenceSet | undefined {
    const key = documentScopeKey(this.registry.current)
    return key === undefined ? undefined : this.referenceSets.lastRelevantSet(key, conversationId)
  }

  canUseDocumentReference(
    referenceDocumentInstanceId: string | undefined | null,
    referenceInstanceId?: string,
  ): boolean {
    return this.registry.canUseDocumentReference(referenceDocumentInstanceId, referenceInstanceId)
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
    this.#lastSeenDocumentRevision.delete(sessionId)
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

function readObservation(result: unknown): DocumentObservation | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
  const record = result as Record<string, unknown>
  const instanceId = typeof record.instanceId === 'string' ? record.instanceId : undefined
  const documentInstanceId = typeof record.documentInstanceId === 'string' ? record.documentInstanceId : undefined
  const bridgeSessionId = typeof record.bridgeSessionId === 'string' ? record.bridgeSessionId : undefined
  const documentName = typeof record.documentName === 'string'
    ? record.documentName
    : (typeof record.documentTitle === 'string' ? record.documentTitle : undefined)
  const connected = typeof record.connected === 'boolean' ? record.connected : undefined
  if (instanceId === undefined && documentInstanceId === undefined && bridgeSessionId === undefined
    && connected === undefined) return null
  return {
    ...(connected === undefined ? {} : { connected }),
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(documentInstanceId === undefined ? {} : { documentInstanceId }),
    ...(bridgeSessionId === undefined ? {} : { bridgeSessionId }),
    ...(documentName === undefined ? {} : { documentName }),
  }
}

function normalizeObservation(observation: DocumentObservation | null): CurrentDocumentContext {
  if (observation === null || observation.connected === false) return { connected: false }
  const documentName = observation.documentName?.trim() || observation.documentTitle?.trim() || undefined
  return {
    connected: observation.connected ?? Boolean(
      observation.instanceId || observation.bridgeSessionId || observation.documentInstanceId || documentName,
    ),
    ...(observation.instanceId?.trim() ? { instanceId: observation.instanceId.trim() } : {}),
    ...(observation.bridgeSessionId?.trim()
      ? { bridgeSessionId: observation.bridgeSessionId.trim() }
      : {}),
    ...(observation.documentInstanceId?.trim()
      ? { documentInstanceId: observation.documentInstanceId.trim() }
      : {}),
    ...(documentName === undefined ? {} : { documentName }),
  }
}

function toDocumentIdentity(document: CurrentDocumentContext): DocumentIdentity | null {
  if (!hasIdentity(document)) return null
  return {
    ...(document.instanceId === undefined ? {} : { instanceId: document.instanceId }),
    ...(document.bridgeSessionId === undefined ? {} : { bridgeSessionId: document.bridgeSessionId }),
    ...(document.documentInstanceId === undefined
      ? {}
      : { documentInstanceId: document.documentInstanceId }),
  }
}

function toDescriptor(
  document: CurrentDocumentContext | undefined,
): DocumentDescriptor | undefined {
  if (document === undefined || !hasIdentity(document)) return undefined
  return {
    ...(document.instanceId === undefined ? {} : { instanceId: document.instanceId }),
    ...(document.bridgeSessionId === undefined ? {} : { bridgeSessionId: document.bridgeSessionId }),
    ...(document.documentInstanceId === undefined
      ? {}
      : { documentInstanceId: document.documentInstanceId }),
    ...(document.documentName === undefined ? {} : { documentName: document.documentName }),
  }
}

function hasIdentity(document: CurrentDocumentContext | undefined): boolean {
  return document !== undefined
    && Boolean(document.instanceId || document.bridgeSessionId || document.documentInstanceId)
}

function hasDocument(document: CurrentDocumentContext | undefined): boolean {
  return document?.documentInstanceId !== undefined
}

function sameDocumentIdentity(
  previous: CurrentDocumentContext | undefined,
  current: CurrentDocumentContext,
): boolean {
  if (previous === undefined) return false
  return (previous.instanceId ?? null) === (current.instanceId ?? null)
    && (previous.bridgeSessionId ?? null) === (current.bridgeSessionId ?? null)
    && (previous.documentInstanceId ?? null) === (current.documentInstanceId ?? null)
}

function transitionReason(
  previous: CurrentDocumentContext | undefined,
  current: CurrentDocumentContext,
): DocumentTransitionReason {
  if (previous?.instanceId !== undefined && current.instanceId !== undefined
    && previous.instanceId !== current.instanceId) return 'instance-changed'
  if (hasDocument(previous) && !hasDocument(current)) return 'document-closed'
  if (!hasDocument(previous) && hasDocument(current)) return 'document-opened'
  if ((previous?.bridgeSessionId ?? null) !== (current.bridgeSessionId ?? null)) {
    return 'bridge-restarted'
  }
  return 'document-changed'
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

export function renderCurrentDocumentContext(
  document: CurrentDocumentContext | undefined,
): string {
  if (document === undefined) return ''
  if (!document.connected || !document.documentInstanceId) {
    return '【当前 Navisworks 文档】\n当前没有可用的 Navisworks 文档。'
  }
  return [
    '【当前 Navisworks 文档】',
    `文档：${document.documentName ?? '未命名文档'}`,
    `documentInstanceId：${document.documentInstanceId}`,
    ...(document.bridgeSessionId === undefined
      ? []
      : [`bridgeSessionId：${document.bridgeSessionId}`]),
    '以上 ID 仅用于运行时事实隔离，不要在最终回答中向用户显示。',
  ].join('\n')
}

export function renderDocumentTransition(notice: DocumentChangeNotice | undefined): string {
  if (notice === undefined) return ''
  const previousName = notice.previous?.documentName ?? '之前的 Navisworks 文档'
  const currentName = notice.current?.documentName ?? '当前没有打开的文档'
  const changeSummary = notice.reason === 'document-closed'
    ? '用户已经关闭了之前的 Navisworks 文档。'
    : notice.reason === 'document-opened'
      ? '用户已经打开或重新打开了一个 Navisworks 文档。'
      : notice.reason === 'instance-changed'
        ? '当前操作目标已经切换到了另一个 Navisworks 窗口。'
        : notice.reason === 'bridge-restarted'
        ? 'Navisworks Bridge 已重新启动，当前文档环境必须视为新的实例。'
        : '用户已经切换了当前 Navisworks 文档。'
  const finalAnswerGuidance = notice.current === undefined
    ? '5. 如果最终回答与这次变化有关，应简洁说明当前文档已经关闭。'
    : `5. 如果最终回答与模型变化有关，应简洁说明：“检测到你已经切换到 ${currentName}，我重新检查了当前模型。”`

  return [
    '【Navisworks 当前环境发生变化】',
    changeSummary,
    `之前文档：${previousName}`,
    `当前文档：${currentName}`,
    '',
    '注意：',
    '1. 之前文档中的构件 ID、搜索结果、选择、属性、可见性和视点结果不能作为当前文档事实。',
    '2. 如果用户现在询问模型内容，应基于当前文档重新调用必要的 Navisworks 工具。',
    `3. 之前针对 ${previousName} 得出的结论仍然属于该文档的历史结果。`,
    `4. 不要因为 ${currentName} 得到了不同结果，就说“之前的回答错误”。`,
    finalAnswerGuidance,
    '6. 只有同一个 documentInstanceId 内的最新工具事实真正推翻旧结果，才能说之前结果有误。',
  ].join('\n')
}
