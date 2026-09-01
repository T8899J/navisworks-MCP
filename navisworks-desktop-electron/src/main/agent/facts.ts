import type { DocumentIdentity } from './documentScope'

/**
 * A tool-verified engineering fact (docs/context-runtime.md §一 Document Scope, Invariants
 * A–C). "Accurate" and "still valid" are separate: every fact records where it came from,
 * which document instance it belongs to, when it was observed, and how volatile it is.
 *
 * Invariant C is enforced by construction: the ONLY way to create a VerifiedFact is the
 * deterministic {@link extractVerifiedFacts} over a real tool result. There is no
 * constructor that accepts free LLM text, so a summary can never masquerade as a fact.
 */
export type VerifiedFactType =
  | 'item'
  | 'property'
  | 'selection'
  | 'viewpoint'
  | 'visibility'
  | 'count'
  | 'document'

/** 'stable' avoids a live document; 'document' dies with the instance; 'volatile' can be
 * changed by the user in the Navisworks UI at any moment (selection / visibility). */
export type FactVolatility = 'stable' | 'document' | 'volatile'
export type FactPriority = 'critical' | 'active' | 'normal'

export interface VerifiedFact {
  id: string
  type: VerifiedFactType
  key: string
  value: unknown
  sourceToolCallId: string
  documentInstanceId?: string
  observedAt: number
  volatility: FactVolatility
  priority: FactPriority
}

export interface FactExtractionContext {
  documentInstanceId?: string
  sourceToolCallId: string
  /** Injectable clock so tests are deterministic. */
  now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

let factSequence = 0
function nextFactId(prefix: string): string {
  factSequence += 1
  return `fact_${prefix}_${factSequence}`
}

/**
 * Deterministically lift the fields an agent may later reference out of a tool result.
 * Returns [] for unknown tools or malformed payloads — it never guesses or invents.
 */
export function extractVerifiedFacts(
  toolName: string,
  result: unknown,
  context: FactExtractionContext,
): VerifiedFact[] {
  const record = isRecord(result) ? result : null
  if (record === null) return []
  const observedAt = context.now?.() ?? Date.now()
  const facts: VerifiedFact[] = []
  const make = (
    partial: Omit<VerifiedFact, 'id' | 'sourceToolCallId' | 'documentInstanceId' | 'observedAt'>
      & { id?: string },
  ): VerifiedFact => ({
    id: partial.id ?? nextFactId(partial.type),
    sourceToolCallId: context.sourceToolCallId,
    observedAt,
    ...(context.documentInstanceId === undefined
      ? {}
      : { documentInstanceId: context.documentInstanceId }),
    type: partial.type,
    key: partial.key,
    value: partial.value,
    volatility: partial.volatility,
    priority: partial.priority,
  })

  switch (toolName) {
    case 'navisworks_status': {
      const title = asString(record.documentTitle)
      const fileName = asString(record.documentFileName)
      if (record.hasDocument === true && (title || fileName)) {
        facts.push(make({
          type: 'document', key: 'document', value: { title, fileName },
          volatility: 'document', priority: 'active',
        }))
      }
      break
    }
    case 'navisworks_get_document': {
      const title = asString(record.title)
      if (title !== undefined || asString(record.fileName) !== undefined) {
        facts.push(make({
          type: 'document', key: 'document',
          value: { title, fileName: asString(record.fileName), modelCount: record.modelCount },
          volatility: 'document', priority: 'active',
        }))
      }
      break
    }
    case 'navisworks_find_items': {
      const items = asArray(record.items)
      for (const item of items) {
        if (!isRecord(item)) continue
        const id = asString(item.id) ?? asString(item.itemId)
        if (id === undefined) continue
        facts.push(make({
          type: 'item', key: `item:${id}`, value: { name: asString(item.name) },
          volatility: 'document', priority: 'normal',
        }))
      }
      const total = record.total
      if (typeof total === 'number') {
        facts.push(make({ type: 'count', key: 'find_total', value: total, volatility: 'document', priority: 'normal' }))
      }
      break
    }
    case 'navisworks_get_selection': {
      const items = asArray(record.items)
      const selected: string[] = []
      for (const item of items) {
        if (isRecord(item)) {
          const id = asString(item.id) ?? asString(item.itemId)
          if (id !== undefined) selected.push(id)
        }
      }
      // Selection is user-mutable at any time → volatile.
      facts.push(make({
        type: 'selection', key: 'selection', value: { itemIds: selected },
        volatility: 'volatile', priority: 'active',
      }))
      break
    }
    case 'navisworks_get_item_properties': {
      const items = asArray(record.items)
      for (const item of items) {
        if (!isRecord(item)) continue
        const id = asString(item.id) ?? asString(item.itemId)
        if (id === undefined) continue
        facts.push(make({
          type: 'property', key: `properties:${id}`, value: item.properties ?? item.propertyData ?? {},
          volatility: 'document', priority: 'normal',
        }))
      }
      break
    }
    case 'navisworks_list_viewpoints': {
      const viewpoints = asArray(record.viewpoints)
      for (const vp of viewpoints) {
        if (!isRecord(vp)) continue
        const id = asString(vp.guid) ?? asString(vp.id)
        if (id === undefined) continue
        facts.push(make({
          type: 'viewpoint', key: `viewpoint:${id}`, value: { name: asString(vp.name) ?? asString(vp.title) },
          volatility: 'document', priority: 'normal',
        }))
      }
      break
    }
    default:
      return []
  }
  return facts
}

/**
 * Render tool-verified facts as a bounded system block (P4 assembly layer 5). Critical +
 * active facts lead; total is capped so a large result set can never blow the 32K window.
 * Returns '' when there is nothing worth injecting.
 */
export function renderVerifiedFacts(facts: readonly VerifiedFact[], maxFacts = 24): string {
  if (facts.length === 0) return ''
  const rank: Record<FactPriority, number> = { critical: 0, active: 1, normal: 2 }
  const ordered = [...facts]
    .sort((a, b) => rank[a.priority] - rank[b.priority] || b.observedAt - a.observedAt)
    .slice(0, maxFacts)
  const lines = ordered.map((fact) => {
    const value = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)
    return `- [${fact.type}] ${fact.key} = ${value.length > 160 ? `${value.slice(0, 160)}…` : value}`
  })
  return `【已验证事实（来自工具结果，非摘要；如与最新工具结果冲突以最新为准）】\n${lines.join('\n')}`
}

/** Per-document fact store. Document-bound facts are only ever held at runtime. */
export class VerifiedFactStore {
  readonly #byDocument = new Map<string, VerifiedFact[]>()

  addAll(documentInstanceId: string | undefined, facts: readonly VerifiedFact[]): void {
    if (documentInstanceId === undefined) return
    const bucket = this.#byDocument.get(documentInstanceId) ?? []
    for (const fact of facts) {
      const existing = bucket.findIndex((entry) => entry.key === fact.key)
      if (existing >= 0) bucket[existing] = fact
      else bucket.push(fact)
    }
    this.#byDocument.set(documentInstanceId, bucket)
  }

  list(
    documentInstanceId: string | undefined,
    options: { now?: number; volatileMaxAgeMs?: number } = {},
  ): VerifiedFact[] {
    if (documentInstanceId === undefined) return []
    const now = options.now ?? Date.now()
    const volatileMaxAgeMs = options.volatileMaxAgeMs ?? 30_000
    return (this.#byDocument.get(documentInstanceId) ?? []).filter((fact) =>
      fact.volatility !== 'volatile' || now - fact.observedAt <= volatileMaxAgeMs
    )
  }

  /** Called by the registry on identity change (Invariant B / cleanup). */
  invalidate(identity: DocumentIdentity): void {
    if (identity.documentInstanceId !== undefined) {
      this.#byDocument.delete(identity.documentInstanceId)
    }
  }

  get size(): number {
    return [...this.#byDocument.values()].reduce((sum, list) => sum + list.length, 0)
  }
}
