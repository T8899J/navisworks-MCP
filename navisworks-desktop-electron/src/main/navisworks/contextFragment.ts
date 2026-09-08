import type { ContextSourceEnvironment } from '../context/types'
import type { ContextState, CurrentDocumentContext, DocumentChangeNotice } from '../agent/contextState'
import { NAVISWORKS_CAPABILITY_ID } from './capability'

/**
 * P30.8 (§46): the Navisworks capability's OWN namespaced context fragment.
 * This shape lives entirely in the Navisworks layer — the core
 * ContextSourceEnvironment only knows `capabilities.navisworks: unknown`. Every
 * Navisworks context source reads its professional state through
 * getNavisworksContext(), NEVER by reaching into top-level core fields (which
 * no longer exist). This is why adding Files/Web needs no core change.
 */
export interface NavisworksContextFragment {
  /** Live document observation (ContextState.currentDocument at preflight). */
  document?: CurrentDocumentContext
  /** Pending document-change notice for this session (unconsumed). */
  documentNotice?: DocumentChangeNotice
  /** Document revision at preflight. */
  documentRevision?: number
  /** Verified facts / reference sets / recall read through it (never re-implemented). */
  contextState?: ContextState
  /** Preflight availability marker (opaque to the core). */
  unavailable?: { code: string; message: string }
}

/**
 * Read this capability's fragment out of the run's namespaced context
 * environment. Returns undefined when Navisworks contributed nothing (e.g. a
 * core-only run with no capability registered), which every source already
 * treats as "contribute no block" (§37/§49).
 */
export function getNavisworksContext(
  env: ContextSourceEnvironment,
): NavisworksContextFragment | undefined {
  return env.capabilities?.[NAVISWORKS_CAPABILITY_ID] as NavisworksContextFragment | undefined
}
