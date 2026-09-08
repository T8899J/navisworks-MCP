import { renderCurrentDocumentContext, renderDocumentTransition } from '../../agent/contextState'
import type { DocumentChangeNotice } from '../../agent/contextState'
import { canonicalFingerprint } from '../contextHash'
import type { ContextSource, ContextSourceEnvironment } from '../types'
import { getNavisworksContext } from '../../navisworks/contextFragment'

/**
 * The durable document identity. `revision` and `changedAt` deliberately do
 * NOT enter the fingerprint (§18/§48): only semantic identity changes —
 * instance, bridge session, document instance, connected — create updates.
 */
export interface DocumentContextValue {
  connected: boolean
  instanceId?: string
  bridgeSessionId?: string
  documentInstanceId?: string
  documentName?: string
  /** Pending notice from ContextState (drives the transition wording). */
  transition?: DocumentChangeNotice
}

function documentFields(value: DocumentContextValue): Record<string, unknown> {
  return {
    connected: value.connected,
    instanceId: value.instanceId ?? null,
    bridgeSessionId: value.bridgeSessionId ?? null,
    documentInstanceId: value.documentInstanceId ?? null,
  }
}

export const documentSource: ContextSource<DocumentContextValue> = {
  key: 'navisworks/document',
  version: 1,
  mode: 'durable',
  load(env: ContextSourceEnvironment): DocumentContextValue | undefined {
    // P30.8: read the run's document + notice from THIS capability's namespaced
    // fragment, never a top-level core field.
    const navisworks = getNavisworksContext(env)
    const document = navisworks?.document
    if (document === undefined || navisworks === undefined) return undefined
    return {
      connected: document.connected,
      ...(document.instanceId === undefined ? {} : { instanceId: document.instanceId }),
      ...(document.bridgeSessionId === undefined ? {} : { bridgeSessionId: document.bridgeSessionId }),
      ...(document.documentInstanceId === undefined
        ? {}
        : { documentInstanceId: document.documentInstanceId }),
      ...(document.documentName === undefined ? {} : { documentName: document.documentName }),
      ...(navisworks.documentNotice === undefined ? {} : { transition: navisworks.documentNotice }),
    }
  },
  fingerprint(value) {
    return canonicalFingerprint(documentFields(value))
  },
  render(value, previous) {
    if (previous === undefined) {
      const block = renderCurrentDocumentContext({
        connected: value.connected,
        ...(value.instanceId === undefined ? {} : { instanceId: value.instanceId }),
        ...(value.bridgeSessionId === undefined ? {} : { bridgeSessionId: value.bridgeSessionId }),
        ...(value.documentInstanceId === undefined ? {} : { documentInstanceId: value.documentInstanceId }),
        ...(value.documentName === undefined ? {} : { documentName: value.documentName }),
      })
      // P15.5: body only — appendUpdate adds the single envelope.
      return block
    }
    // Identity changed: reuse the runtime's existing transition semantics —
    // never a second, diverging wording of the same event (§21).
    const notice: DocumentChangeNotice = value.transition ?? {
      revision: previous.transition?.revision ?? 0,
      ...(previous.documentInstanceId === undefined
        ? {}
        : { previous: {
            ...(previous.instanceId === undefined ? {} : { instanceId: previous.instanceId }),
            ...(previous.bridgeSessionId === undefined ? {} : { bridgeSessionId: previous.bridgeSessionId }),
            ...(previous.documentInstanceId === undefined ? {} : { documentInstanceId: previous.documentInstanceId }),
            ...(previous.documentName === undefined ? {} : { documentName: previous.documentName }),
          } }),
      ...(value.documentInstanceId === undefined
        ? {}
        : { current: {
            ...(value.instanceId === undefined ? {} : { instanceId: value.instanceId }),
            ...(value.bridgeSessionId === undefined ? {} : { bridgeSessionId: value.bridgeSessionId }),
            ...(value.documentInstanceId === undefined ? {} : { documentInstanceId: value.documentInstanceId }),
            ...(value.documentName === undefined ? {} : { documentName: value.documentName }),
          } }),
      changedAt: Date.now(),
      reason: value.connected ? 'document-changed' : 'document-closed',
    }
    // P15.5: body only — appendUpdate adds the single 【Context Update】 heading.
    return renderDocumentTransition(notice)
  },
}
