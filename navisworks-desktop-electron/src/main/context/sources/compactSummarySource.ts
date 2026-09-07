import { canonicalFingerprint } from '../contextHash'
import type { ContextSource } from '../types'

/**
 * The durable compact summary of earlier (compacted) turns. Volatile in the
 * engine's reconcile sense (re-read every run, never appended as an update),
 * but stable in the assembly because the engine renders it at a FIXED slot
 * (right after the baseline) — the same text compaction produced. When a
 * compaction commits, the summary rides into the NEW epoch as its seed (§36).
 */
export const compactSummarySource: ContextSource<string> = {
  key: 'session/compact-summary',
  version: 1,
  mode: 'volatile',
  load(env) {
    const text = env.compactSummary?.trim()
    return text ? text : undefined
  },
  fingerprint: (value) => canonicalFingerprint(value),
  render: (value) => `早期对话摘要（供参考，非实时事实）：\n${value}`,
}
