import type { CurrentDocumentContext, DocumentChangeNotice } from '../agent/contextState'
import type { SemanticMemory } from '../agent/semanticMemory'
import type { TaskVerificationFeedback } from '../agent/taskContext'
import type { CuriTask } from '../agent/taskTypes'
import type { ContextState } from '../agent/contextState'
import type { SkillManifestEntry } from '../skill/types'

/**
 * Context Engine v1 — the WHAT of context assembly (Invariant H):
 *   ContextEngine decides WHAT goes in (this module),
 *   ContextManager decides HOW MUCH fits under the token budget,
 *   AgentRuntime consumes the assembled result.
 * Main process only: the renderer never sees epochs, snapshots or
 * fingerprints (§51).
 */

export type ContextSourceMode = 'baseline' | 'durable' | 'volatile'

/**
 * Everything a source may read for one run. Built once per run by
 * AgentRuntime from the live environment (ContextState, task manager,
 * session fields). Sources must NEVER mutate what they read here.
 */
export interface ContextSourceEnvironment {
  readonly sessionId?: string
  /** Live document observation (ContextState.currentDocument). */
  readonly document?: CurrentDocumentContext
  /** Pending document-change notice for this session (unconsumed). */
  readonly documentNotice?: DocumentChangeNotice
  /** Document revision at preflight — the runtime advances seen-state after a successful run. */
  readonly documentRevision?: number
  /** Resumable active task for this session (undefined ⇒ none). */
  readonly activeTask?: CuriTask
  /** Latest verifier feedback folded into the task block. */
  readonly taskVerification?: TaskVerificationFeedback
  /** Session semantic memory, already updated with this run's user turn. */
  readonly semanticMemory?: SemanticMemory
  /** Durable compact summary of earlier (compacted) turns. */
  readonly compactSummary?: string
  /** Verified facts / reference sets / recall read through it (never re-implemented). */
  readonly contextState?: ContextState
  /** Resolve an externalized persisted tool result for runtime-internal recall. */
  readonly resolveToolResult?: (value: unknown) => Promise<unknown>
  /** P19: the discovered skill manifest source (name + description only). */
  readonly skillManifestProvider?: { manifest(): readonly SkillManifestEntry[] }
}

/**
 * A context source: identity + version (baseline churn), the semantic
 * fingerprint of its value, and the renderer. `value` must be SMALL and
 * serializable (§49) — never large tool results or transcripts.
 */
export interface ContextSource<T = unknown> {
  readonly key: string
  readonly version: number
  readonly mode: ContextSourceMode
  load(env: ContextSourceEnvironment): T | undefined | Promise<T | undefined>
  /** Stable semantic identity — no timestamps, no object-key order races (§48). */
  fingerprint(value: T): string
  /** The model-visible text for this value. Durable renders get the previous
   *  value so a change can be worded as a transition, not a rewrite. */
  render(value: T, previous?: T): string
}

/** Per-source reconciliation outcome inside one prepare(). */
export type ContextSourceReconcileStatus =
  | 'unchanged'
  | 'updated'
  | 'created'
  | 'skipped-empty'
  | 'error'

export interface ContextSourceReconciliation {
  key: string
  mode: ContextSourceMode
  status: ContextSourceReconcileStatus
  fingerprint?: string
  error?: string
}

export interface ContextEpochSeed {
  kind: 'compact-summary'
  text: string
}

export interface ContextSourceSnapshot {
  key: string
  sourceVersion: number
  fingerprint: string
  /** Small serializable value (e.g. document descriptor fields) — not large data. */
  value?: unknown
}

/**
 * An append-only durable context update already folded into the prefix.
 * Once an update exists it is NEVER rewritten — changes are new updates
 * (Invariant C). `rendered` is the exact model-visible text, so prefix bytes
 * can be re-emitted identically across turns and restarts.
 */
export interface ContextDurableUpdate {
  sequence: number
  sourceKey: string
  sourceVersion: number
  fingerprint: string
  text: string
  rendered: string
  createdAt: number
}

export interface ContextEpoch {
  version: 1
  sessionId: string
  epochId: string
  generation: number
  baseline: string
  baselineHash: string
  /** Baseline source versions the hash was computed for (rollover detection). */
  baselineVersions: Record<string, number>
  seed?: ContextEpochSeed
  snapshot: Record<string, ContextSourceSnapshot>
  updates: ContextDurableUpdate[]
  createdAt: number
  updatedAt: number
}

export type ContextReconcileStatus = 'unchanged' | 'updated' | 'rolled-over'

export interface ContextAssembly {
  sessionId: string
  baseline: string
  baselineHash: string
  prefixHash: string
  epochId: string
  generation: number
  updatesAdded: number
  status: ContextReconcileStatus
  seed?: ContextEpochSeed
  /** The reconciled working epoch to persist via ContextEngine.commit. */
  epoch: ContextEpoch
  /** Ordered [seed?, ...updates.rendered, ...volatile] as ContextManager blocks. */
  blocks: readonly import('../agent/contextManager').ContextBlock[]
  report: ContextEngineReport
}

export interface ContextEngineReport {
  epochId: string
  generation: number
  baselineHash: string
  prefixHash: string
  status: ContextReconcileStatus
  updatesAdded: number
  sources: readonly ContextSourceReconciliation[]
  baselineTokens: number
  epochSeedTokens: number
  durableUpdateTokens: number
  volatileTokens: number
}

/** The compact prepare() outcome for development logs (§24). */
export interface ContextPrepareSummary {
  status: ContextReconcileStatus
  sessionId: string
  epochId: string
  generation: number
  baselineHash: string
  updatesAdded: number
}
