import { renderSemanticMemory } from '../../agent/semanticMemory'
import type { SemanticMemory } from '../../agent/semanticMemory'
import { canonicalFingerprint } from '../contextHash'
import type { ContextSource } from '../types'

/**
 * Volatile session memory (§7): goals/constraints change with user input far
 * too often to be durable — it stays in the working set, never in updates.
 * updatedAt is excluded from the fingerprint so a pure timestamp bump does
 * not re-render the block.
 */
export const semanticMemorySource: ContextSource<SemanticMemory> = {
  key: 'session/semantic-memory',
  version: 1,
  mode: 'volatile',
  load(env) {
    const memory = env.semanticMemory
    if (memory === undefined || memory.goals.length === 0) return undefined
    return memory
  },
  fingerprint(value) {
    return canonicalFingerprint({
      goals: value.goals,
      constraints: value.constraints,
      decisions: value.decisions,
      notes: value.notes,
    })
  },
  render: (value) => renderSemanticMemory(value),
}
