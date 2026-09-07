import { renderReferenceSetBlock } from '../../agent/contextState'
import { canonicalFingerprint } from '../contextHash'
import type { ContextSource } from '../types'

/**
 * Volatile: the last relevant reference set of the CURRENT document, so
 * "刚才那些 / 第 N 个" resolve against machine-tracked ids. The block itself
 * says a SELECTION set is historical, not the live selection (§33 — never
 * promote it to durable; "当前选择" still requires a fresh get_selection).
 * The value is the rendered text; the snapshot stores its fingerprint only
 * (§49 — never the raw id lists).
 */
export const referenceSetSource: ContextSource<string> = {
  key: 'document/reference-set',
  version: 1,
  mode: 'volatile',
  load(env) {
    const contextState = env.contextState
    if (contextState === undefined) return undefined
    const set = contextState.lastRelevantReferenceSet(env.sessionId)
    if (set === undefined) return undefined
    return renderReferenceSetBlock(set) || undefined
  },
  fingerprint: (value) => canonicalFingerprint(value),
  render: (value) => value,
}
