import type { DocumentIdentity } from './documentScope'

/**
 * Ordered reference sets — the machine-side answer to "第一个 / 第三个 / 刚才那些"
 * (docs/context-runtime.md §一 Document Scope; the "第一个" cross-turn goal). When a tool
 * returns an ordered list, we store the reference order so the runtime — not a re-reading
 * of chat text by a weak model — resolves ordinals. Reference sets are document-bound and
 * die with the document instance.
 */
export type ReferenceSetKind = 'items' | 'selection' | 'viewpoints'

export interface ReferenceSet {
  id: string
  documentInstanceId: string
  sourceToolCallId: string
  kind: ReferenceSetKind
  orderedRefs: string[]
  createdAt: number
  conversationId?: string
  label?: string
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

function collectIds(list: unknown[], keys: string[]): string[] {
  const ids: string[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    for (const key of keys) {
      const id = asString(entry[key])
      if (id !== undefined) {
        ids.push(id)
        break
      }
    }
  }
  return ids
}

let setSequence = 0

/** Build a ReferenceSet from a tool result, or null when the tool yields none. */
export function extractReferenceSet(
  toolName: string,
  result: unknown,
  context: {
    documentInstanceId: string
    sourceToolCallId: string
    conversationId?: string
    now?: () => number
  },
): ReferenceSet | null {
  const record = isRecord(result) ? result : null
  if (record === null) return null
  let kind: ReferenceSetKind
  let orderedRefs: string[]
  switch (toolName) {
    case 'navisworks_find_items':
      kind = 'items'
      orderedRefs = collectIds(asArray(record.items), ['id', 'itemId'])
      break
    case 'navisworks_get_selection':
      kind = 'selection'
      orderedRefs = collectIds(asArray(record.items), ['id', 'itemId'])
      break
    case 'navisworks_list_viewpoints':
      kind = 'viewpoints'
      orderedRefs = collectIds(asArray(record.viewpoints), ['guid', 'id'])
      break
    default:
      return null
  }
  if (orderedRefs.length === 0) return null
  setSequence += 1
  return {
    id: `rs_${context.documentInstanceId.slice(0, 8)}_${setSequence}`,
    documentInstanceId: context.documentInstanceId,
    sourceToolCallId: context.sourceToolCallId,
    kind,
    orderedRefs,
    createdAt: context.now?.() ?? Date.now(),
    ...(context.conversationId === undefined ? {} : { conversationId: context.conversationId }),
  }
}

const CJK_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

/**
 * Parse an ordinal phrase ("第一个" / "第3个" / "第 2 项") to a 1-based index.
 * Returns null for anything it cannot confidently read (no guessing).
 */
export function parseOrdinal(phrase: string): number | null {
  const match = /第\s*([0-9]+|[一二三四五六七八九十])\s*(?:个|项|条)?/.exec(phrase)
  if (!match || match[1] === undefined) return null
  const token = match[1]
  const numeric = Number.parseInt(token, 10)
  if (!Number.isNaN(numeric)) return numeric
  return CJK_DIGITS[token] ?? null
}

export class ReferenceSetStore {
  readonly #byDocument = new Map<string, ReferenceSet[]>()
  readonly #lastRelevant = new Map<string, string>()

  add(set: ReferenceSet): void {
    const bucket = this.#byDocument.get(set.documentInstanceId) ?? []
    bucket.push(set)
    this.#byDocument.set(set.documentInstanceId, bucket)
    this.#lastRelevant.set(referencePointerKey(set.conversationId, set.documentInstanceId), set.id)
  }

  get(documentInstanceId: string, setId: string): ReferenceSet | undefined {
    return this.#byDocument.get(documentInstanceId)?.find((set) => set.id === setId)
  }

  lastRelevantSetId(documentInstanceId: string, conversationId?: string): string | undefined {
    return this.#lastRelevant.get(referencePointerKey(conversationId, documentInstanceId))
  }

  lastRelevantSet(documentInstanceId: string, conversationId?: string): ReferenceSet | undefined {
    const id = this.lastRelevantSetId(documentInstanceId, conversationId)
    return id === undefined ? undefined : this.get(documentInstanceId, id)
  }

  forgetConversation(conversationId: string): void {
    const prefix = `${conversationId}:`
    for (const key of this.#lastRelevant.keys()) {
      if (key.startsWith(prefix)) this.#lastRelevant.delete(key)
    }
  }

  /** Resolve a 1-based ordinal against a set; out-of-range returns null (never fabricate). */
  resolveOrdinal(set: ReferenceSet, indexOneBased: number): string | null {
    if (!Number.isInteger(indexOneBased) || indexOneBased < 1) return null
    return set.orderedRefs[indexOneBased - 1] ?? null
  }

  invalidate(identity: DocumentIdentity): void {
    if (identity.documentInstanceId !== undefined) {
      this.#byDocument.delete(identity.documentInstanceId)
      for (const key of this.#lastRelevant.keys()) {
        if (key.endsWith(`:${identity.documentInstanceId}`)) this.#lastRelevant.delete(key)
      }
    }
  }
}

function referencePointerKey(conversationId: string | undefined, documentInstanceId: string): string {
  return `${conversationId ?? '__default__'}:${documentInstanceId}`
}
