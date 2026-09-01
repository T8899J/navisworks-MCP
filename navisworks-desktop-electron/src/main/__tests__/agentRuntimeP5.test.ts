import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, type AgentBridgeClient } from '../agentRuntime'
import { BridgeError } from '../bridgeClient'
import { ContextState } from '../agent/contextState'
import { DocumentOperationCoordinator, ToolExecutionLedger } from '../agent/executionLedger'

function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  return new Response(chunks.map((c) => `${JSON.stringify(c)}\n`).join(''), {
    status: 200, headers: { 'content-type': 'application/x-ndjson' },
  })
}
const visibilityCall = () => ndjsonResponse([{
  message: { role: 'assistant', content: '', tool_calls: [
    { id: 'mod-1', function: { index: 0, name: 'navisworks_set_visibility', arguments: { action: 'reset' } } },
  ] },
  prompt_eval_count: 10, eval_count: 0,
}])
const finalText = (t: string) => ndjsonResponse([{ message: { role: 'assistant', content: t }, prompt_eval_count: 20, eval_count: 1 }])

describe('P5 — modifying-call safety gates at execution', () => {
  it('cancels a view-state change when the document changed during approval (Invariant B)', async () => {
    const contextState = new ContextState()
    contextState.observe({ documentInstanceId: 'doc-A' })
    const ledger = new ToolExecutionLedger()
    const bridgeCalls: string[] = []
    const bridge: AgentBridgeClient = {
      async call<T>(method: string) { bridgeCalls.push(method); return { ok: true } as T },
    }
    let turn = 0
    const fetchImpl = vi.fn(async () => { turn += 1; return turn === 1 ? visibilityCall() : finalText('已取消。') }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      bridgeClient: bridge, fetchImpl, contextState, executionLedger: ledger,
      operationCoordinator: new DocumentOperationCoordinator(),
    })
    await runtime.run({ runId: 'run-doc-change', text: '重置可见性' }, {
      // Approving the call, but the user switches documents at that exact moment.
      requestToolApproval: async () => {
        contextState.observe({ documentInstanceId: 'doc-B' })
        return true
      },
    })
    expect(bridgeCalls).not.toContain('navisworks_set_visibility')
    expect(ledger.get('run-doc-change', 'mod-1')?.status).toBe('cancelled')
    expect(ledger.get('run-doc-change', 'mod-1')?.errorCode).toBe('DOCUMENT_CHANGED')
  })

  it('rechecks the approved document after waiting for the per-document execution lock', async () => {
    const contextState = new ContextState()
    contextState.observe({ documentInstanceId: 'doc-A' })
    const ledger = new ToolExecutionLedger()
    const coordinator = new DocumentOperationCoordinator()
    let releaseBlocker: () => void = () => undefined
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve })
    let markBlocked: () => void = () => undefined
    const blockerStarted = new Promise<void>((resolve) => { markBlocked = resolve })
    const blocker = coordinator.runExclusive('doc-A', async () => {
      markBlocked()
      await blockerGate
    })
    await blockerStarted

    let bridgeCalls = 0
    const bridge: AgentBridgeClient = { async call<T>() { bridgeCalls += 1; return { ok: true } as T } }
    let turn = 0
    const fetchImpl = vi.fn(async () => { turn += 1; return turn === 1 ? visibilityCall() : finalText('已取消。') }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      bridgeClient: bridge, fetchImpl, contextState, executionLedger: ledger,
      operationCoordinator: coordinator,
    })
    let signalApproved: () => void = () => undefined
    const approved = new Promise<void>((resolve) => { signalApproved = resolve })
    const run = runtime.run({ runId: 'run-queued-doc-change', text: '重置可见性' }, {
      requestToolApproval: async () => { signalApproved(); return true },
    })
    await approved
    contextState.observe({ documentInstanceId: 'doc-B' })
    releaseBlocker()
    await Promise.all([blocker, run])

    expect(bridgeCalls).toBe(0)
    expect(ledger.get('run-queued-doc-change', 'mod-1')).toMatchObject({
      status: 'cancelled', errorCode: 'DOCUMENT_CHANGED',
    })
  })

  it('records an ambiguous bridge outcome as ambiguous, never auto-retried (Invariant F)', async () => {
    const contextState = new ContextState()
    contextState.observe({ documentInstanceId: 'doc-A' })
    const ledger = new ToolExecutionLedger()
    const bridgeCalls: string[] = []
    const bridge: AgentBridgeClient = {
      async call<T>(method: string) {
        bridgeCalls.push(method)
        throw new BridgeError('BRIDGE_IO', '写入超时，结果不确定', { ambiguousOutcome: true })
      },
    }
    let turn = 0
    const fetchImpl = vi.fn(async () => { turn += 1; return turn === 1 ? visibilityCall() : finalText('结果不确定。') }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      bridgeClient: bridge, fetchImpl, contextState, executionLedger: ledger,
      operationCoordinator: new DocumentOperationCoordinator(),
    })
    await runtime.run({ runId: 'run-ambiguous', text: '重置可见性' }, { requestToolApproval: async () => true })
    // It attempted the call once, then marked ambiguous (no second same-doc attempt).
    expect(bridgeCalls.filter((m) => m === 'navisworks_set_visibility')).toHaveLength(1)
    expect(ledger.get('run-ambiguous', 'mod-1')?.status).toBe('ambiguous')
  })

  it('blocks the same ambiguous modification across runs until the user explicitly retries', async () => {
    const contextState = new ContextState()
    contextState.observe({ documentInstanceId: 'doc-A' })
    const ledger = new ToolExecutionLedger()
    let bridgeCalls = 0
    const bridge: AgentBridgeClient = {
      async call<T>() {
        bridgeCalls += 1
        if (bridgeCalls === 1) {
          throw new BridgeError('BRIDGE_IO', '写入超时，结果不确定', { ambiguousOutcome: true })
        }
        return { reset: true } as T
      },
    }
    let modelCalls = 0
    const fetchImpl = vi.fn(async () => {
      modelCalls += 1
      return modelCalls % 2 === 1 ? visibilityCall() : finalText('完成。')
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      bridgeClient: bridge, fetchImpl, contextState, executionLedger: ledger,
      operationCoordinator: new DocumentOperationCoordinator(),
    })
    let approvals = 0
    const approve = async () => { approvals += 1; return true }

    await runtime.run({ runId: 'ambiguous-1', text: '重置可见性' }, { requestToolApproval: approve })
    await runtime.run({ runId: 'ambiguous-2', text: '重置可见性' }, { requestToolApproval: approve })
    expect(bridgeCalls).toBe(1)
    expect(approvals).toBe(1)

    await runtime.run({ runId: 'ambiguous-3', text: '确认仍然执行一次' }, { requestToolApproval: approve })
    expect(bridgeCalls).toBe(2)
    expect(approvals).toBe(2)
    expect(ledger.get('ambiguous-1', 'mod-1')?.status).toBe('resolved')
    expect(ledger.get('ambiguous-3', 'mod-1')?.status).toBe('success')
  })

  it('runs a normal approved view-state change and records success', async () => {
    const contextState = new ContextState()
    contextState.observe({ documentInstanceId: 'doc-A' })
    const ledger = new ToolExecutionLedger()
    let calls = 0
    const bridge: AgentBridgeClient = { async call<T>() { calls += 1; return { reset: true } as T } }
    let turn = 0
    const fetchImpl = vi.fn(async () => { turn += 1; return turn === 1 ? visibilityCall() : finalText('已重置。') }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      bridgeClient: bridge, fetchImpl, contextState, executionLedger: ledger,
      operationCoordinator: new DocumentOperationCoordinator(),
    })
    await runtime.run({ runId: 'run-success', text: '重置可见性' }, { requestToolApproval: async () => true })
    expect(calls).toBe(1)
    expect(ledger.get('run-success', 'mod-1')?.status).toBe('success')
  })
})
