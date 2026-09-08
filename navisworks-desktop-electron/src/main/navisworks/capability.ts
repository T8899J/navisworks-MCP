import type { ContextState, CurrentDocumentContext } from '../agent/contextState'
import type { DocumentOperationCoordinator, ToolExecutionLedger } from '../agent/executionLedger'
import type { AgentBridgeClient } from '../model/types'
import type { NavisworksBridgeClient } from '../bridgeClient'
import type { NavisworksRunBinding } from './instanceTypes'
import { toolCatalog } from '../toolCatalog'
import type { AgentToolDefinition } from '../tool/registry'
import type { ContextSource } from '../context/types'
import { navisworksPolicySource } from '../context/sources/navisworksPolicySource'
import { documentSource } from '../context/sources/documentSource'
import { verifiedFactsSource } from '../context/sources/verifiedFactsSource'
import { referenceSetSource } from '../context/sources/referenceSetSource'
import { recallSource } from '../context/sources/recallSource'
import { navisworksToolDefinitions, NAVISWORKS_TOOL_NAMES } from './toolDefinitions'
import { runNavisworksTool } from './toolExecutor'
import type {
  CapabilityExecutionScope,
  CapabilityManifest,
  CapabilityPreparedRun,
  CapabilityProvider,
  CapabilityRunPrepareInput,
  CapabilityToolExecutionInput,
  CapabilityToolExecutionResult,
} from '../capability/types'

/**
 * P25: Navisworks is a FIRST-PARTY Capability Provider, not Curi Core. It owns
 * the professional execution for the nine navisworks_* tools: bridge transport,
 * run binding, document change guard, execution ledger, per-document operation
 * serialization, ambiguous-outcome protection and ContextState ingest. The
 * Agent Runtime reaches it ONLY through the CapabilityRegistry by tool name
 * (§98); the core imports no navisworks symbol (§44/§99).
 */

export const NAVISWORKS_CAPABILITY_ID = 'navisworks'

export const NAVISWORKS_MANIFEST: CapabilityManifest = {
  id: NAVISWORKS_CAPABILITY_ID,
  name: 'Navisworks',
  description: '读取、分析并操作 Autodesk Navisworks 当前运行环境。',
  version: 1,
  firstParty: true,
}

const NAVISWORKS_TOOL_SET: ReadonlySet<string> = new Set<string>(NAVISWORKS_TOOL_NAMES)
const NAVISWORKS_MODIFYING: ReadonlySet<string> = new Set(
  navisworksToolDefinitions()
    .filter((entry) => entry.impact === 'view-state-change')
    .map((entry) => entry.name),
)

/** Provider-private, run-scoped state (opaque to the core, §12/§13). */
export interface NavisworksPreparedRun {
  binding?: NavisworksRunBinding
  currentDocument?: CurrentDocumentContext
  unavailable?: { code: 'TARGET_INSTANCE_DISCONNECTED'; message: string }
  observedDocumentRevision?: number
}

export type NavisworksBridge = AgentBridgeClient & Partial<Pick<NavisworksBridgeClient, 'callToEndpoint'>>

export interface NavisworksCapabilityDeps {
  bridge: NavisworksBridge
  contextState?: ContextState
  executionLedger?: ToolExecutionLedger
  operationCoordinator?: DocumentOperationCoordinator
  /** Owns polling lifecycle (§18): start returns a disposer, dispose stops it. */
  startPolling?: () => () => void
  /** Run preflight → binding + environment snapshot; production supplies this (§40). */
  preparePreflight?: (input: CapabilityRunPrepareInput) => Promise<NavisworksPreparedRun>
}

export class NavisworksCapabilityProvider implements CapabilityProvider {
  readonly manifest = NAVISWORKS_MANIFEST
  readonly #deps: NavisworksCapabilityDeps
  readonly #definitions: readonly AgentToolDefinition[]
  #stopPolling: (() => void) | undefined

  constructor(deps: NavisworksCapabilityDeps) {
    this.#deps = deps
    this.#definitions = navisworksToolDefinitions().map((entry) => ({
      name: entry.name,
      label: entry.label,
      description: entry.description,
      parameters: entry.parameters,
      category: 'navisworks' as const,
      origin: { kind: 'capability', capabilityId: NAVISWORKS_CAPABILITY_ID },
      impact: entry.impact,
      defaultPermission: entry.defaultPermission,
      contract: entry.contract,
    }))
  }

  tools(): readonly AgentToolDefinition[] {
    return this.#definitions
  }

  /** §24/§67: the Navisworks policy baseline + document/facts/refset/recall. */
  contextSources(): readonly ContextSource<unknown>[] {
    return [navisworksPolicySource, documentSource, verifiedFactsSource, referenceSetSource, recallSource]
  }

  ownsTool(toolName: string): boolean {
    return NAVISWORKS_TOOL_SET.has(toolName)
  }

  normalizeArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
    return toolCatalog.normalizeArguments(name, args)
  }

  async prepareRun(input: CapabilityRunPrepareInput): Promise<CapabilityPreparedRun> {
    const state: NavisworksPreparedRun = this.#deps.preparePreflight
      ? await this.#deps.preparePreflight(input)
      : {}
    return { capabilityId: NAVISWORKS_CAPABILITY_ID, state }
  }

  executionScope(state: unknown): CapabilityExecutionScope {
    const prepared = state as NavisworksPreparedRun
    return {
      instanceId: prepared.binding?.instanceId ?? this.#deps.contextState?.instanceId ?? null,
      bridgeSessionId: prepared.binding?.bridgeSessionId ?? null,
      documentInstanceId: prepared.binding?.documentInstanceId
        ?? this.#deps.contextState?.documentInstanceId ?? null,
      documentRevision: this.#deps.contextState?.documentRevision ?? null,
    }
  }

  /** The professional safety ladder lives in the executor (§48). */
  executeTool(input: CapabilityToolExecutionInput): Promise<CapabilityToolExecutionResult> {
    return runNavisworksTool(
      {
        bridge: this.#deps.bridge,
        ...(this.#deps.contextState === undefined ? {} : { contextState: this.#deps.contextState }),
        ...(this.#deps.executionLedger === undefined ? {} : { executionLedger: this.#deps.executionLedger }),
        ...(this.#deps.operationCoordinator === undefined ? {} : { operationCoordinator: this.#deps.operationCoordinator }),
      },
      NAVISWORKS_MODIFYING,
      input,
    )
  }

  /**
   * Inject this capability's professional state into the run's context
   * environment: the CURRENT document + pending notice + ContextState handle
   * (read by this capability's OWN sources) — the core passes it through
   * without interpreting it.
   */
  contributeContext(
    state: unknown,
    ctx: { sessionId?: string },
  ): Record<string, unknown> {
    const prepared = state as NavisworksPreparedRun
    const contextState = this.#deps.contextState
    return {
      ...(prepared.currentDocument === undefined
        ? {}
        : { document: prepared.currentDocument }),
      ...(prepared.unavailable === undefined
        ? {}
        : { unavailable: prepared.unavailable }),
      ...(ctx.sessionId === undefined || contextState === undefined
        ? {}
        : { documentNotice: contextState.documentNoticeForSession(ctx.sessionId) }),
      ...(contextState === undefined
        ? {}
        : {
          contextState,
          documentRevision: contextState.documentRevision,
          observedDocumentRevision: contextState.documentRevision,
        }),
    }
  }

  /** §48/§57: mine the model-visible (post-bounding) result into ContextState. */
  observeModelResult(observation: {
    toolName: string
    result: unknown
    toolCallId: string
    sessionId?: string
  }): void {
    this.#deps.contextState?.ingestToolResult(
      observation.toolName,
      observation.result,
      observation.toolCallId,
      observation.sessionId,
    )
  }

  start(): void {
    if (this.#stopPolling !== undefined || this.#deps.startPolling === undefined) return
    this.#stopPolling = this.#deps.startPolling()
  }

  dispose(): void {
    this.#stopPolling?.()
    this.#stopPolling = undefined
  }
}
