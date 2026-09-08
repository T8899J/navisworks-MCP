import { CapabilityRegistry } from '../capability/capabilityRegistry'
import type { CapabilityRunSet } from '../capability/types'
import type { AgentBridgeClient } from '../model/types'
import type { ContextState } from './contextState'
import type { DocumentOperationCoordinator, ToolExecutionLedger } from './executionLedger'
import { NavisworksCapabilityProvider, NAVISWORKS_CAPABILITY_ID } from '../navisworks/capability'
import type { NavisworksPreparedRun } from '../navisworks/capability'

/**
 * LEGACY ADAPTER (§41/§107): callers that still pass the flat navisworks deps
 * (bridgeClient/contextState/executionLedger/operationCoordinator) get a real
 * CapabilityRegistry assembled around the Navisworks capability HERE. This
 * lives outside agentRuntime.ts so the core runtime imports NO navisworks
 * symbol (§44/§99); the concrete-provider import is quarantined to this file.
 *
 * New hosts build the registry in the composition root and pass `capabilities`
 * directly; this adapter exists only to preserve the old constructor surface.
 */
export interface LegacyNavisworksDeps {
  bridgeClient: AgentBridgeClient
  contextState?: ContextState
  executionLedger?: ToolExecutionLedger
  operationCoordinator?: DocumentOperationCoordinator
  preparePreflight?: (input: { runId: string; sessionId?: string }) => Promise<NavisworksPreparedRun>
}

export function createLegacyNavisworksRegistry(deps: LegacyNavisworksDeps): CapabilityRegistry {
  return new CapabilityRegistry([
    new NavisworksCapabilityProvider({
      bridge: deps.bridgeClient,
      ...(deps.contextState === undefined ? {} : { contextState: deps.contextState }),
      ...(deps.executionLedger === undefined ? {} : { executionLedger: deps.executionLedger }),
      ...(deps.operationCoordinator === undefined ? {} : { operationCoordinator: deps.operationCoordinator }),
      ...(deps.preparePreflight === undefined ? {} : { preparePreflight: deps.preparePreflight }),
    }),
  ])
}

/** Empty run set for a host with no capabilities at all (§36 core-only). */
export function emptyCapabilityRunSet(): CapabilityRunSet {
  return new Map()
}

/** The @deprecated flat run fields (AgentRunInput.navisworksBinding /
 *  navisworksUnavailable / currentDocument), already shaped to the
 *  NavisworksPreparedRun keys. `binding` is the LOOSE identity subset the core
 *  run input carries; the executor reads only those identity fields and never
 *  the full NavisworksRunBinding (which is preflight-owned). */
export type LegacyNavisworksRunFields = Partial<Omit<NavisworksPreparedRun, 'binding'>> & {
  binding?: Partial<NonNullable<NavisworksPreparedRun['binding']>>
}

/**
 * LEGACY-ONLY (§24/§25/§26): fold a legacy run's flat Navisworks fields into
 * the NAVISWORKS capability's own prepared state and NOTHING ELSE. This is the
 * one place allowed to know the Navisworks capability id for the merge; the
 * AgentRuntime core never names a capability when building the run's state set.
 *
 * Production MUST NOT reach here with any field set — ChatRunRegistry stopped
 * generating the flat fields, so an all-empty `fields` returns the run set
 * untouched. Crucially, an empty `fields` is also a NO-OP even if the
 * production path ever regressed, so no other provider (FakeCapability, a
 * future Files/Web capability) can ever receive `binding` / `currentDocument`
 * / `unavailable` through it (§26/§27/§86).
 */
export function applyLegacyNavisworksRunState(
  capabilities: CapabilityRegistry | undefined,
  states: CapabilityRunSet,
  fields: LegacyNavisworksRunFields,
): CapabilityRunSet {
  const hasLegacyField = fields.binding !== undefined
    || fields.unavailable !== undefined
    || fields.currentDocument !== undefined
  if (!hasLegacyField) return states
  // Only a registry that actually carries the Navisworks capability can be
  // seeded from legacy fields; other providers are left exactly as prepared.
  if (capabilities === undefined || capabilities.get(NAVISWORKS_CAPABILITY_ID) === undefined) {
    return states
  }
  const existing = states.get(NAVISWORKS_CAPABILITY_ID)
  const next = new Map(states)
  next.set(NAVISWORKS_CAPABILITY_ID, {
    capabilityId: NAVISWORKS_CAPABILITY_ID,
    state: {
      ...((existing?.state as Record<string, unknown> | undefined) ?? {}),
      ...fields,
    },
  })
  return next
}
