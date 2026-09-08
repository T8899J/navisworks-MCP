import { CapabilityRegistry } from '../capability/capabilityRegistry'
import type { CapabilityRunSet } from '../capability/types'
import type { AgentBridgeClient } from '../model/types'
import type { ContextState } from './contextState'
import type { DocumentOperationCoordinator, ToolExecutionLedger } from './executionLedger'
import { NavisworksCapabilityProvider } from '../navisworks/capability'
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
