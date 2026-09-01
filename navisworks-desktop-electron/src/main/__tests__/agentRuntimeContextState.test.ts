import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, type AgentBridgeClient } from '../agentRuntime'
import { ContextState } from '../agent/contextState'

function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  const text = chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

const findItemsResult = { items: [{ id: 'idA', name: 'Pump-A' }, { id: 'idB' }, { id: 'idC' }] }

describe('AgentRuntime × ContextState — cross-turn reference resolution (§P2-1)', () => {
  it('ingests a find_items set on turn 1 and injects it into turn 2\'s request', async () => {
    const contextState = new ContextState()
    contextState.observe({ documentInstanceId: 'doc-A', bridgeSessionId: 'b1' })
    const bridge: AgentBridgeClient = {
      async call<T>(method: string) {
        if (method === 'navisworks_find_items') return findItemsResult as T
        return { connected: true } as T
      },
    }

    // Turn 1: model asks to search, then answers.
    let turn1 = 0
    const run1Fetch = vi.fn(async () => {
      turn1 += 1
      if (turn1 === 1) {
        return ndjsonResponse([{
          message: { role: 'assistant', content: '', tool_calls: [
            { id: 'c1', function: { index: 0, name: 'navisworks_find_items', arguments: { query: 'pump' } } },
          ] },
          prompt_eval_count: 100, eval_count: 0,
        }])
      }
      return ndjsonResponse([{ message: { role: 'assistant', content: '找到三个泵。' }, prompt_eval_count: 120, eval_count: 5 }])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: run1Fetch, contextState })
    const first = await runtime.run('查找泵')
    expect(first.isSuccess).toBe(true)

    // The result set is now machine-tracked for the active document.
    expect(contextState.lastRelevantReferenceSet()?.orderedRefs).toEqual(['idA', 'idB', 'idC'])

    // Turn 2: capture the outgoing request body — it must carry the reference block.
    const bodies: Array<Record<string, unknown>> = []
    const run2Fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ndjsonResponse([{ message: { role: 'assistant', content: '已隐藏第一个。' }, prompt_eval_count: 130, eval_count: 4 }])
    }) as unknown as typeof fetch
    const runtime2 = new AgentRuntime({ bridgeClient: bridge, fetchImpl: run2Fetch, contextState })
    await runtime2.run('隐藏第一个')

    const sentMessages = JSON.stringify(bodies[0]?.messages)
    expect(sentMessages).toContain('最近结果集')
    expect(sentMessages).toContain('1. idA')
    expect(sentMessages).toContain('3. idC')
  })

  it('does not inject a reference block when no prior result set exists', async () => {
    const contextState = new ContextState()
    contextState.observe({ documentInstanceId: 'doc-Fresh', bridgeSessionId: 'b1' })
    const bridge: AgentBridgeClient = { async call<T>() { return { connected: true } as T } }
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ndjsonResponse([{ message: { role: 'assistant', content: '你好。' }, prompt_eval_count: 10, eval_count: 2 }])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl, contextState })
    await runtime.run('在吗')
    expect(JSON.stringify(bodies[0]?.messages)).not.toContain('最近结果集')
  })
})
