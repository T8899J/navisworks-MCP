import { canonicalFingerprint } from '../contextHash'
import type { ContextSource } from '../types'
import { getNavisworksContext } from '../../navisworks/contextFragment'

const MAX_RECALL_CHARS = 4_000

/**
 * Volatile: the persisted source payload behind the current reference set,
 * recalled for the runtime's own use (bounded excerpt). A read failure or a
 * missing externalized result SKIPS the block (§50 — recall is optional; the
 * chat run must never fail on it).
 */
export const recallSource: ContextSource<string> = {
  key: 'session/recall',
  version: 1,
  mode: 'volatile',
  async load(env) {
    const contextState = getNavisworksContext(env)?.contextState
    const sessionId = env.sessionId
    if (contextState === undefined || sessionId === undefined) return undefined
    const set = contextState.lastRelevantReferenceSet(sessionId)
    if (set === undefined) return undefined
    const recalled = await contextState.recallToolResult(
      sessionId,
      set.sourceToolCallId,
      env.resolveToolResult,
    )
    if (recalled === undefined) return undefined
    const serialized = JSON.stringify(recalled) ?? ''
    const excerpt = serialized.length > MAX_RECALL_CHARS
      ? `${serialized.slice(0, MAX_RECALL_CHARS)}…[已截断]`
      : serialized
    return `【最近引用集的持久化来源（内部召回）】\n${excerpt}`
  },
  fingerprint: (value) => canonicalFingerprint(value),
  render: (value) => value,
}
