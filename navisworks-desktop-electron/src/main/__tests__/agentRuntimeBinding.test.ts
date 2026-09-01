import { describe, expect, it, vi } from 'vitest'

import { AgentRuntime, type AgentBridgeClient, type ToolApprovalRequest } from '../agentRuntime'
import { ContextState } from '../agent/contextState'
import { DocumentOperationCoordinator, ToolExecutionLedger } from '../agent/executionLedger'
import type { NavisworksRunBinding } from '../navisworks/instanceTypes'

function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  return new Response(chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

describe('AgentRuntime Navisworks Run binding', () => {
  it('uses only the bound A endpoint for the whole tool round', async () => {
    const pipes: string[] = []
    const legacyCall = vi.fn(async () => { throw new Error('legacy discovery must not run') })
    const bridge = {
      call: legacyCall,
      async callToEndpoint<T>(endpoint: { PipeName: string }, method: string): Promise<T> {
        pipes.push(endpoint.PipeName)
        if (method === 'navisworks_status') {
          return { connected: true, bridgeSessionId: 'bridge-a', documentInstanceId: 'doc-a' } as T
        }
        return { items: [{ id: 'a-1' }] } as T
      },
    } as AgentBridgeClient & { callToEndpoint: Function }
    let completion = 0
    const fetchImpl = vi.fn(async () => {
      completion += 1
      if (completion === 1) {
        return ndjsonResponse([{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'c1', function: { index: 0, name: 'navisworks_find_items', arguments: { query: 'x' } } },
        ] } }])
      }
      return ndjsonResponse([{ message: { role: 'assistant', content: '完成。' } }])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    const result = await runtime.run({ text: '查询', navisworksBinding: bindingA() })

    expect(result.isSuccess).toBe(true)
    expect(legacyCall).not.toHaveBeenCalled()
    expect(pipes).toEqual(['pipe-a', 'pipe-a'])
  })

  it('terminates the run when the bound instance disconnects', async () => {
    const bridge = {
      async call() { throw new Error('legacy discovery must not run') },
      async callToEndpoint() { throw new Error('pipe closed') },
    } as AgentBridgeClient & { callToEndpoint: Function }
    const fetchImpl = vi.fn(async () => ndjsonResponse([{ message: {
      role: 'assistant', content: '', tool_calls: [
        { id: 'c1', function: { index: 0, name: 'navisworks_find_items', arguments: { query: 'x' } } },
      ],
    } }])) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    const result = await runtime.run({ text: '查询', navisworksBinding: bindingA() })

    expect(result).toMatchObject({
      isSuccess: false,
      errorCode: 'TARGET_INSTANCE_DISCONNECTED',
    })
  })

  it('allows ordinary chat without a target but blocks any Navisworks tool call', async () => {
    const bridge: AgentBridgeClient = {
      async call() { throw new Error('bridge must not be used without an explicit target') },
    }
    const unavailable = {
      code: 'TARGET_INSTANCE_DISCONNECTED' as const,
      message: '请选择要使用的 Navisworks 实例。',
    }
    const chatRuntime = new AgentRuntime({
      bridgeClient: bridge,
      fetchImpl: vi.fn(async () => ndjsonResponse([
        { message: { role: 'assistant', content: '你好。' } },
      ])) as unknown as typeof fetch,
    })
    await expect(chatRuntime.run({ text: '你好', navisworksUnavailable: unavailable }))
      .resolves.toMatchObject({ isSuccess: true, message: '你好。' })

    const toolRuntime = new AgentRuntime({
      bridgeClient: bridge,
      fetchImpl: vi.fn(async () => ndjsonResponse([{ message: {
        role: 'assistant', content: '', tool_calls: [
          { id: 'c1', function: { index: 0, name: 'navisworks_status', arguments: {} } },
        ],
      } }])) as unknown as typeof fetch,
    })
    await expect(toolRuntime.run({ text: '查看状态', navisworksUnavailable: unavailable }))
      .resolves.toMatchObject({ isSuccess: false, errorCode: 'TARGET_INSTANCE_DISCONNECTED' })
  })

  it('keeps an approved modifying call on A when the UI selection context changes to B', async () => {
    const contextState = new ContextState()
    contextState.observe({
      connected: true, instanceId: 'bridge-a', bridgeSessionId: 'bridge-a',
      documentInstanceId: 'doc-a',
    })
    const ledger = new ToolExecutionLedger()
    const methods: string[] = []
    const bridge = {
      async call() { throw new Error('legacy discovery must not run') },
      async callToEndpoint<T>(endpoint: { PipeName: string }, method: string): Promise<T> {
        expect(endpoint.PipeName).toBe('pipe-a')
        methods.push(method)
        if (method === 'navisworks_status') {
          return { connected: true, bridgeSessionId: 'bridge-a', documentInstanceId: 'doc-a' } as T
        }
        return { changed: true } as T
      },
    } as AgentBridgeClient & { callToEndpoint: Function }
    let turn = 0
    const fetchImpl = vi.fn(async () => {
      turn += 1
      return turn === 1
        ? ndjsonResponse([{ message: { role: 'assistant', content: '', tool_calls: [
            { id: 'modify-a', function: {
              index: 0, name: 'navisworks_set_visibility', arguments: { action: 'reset' },
            } },
          ] } }])
        : ndjsonResponse([{ message: { role: 'assistant', content: '完成。' } }])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      bridgeClient: bridge, fetchImpl, contextState, executionLedger: ledger,
      operationCoordinator: new DocumentOperationCoordinator(),
    })
    let approval: ToolApprovalRequest | undefined

    await runtime.run({ runId: 'run-a', text: '重置可见性', navisworksBinding: bindingA() }, {
      requestToolApproval: async (request) => {
        approval = request
        contextState.observe({
          connected: true, instanceId: 'bridge-b', bridgeSessionId: 'bridge-b',
          documentInstanceId: 'doc-b',
        })
        return true
      },
    })

    expect(approval).toMatchObject({
      instanceId: 'bridge-a', bridgeSessionId: 'bridge-a', documentInstanceId: 'doc-a',
    })
    expect(methods.filter((method) => method === 'navisworks_set_visibility')).toHaveLength(1)
    expect(ledger.get('run-a', 'modify-a')).toMatchObject({
      status: 'success', instanceId: 'bridge-a', bridgeSessionId: 'bridge-a',
      documentInstanceId: 'doc-a',
    })
  })

  it('cancels an approval when the bound A identity is no longer valid', async () => {
    let identityValid = true
    const methods: string[] = []
    const bridge = {
      async call() { throw new Error('legacy discovery must not run') },
      async callToEndpoint<T>(_endpoint: unknown, method: string): Promise<T> {
        methods.push(method)
        if (method === 'navisworks_status') {
          return {
            connected: true,
            bridgeSessionId: identityValid ? 'bridge-a' : 'bridge-restarted',
            documentInstanceId: 'doc-a',
          } as T
        }
        return { changed: true } as T
      },
    } as AgentBridgeClient & { callToEndpoint: Function }
    const ledger = new ToolExecutionLedger()
    let turn = 0
    const fetchImpl = vi.fn(async () => {
      turn += 1
      return turn === 1
        ? ndjsonResponse([{ message: { role: 'assistant', content: '', tool_calls: [
            { id: 'modify-stale', function: {
              index: 0, name: 'navisworks_set_visibility', arguments: { action: 'reset' },
            } },
          ] } }])
        : ndjsonResponse([{ message: { role: 'assistant', content: '已取消。' } }])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl, executionLedger: ledger })

    await runtime.run({ runId: 'run-stale-a', text: '重置可见性', navisworksBinding: bindingA() }, {
      requestToolApproval: async () => {
        identityValid = false
        return true
      },
    })

    expect(methods).toEqual(['navisworks_status'])
    expect(ledger.get('run-stale-a', 'modify-stale')).toMatchObject({
      status: 'cancelled', errorCode: 'TARGET_CHANGED', instanceId: 'bridge-a',
    })
  })
})

function bindingA(): NavisworksRunBinding {
  return Object.freeze({
    instanceId: 'bridge-a',
    processId: 1,
    pipeName: 'pipe-a',
    bridgeSessionId: 'bridge-a',
    documentInstanceId: 'doc-a',
    documentName: 'Model-A.nwf',
    boundAt: 1,
    endpoint: Object.freeze({
      ProtocolVersion: 1,
      PipeName: 'pipe-a',
      ProcessId: 1,
      PluginVersion: '1.0.0',
      HostVersion: '2023',
      StartedAtUtc: '2026-09-01T00:00:00Z',
    }),
  })
}
