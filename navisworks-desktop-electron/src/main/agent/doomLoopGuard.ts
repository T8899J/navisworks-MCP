import { createHash } from 'node:crypto'
import { hashArguments } from './executionLedger'

/**
 * P18 Doom Loop Guard — a RUN-SCOPED runtime guard (§5/§36), never a prompt
 * instruction (§4). It detects the model re-issuing the exact same tool call
 * (same name + normalized args + document scope) whose previous results also
 * carried no new information, and escalates: synthetic recovery observation →
 * a user question → terminal stop. It runs fresh per user turn (reset), so a
 * legitimate cross-turn repeat (user re-selected in the UI) is never blocked.
 */

/** Concentrated threshold (§99): never scatter `>= 2` across files. */
export const DOOM_LOOP_REPEAT_THRESHOLD = 2

export interface DoomLoopScope {
  instanceId: string | null
  bridgeSessionId: string | null
  documentInstanceId: string | null
  documentRevision: number | null
}

export interface DoomLoopCall {
  toolName: string
  normalizedArguments: Record<string, unknown>
  scope: DoomLoopScope
}

export type DoomLoopDecision =
  | { action: 'execute' }
  | { action: 'recover'; repetition: number }
  | { action: 'escalate'; repetition: number }
  | { action: 'terminate'; repetition: number }

/** Keys that change every call but carry NO model-visible meaning (§29). */
const VOLATILE_RESULT_KEYS: ReadonlySet<string> = new Set([
  'resultRef',
  'createdAt',
  'updatedAt',
  'requestId',
  'toolCallId',
  'sourceToolCallId',
  'observedAt',
  'changedAt',
  'timestamp',
])

interface SignatureState {
  resultFingerprints: string[]
  recoveriesIssued: number
  userDecision?: 'replan' | 'stop'
}

/**
 * A canonical/stable call signature (§27). Excludes runId (the guard is already
 * keyed per-run), toolCallId, and any timestamp — those are random per call.
 */
export function toolCallSignature(call: DoomLoopCall): string {
  const canonical = canonicalStringify({
    toolName: call.toolName,
    // hashArguments is the same stable serializer the ledger/approval uses.
    arguments: stableArgs(call.normalizedArguments),
    instanceId: call.scope.instanceId,
    bridgeSessionId: call.scope.bridgeSessionId,
    documentInstanceId: call.scope.documentInstanceId,
    documentRevision: call.scope.documentRevision,
  })
  return sha256(canonical)
}

/**
 * A model-visible result fingerprint (§29): the observation content with every
 * per-call-random metadata key stripped, so equal RESULTS hash equal even when
 * resultRef / createdAt / toolCallId differ (§88).
 */
export function resultFingerprint(observation: unknown): string {
  return sha256(canonicalStringify(redactVolatile(observation)))
}

export class DoomLoopGuard {
  readonly #states = new Map<string, SignatureState>()

  /** Before a real tool call: execute / recover (synthetic) / escalate / terminate. */
  beforeCall(signature: string): DoomLoopDecision {
    const state = this.#states.get(signature)
    if (state === undefined) return { action: 'execute' }
    // User chose stop and the model still repeats → runtime safety terminates.
    if (state.userDecision === 'stop') {
      return { action: 'terminate', repetition: state.recoveriesIssued + 1 }
    }
    // User chose replan → the exact same signature stays blocked (§34).
    if (state.userDecision === 'replan') {
      return { action: 'escalate', repetition: state.recoveriesIssued + 1 }
    }
    // A recovery was already offered and the model ignored it → escalate.
    if (state.recoveriesIssued > 0) {
      return { action: 'escalate', repetition: state.resultFingerprints.length + state.recoveriesIssued }
    }
    // Enough identical (tool+args+scope) calls whose results carried no new
    // information → recover instead of hitting the bridge a third time.
    if (this.#isRepeatingUninformatively(state)) {
      return { action: 'recover', repetition: state.resultFingerprints.length }
    }
    return { action: 'execute' }
  }

  /** Record the real result a call produced (only after ACTUAL execution). */
  recordResult(signature: string, fingerprint: string): void {
    const state = this.#states.get(signature) ?? { resultFingerprints: [], recoveriesIssued: 0 }
    state.resultFingerprints.push(fingerprint)
    this.#states.set(signature, state)
  }

  /** A synthetic recovery was surfaced to the model (no real call happened). */
  recordRecovery(signature: string): void {
    const state = this.#states.get(signature) ?? { resultFingerprints: [], recoveriesIssued: 0 }
    state.recoveriesIssued += 1
    this.#states.set(signature, state)
  }

  /**
   * The user answered an escalation: 'replan' keeps the signature blocked until
   * tool/args/scope change; 'stop' arms termination on the next repeat (§34).
   */
  applyUserDecision(signature: string, decision: 'replan' | 'stop'): void {
    const state = this.#states.get(signature) ?? { resultFingerprints: [], recoveriesIssued: 0 }
    state.userDecision = decision
    this.#states.set(signature, state)
  }

  reset(): void {
    this.#states.clear()
  }

  #isRepeatingUninformatively(state: SignatureState): boolean {
    const seen = state.resultFingerprints
    if (seen.length < DOOM_LOOP_REPEAT_THRESHOLD) return false
    // Every recorded result so far hashed the same → no new information.
    return seen.every((fingerprint) => fingerprint === seen[0])
  }
}

function stableArgs(args: Record<string, unknown>): string {
  // hashArguments is already a stable, key-sorted serializer.
  return hashArguments(args)
}

function redactVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactVolatile)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_RESULT_KEYS.has(key)) continue
      out[key] = redactVolatile(entry)
    }
    return out
  }
  return value
}

function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalStringify(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
