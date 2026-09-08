import {
  createNavisworksRunBinding,
} from './runBinding'
import type { NavisworksInstanceRegistry } from './instanceRegistry'
import type { NavisworksInstanceSelection } from './instanceSelection'
import type { NavisworksBridgeClient } from '../bridgeClient'
import type { NavisworksStatus } from '../../shared/ipc'
import type { ContextState, CurrentDocumentContext } from '../agent/contextState'
import type { NavisworksPreparedRun } from './capability'
import type { CapabilityRunPrepareInput } from '../capability/types'

/**
 * P30.3: the ONE production Navisworks run preflight, owned by the Navisworks
 * Capability. This used to live inline in `ChatRunRegistry.#execute()` — the
 * core chat runtime had no business knowing about Navisworks instances,
 * bindings or document revisions (Invariant B/§22). The preflight answers a
 * single question for one run: what Navisworks environment is this run bound
 * to, and is it usable right now?
 *
 * It returns ONLY the provider-private `NavisworksPreparedRun` (opaque to the
 * core, §12/§13): the run binding, the current-document snapshot, the pending
 * document revision marker, and — when the target is gone — the `unavailable`
 * descriptor that a later Navisworks tool call turns into TARGET_INSTANCE_
 * DISCONNECTED. It never fails a chat run: an offline target is STATE, not a
 * thrown error (§64 — registered ≠ available).
 */
export interface NavisworksRunPreflightDeps {
  instanceRegistry: NavisworksInstanceRegistry
  instanceSelection: NavisworksInstanceSelection
  bridge: NavisworksBridgeClient
  contextState?: ContextState
}

export class NavisworksRunPreflight {
  readonly #deps: NavisworksRunPreflightDeps

  constructor(deps: NavisworksRunPreflightDeps) {
    this.#deps = deps
  }

  async prepare(input: CapabilityRunPrepareInput): Promise<NavisworksPreparedRun> {
    const { instanceRegistry, instanceSelection, bridge, contextState } = this.#deps
    const signal = input.signal
    const prepared: NavisworksPreparedRun = {}
    const instances = await instanceRegistry.refresh()
    instanceSelection.observe(instances)
    const selectedInstanceId = instanceSelection.selectedInstanceId
    const selected = selectedInstanceId === undefined
      ? undefined
      : instanceRegistry.get(selectedInstanceId)
    if (selected === undefined || !selected.connected) {
      prepared.unavailable = {
        code: 'TARGET_INSTANCE_DISCONNECTED',
        // UI/user-selection prerequisite: the model cannot fix this by
        // retrying tools; the user must pick an instance from the menu.
        message: selectedInstanceId === undefined
          ? '当前没有选择 Navisworks 实例，请先选择一个实例。'
          : '之前选择的 Navisworks 已断开，请从实例菜单重新选择一个可用实例。',
      }
      contextState?.observe({ connected: false })
    } else {
      const binding = await createNavisworksRunBinding(selected, bridge, { signal })
      prepared.binding = binding
      contextState?.observe({
        connected: true,
        instanceId: binding.instanceId,
        bridgeSessionId: binding.bridgeSessionId,
        ...(binding.documentInstanceId === undefined
          ? {}
          : { documentInstanceId: binding.documentInstanceId }),
        ...(binding.documentName === undefined
          ? {}
          : { documentName: binding.documentName }),
      })
    }
    // The document identity ContextState settled on THIS preflight is the run's
    // stable snapshot; the pending revision is what a successful run will mark
    // seen (P30.5 finishRun). Both are Navisworks professional state only.
    prepared.currentDocument = contextState?.currentDocument
    prepared.observedDocumentRevision = contextState?.documentRevision
    return prepared
  }
}

/**
 * The legacy single-bridge preflight (no multi-instance discovery): the
 * production hosts that never wire an instance registry still feed the SAME
 * ContextState and produce a `NavisworksPreparedRun`, so the capability path
 * is uniform. `readStatus` is injected so ChatRunRegistry (which already owns
 * the bridge) can pass its existing status reader without importing bindings.
 */
export async function legacyStatusPreflight(
  readStatus: () => Promise<NavisworksStatus>,
  contextState: ContextState | undefined,
): Promise<NavisworksPreparedRun> {
  let status: NavisworksStatus
  try {
    status = await readStatus()
  } catch {
    status = { connected: false, status: 'Navisworks 未连接' }
  }
  contextState?.observe(status)
  const currentDocument: CurrentDocumentContext | undefined = contextState?.currentDocument
  return {
    ...(currentDocument === undefined ? {} : { currentDocument }),
    ...(contextState === undefined ? {} : { observedDocumentRevision: contextState.documentRevision }),
  }
}
