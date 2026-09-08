import { renderVerifiedFacts } from '../../agent/facts'
import { canonicalFingerprint } from '../contextHash'
import type { ContextSource } from '../types'
import { getNavisworksContext } from '../../navisworks/contextFragment'

/**
 * Volatile facts for the CURRENT document, read straight from ContextState.
 * Cross-document isolation is ContextState's job (§34): after a document
 * switch this returns nothing from the old document. The snapshot stores only
 * the rendered text (bounded to 24 facts), never the fact objects.
 * P30.8: ContextState is read via this capability's namespaced fragment.
 */
export const verifiedFactsSource: ContextSource<string> = {
  key: 'document/verified-facts',
  version: 1,
  mode: 'volatile',
  load(env) {
    const contextState = getNavisworksContext(env)?.contextState
    if (contextState === undefined) return undefined
    return renderVerifiedFacts(contextState.factsForCurrentDocument()) || undefined
  },
  fingerprint: (value) => canonicalFingerprint(value),
  render: (value) => value,
}
