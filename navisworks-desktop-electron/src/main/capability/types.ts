import type { AgentToolDefinition } from '../tool/registry'
import type { AgentToolName } from '../toolCatalog'
import type { ContextSource } from '../context/types'
import type { CurrentDocumentContext, DocumentChangeNotice } from '../agent/contextState'
import type { ToolPermission } from '../../shared/ipc'

/**
 * Capability Architecture v1 (P21).
 *
 * A Capability Provider is NOT an agent: it never plans, never calls a
 * model, never talks to the user. It answers exactly one question —
 * "what can Curi actually DO in this environment, and how" — by contributing
 * tools, context sources and execution. The Agent Runtime owns WHY
 * (reasoning, planning, permission, approval, doom loop, questions, skills);
 * the Provider owns HOW (transport, binding, safety guards, state ingest).
 *
 * Do not confuse with ModelProvider ("who thinks"): a CapabilityProvider is
 * "which real-world environment Curi can operate".
 */

export interface CapabilityManifest {
  /** Stable ids, e.g. 'navisworks'. Registered identity, never a runtime status. */
  id: string
  name: string
  description: string
  version: number
  firstParty: boolean
}

/**
 * Where one tool definition came from. `category` on the definition remains
 * ONLY as deprecated display compatibility (§23); every runtime decision
 * (routing, UI visibility, ingest) must read `origin`.
 */
export type ToolOrigin =
  | { kind: 'internal' }
  | { kind: 'capability'; capabilityId: string }

/** Provider-neutral run preparation input (§11): no document/selection/viewpoint concepts. */
export interface CapabilityRunPrepareInput {
  runId: string
  sessionId?: string
  signal?: AbortSignal
}

/**
 * Provider-private, RUN-SCOPED state (e.g. Navisworks' binding + current
 * document + unavailable marker). The runtime stores and returns it OPAQUELY
 * (§13) — it must never interpret it, never persist it, never send it over
 * IPC or into a Context Epoch (§12/§43).
 */
export interface CapabilityPreparedRun {
  capabilityId: string
  state: unknown
}

/** Generic approval scope; Navisworks fills document/instance-flavoured ids. */
export interface CapabilityApprovalScope {
  id?: string
  label?: string
}

export interface CapabilityApprovalRequest {
  runId: string
  toolCallId: string
  toolName: AgentToolName
  arguments: Record<string, unknown>
  argumentsHash: string
  capabilityId?: string
  scope?: CapabilityApprovalScope
  /** @deprecated Navisworks-specific fields kept for the current renderer card. */
  instanceId?: string
  bridgeSessionId?: string
  documentInstanceId?: string
  ambiguousRetry?: boolean
}

export type CapabilityApprovalGate = (request: CapabilityApprovalRequest) => Promise<boolean>

export interface CapabilityToolExecutionInput {
  runId: string
  sessionId?: string
  toolCallId: string
  /** The run's message id, surfaced on approval cards. */
  messageId?: string
  toolName: AgentToolName
  /** Registry-normalized arguments (the core owns normalization via the owning provider). */
  arguments: Record<string, unknown>
  permission: ToolPermission
  signal?: AbortSignal
  /** The core's approval gate — the provider requests approval mid-flow; it never bypasses it (§49). */
  requestApproval?: CapabilityApprovalGate
  allowAmbiguousRetry: boolean
  /** Opaque state this provider returned from prepareRun for this run. */
  state: unknown
}

  /** Unified tool execution outcome (§53): providers translate transport errors themselves. */
export interface CapabilityToolExecutionResult {
  result?: unknown
  error?: {
    code: string
    message: string
    ambiguousOutcome?: boolean
    /** The capability signals a run-level abort (e.g. bound instance gone);
     *  the core terminates the run with this code, never interprets the cause. */
    runTerminating?: boolean
  }
}


/** Post-bounding observation hook: the provider may mine the MODEL-VISIBLE
 *  (possibly bounded) result into its own professional state (§57). */
export interface CapabilityToolObservation {
  toolName: AgentToolName
  result: unknown
  toolCallId: string
  sessionId?: string
}

/**
 * Doom-loop scoping, OPAQUE by design: a provider contributes its stable
 * operation scope as scalar fields (Navisworks: instance / bridge session /
 * document instance / revision) that the core hashes into the signature
 * WITHOUT interpreting their meaning (§27/§44 — the core must never name
 * capability-specific fields).
 */
export type CapabilityExecutionScope = Readonly<Record<string, string | number | null>>

/**
 * The provider contract (§9). Every member exists to serve exactly two
 * consumers: the real Navisworks capability and the fake test capability
 * (§96) — nothing more is abstracted ahead of need.
 */
export interface CapabilityProvider {
  readonly manifest: CapabilityManifest

  /** Tool definitions contributed to the single ToolRegistry (§24). Stable order. */
  tools(): readonly AgentToolDefinition[]

  /** Context sources contributed to the composed ContextRegistry. Stable order. */
  contextSources(): readonly ContextSource<unknown>[]

  ownsTool(toolName: string): boolean

  /** Argument normalization owned by the provider that defines the schema. */
  normalizeArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown>

  /** Run preflight (binding, current environment). Absent → nothing to prepare. */
  prepareRun?(input: CapabilityRunPrepareInput): Promise<CapabilityPreparedRun>

  /** The stable operation scope used by the core's doom-loop signature (§28).
   *  Absent → the call is scoped only by tool + arguments. */
  executionScope?(state: unknown): CapabilityExecutionScope

  /**
   * Environment fragments this provider injects into the run's context
   * environment so its OWN context sources can read their professional state
   * (document snapshot, notice, revision) without the core importing it.
   * Later providers must not overwrite earlier keys (first-wins per key).
   */
  contributeContext?(state: unknown, ctx: { sessionId?: string }): CapabilityContextFragment

  executeTool(input: CapabilityToolExecutionInput): Promise<CapabilityToolExecutionResult>

  /** Optional post-bounding ingest into provider state (e.g. facts / reference sets). */
  observeModelResult?(observation: CapabilityToolObservation): void

  /** Own lifecycle: the provider starts/stops its own background work (§17/§18). */
  start?(): Promise<void> | void
  dispose?(): Promise<void> | void
}

/** The main-process run facade's opaque capability bundle (never crosses IPC). */
export type CapabilityRunSet = ReadonlyMap<string, CapabilityPreparedRun>

/**
 * Optional fragment a provider injects into the run's context environment
 * (document snapshot, notice, revision, and — where the capability keeps one
 * — its professional state handle). Keys are consumed by that capability's
 * OWN context sources; the core passes them through untouched.
 */
export type CapabilityContextFragment = Record<string, unknown>
