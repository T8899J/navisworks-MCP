import { CURI_CORE_PROMPT } from '../../agent/prompts'
import type { ContextSource } from '../types'
import { canonicalFingerprint } from '../contextHash'

/**
 * Baseline source `core/identity`: Curi's stable system identity.
 * NO time, IDs, documents, tasks, memory or facts may ever enter a baseline
 * source — they would churn the prefix and break Invariants A/E.
 */
export const coreSource: ContextSource<string> = {
  key: 'core/identity',
  version: 1,
  mode: 'baseline',
  load: () => CURI_CORE_PROMPT,
  fingerprint: (value) => canonicalFingerprint(value),
  render: (value) => value,
}
