import { describe, expect, it } from 'vitest'
import {
  DoomLoopGuard,
  resultFingerprint,
  toolCallSignature,
  type DoomLoopScope,
} from '../agent/doomLoopGuard'

const NO_SCOPE: DoomLoopScope = {
  instanceId: null,
  bridgeSessionId: null,
  documentInstanceId: null,
  documentRevision: null,
}

function sig(args: Record<string, unknown>, scope: DoomLoopScope = NO_SCOPE, toolName = 'navisworks_find_items') {
  return toolCallSignature({ toolName, normalizedArguments: args, scope })
}

describe('DoomLoopGuard state machine (§31/§87)', () => {
  it('a fresh signature executes; so does the SECOND identical call', () => {
    const guard = new DoomLoopGuard()
    const s = sig({ query: '支架' })
    expect(guard.beforeCall(s)).toEqual({ action: 'execute' })
    guard.recordResult(s, 'fp1')
    expect(guard.beforeCall(s)).toEqual({ action: 'execute' })
  })

  it('Case 1: identical args but DIFFERENT results → keeps executing (§120 live state)', () => {
    const guard = new DoomLoopGuard()
    const s = sig({})
    guard.recordResult(s, 'selection-A')
    guard.recordResult(s, 'selection-B')
    expect(guard.beforeCall(s)).toEqual({ action: 'execute' })
    guard.recordResult(s, 'selection-C')
    expect(guard.beforeCall(s)).toEqual({ action: 'execute' })
  })

  it('Case 2: third identical call with identical results → recover, NOT execute', () => {
    const guard = new DoomLoopGuard()
    const s = sig({ query: 'pump' })
    guard.recordResult(s, 'same')
    guard.recordResult(s, 'same')
    expect(guard.beforeCall(s)).toMatchObject({ action: 'recover' })
  })

  it('Case 3: model ignores the recovery and repeats → escalate', () => {
    const guard = new DoomLoopGuard()
    const s = sig({ query: 'pump' })
    guard.recordResult(s, 'same')
    guard.recordResult(s, 'same')
    expect(guard.beforeCall(s).action).toBe('recover')
    guard.recordRecovery(s)
    expect(guard.beforeCall(s).action).toBe('escalate')
  })

  it('Case 4: A.nwd → B.nwd with the same args is a NEW operation (§28)', () => {
    const guard = new DoomLoopGuard()
    const a = sig({ query: '支架' }, { ...NO_SCOPE, documentInstanceId: 'A' })
    guard.recordResult(a, 'same')
    guard.recordResult(a, 'same')
    expect(guard.beforeCall(a).action).toBe('recover')
    const b = sig({ query: '支架' }, { ...NO_SCOPE, documentInstanceId: 'B' })
    expect(guard.beforeCall(b)).toEqual({ action: 'execute' })
  })

  it('Case 5: reset() — the guard is run-scoped, never cross-turn memory (§36)', () => {
    const guard = new DoomLoopGuard()
    const s = sig({ query: 'x' })
    guard.recordResult(s, 'same')
    guard.recordResult(s, 'same')
    expect(guard.beforeCall(s).action).toBe('recover')
    guard.reset()
    expect(guard.beforeCall(s)).toEqual({ action: 'execute' })
  })

  it('user replan keeps the signature blocked (synthetic, never the bridge); stop arms terminate', () => {
    const guard = new DoomLoopGuard()
    const s = sig({ query: 'y' })
    guard.recordResult(s, 'same')
    guard.recordResult(s, 'same')
    guard.recordRecovery(s)
    expect(guard.beforeCall(s).action).toBe('escalate')
    guard.applyUserDecision(s, 'replan')
    // Blocked: no execution, no repeated question — recover-style synthetic.
    expect(guard.beforeCall(s)).toMatchObject({ action: 'recover' })
    guard.applyUserDecision(s, 'stop')
    expect(guard.beforeCall(s)).toMatchObject({ action: 'terminate' })
  })

  it('read_tool_result pagination is NOT a loop; identical pages are (§81)', () => {
    const guard = new DoomLoopGuard()
    const p0 = sig({ resultRef: 'tor_1', offset: 0, limit: 50 }, NO_SCOPE, 'read_tool_result')
    const p50 = sig({ resultRef: 'tor_1', offset: 50, limit: 50 }, NO_SCOPE, 'read_tool_result')
    expect(p0).not.toBe(p50)
    expect(guard.beforeCall(p0)).toEqual({ action: 'execute' })
    guard.recordResult(p0, 'page')
    guard.recordResult(p0, 'page')
    expect(guard.beforeCall(p0).action).toBe('recover')
  })
})

describe('signatures + result fingerprints (§27/§29/§88)', () => {
  it('signature excludes runId/toolCallId/timestamps: stable for equal semantics', () => {
    expect(sig({ query: 'a', limit: 10 })).toBe(sig({ limit: 10, query: 'a' }))
    expect(sig({ query: 'a' })).not.toBe(sig({ query: 'b' }))
  })

  it('§88: identical observations with different resultRef/createdAt/toolCallId fingerprint the SAME', () => {
    const one = resultFingerprint({
      status: 'success',
      tool: 'navisworks_find_items',
      result: { items: [{ id: 'i1', name: '支架' }], total: 1 },
      resultRef: 'tor_11111111-1111-1111-1111-111111111111',
      createdAt: 1,
      toolCallId: 'call-a',
    })
    const two = resultFingerprint({
      status: 'success',
      tool: 'navisworks_find_items',
      result: { items: [{ id: 'i1', name: '支架' }], total: 1 },
      resultRef: 'tor_22222222-2222-2222-2222-222222222222',
      createdAt: 999_999,
      toolCallId: 'call-z',
    })
    expect(one).toBe(two)
    // Different CONTENT fingerprints differently.
    const three = resultFingerprint({ status: 'success', result: { items: [{ id: 'i2' }], total: 1 } })
    expect(three).not.toBe(one)
  })

  it('document REVISION changes re-scope the signature (document switch = new operation)', () => {
    const r5 = sig({ query: 'x' }, { ...NO_SCOPE, documentRevision: 5 })
    const r6 = sig({ query: 'x' }, { ...NO_SCOPE, documentRevision: 6 })
    expect(r5).not.toBe(r6)
  })
})
