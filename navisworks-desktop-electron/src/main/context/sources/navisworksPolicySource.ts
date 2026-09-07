import { NAVISWORKS_CAPABILITY_PROMPT } from '../../agent/prompts'
import type { ContextSource } from '../types'
import { canonicalFingerprint } from '../contextHash'

/**
 * Baseline source `policy/navisworks`: the capability/behavior policy for
 * Navisworks tools. Pure static text like `core/identity` — its version bump
 * triggers an Epoch rollover (baseline-changed), never an in-place rewrite.
 */
export const navisworksPolicySource: ContextSource<string> = {
  key: 'policy/navisworks',
  version: 1,
  mode: 'baseline',
  load: () => NAVISWORKS_CAPABILITY_PROMPT,
  fingerprint: (value) => canonicalFingerprint(value),
  render: (value) => value,
}
