import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, type AgentBridgeClient } from '../agentRuntime'
import { ContextState } from '../agent/contextState'
import { fromWpfSessionSnapshot, toWpfSessionSnapshot, type ConversationSession } from '../sessionRepository'
import { renderVerifiedFacts } from '../agent/facts'
import { NAVISWORKS_WORKSPACE_PROMPT } from '../agent/prompts'

function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  return new Response(chunks.map((c) => `${JSON.stringify(c)}\n`).join(''), {
    status: 200, headers: { 'content-type': 'application/x-ndjson' },
  })
}

describe('P4 — durable compact summary injected into the model request', () => {
  it('places the compact summary as a leading system block on the first round', async () => {
    const bridge: AgentBridgeClient = { async call<T>() { return { connected: true } as T } }
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ndjsonResponse([{ message: { role: 'assistant', content: '收到。' }, prompt_eval_count: 5, eval_count: 1 }])
    }) as unknown as typeof fetch
    await new AgentRuntime({ bridgeClient: bridge, fetchImpl }).run({
      text: '继续',
      compactSummary: '早前已确认三台泵并隐藏了第一台',
    })
    const messages = bodies[0]?.messages as Array<{ role: string; content: string }>
    // The stable core and workspace system prompts precede the injected durable summary.
    expect(messages[1]?.role).toBe('system')
    expect(messages[1]?.content).toBe(NAVISWORKS_WORKSPACE_PROMPT)
    expect(messages[2]?.role).toBe('system')
    expect(messages[2]?.content).toContain('早前已确认三台泵')
  })

  it('auto-compaction surfaces the produced summary for persistence', async () => {
    const bridgeCalls: string[] = []
    const bridge: AgentBridgeClient = {
      async call(method) { bridgeCalls.push(method); return { marker: `结果${bridgeCalls.length}` } as never },
    }
    const toolChunk = () => ndjsonResponse([{
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'navisworks_status', arguments: {} } }] },
      prompt_eval_count: 1000, eval_count: 0,
    }])
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls <= 3) return toolChunk()
      if (calls === 4) return ndjsonResponse([{ message: { role: 'assistant', content: '已完成前三轮检索。' } }])
      return ndjsonResponse([{ message: { role: 'assistant', content: '最终回答。' }, prompt_eval_count: 30, eval_count: 1 }])
    }) as unknown as typeof fetch
    const result = await new AgentRuntime({ bridgeClient: bridge, fetchImpl, contextWindow: 1024 }).run('多轮')
    expect(result.compacted).toBe(true)
    expect(result.compactSummary).toContain('已完成前三轮检索')
  })
})

describe('P4 — compactSummary persistence round-trip + backward compatibility', () => {
  it('survives the WPF snapshot round-trip', () => {
    const session: ConversationSession = {
      id: '11111111-1111-1111-1111-111111111111',
      title: 't', preview: 'p', updatedAt: '2026-08-31T00:00:00.0000000+08:00',
      messages: [], contextTokensUsed: 0, pinnedAt: null,
      compactSummary: '摘要内容',
    }
    const restored = fromWpfSessionSnapshot(toWpfSessionSnapshot(session))
    expect(restored.compactSummary).toBe('摘要内容')
  })

  it('older sessions without the field load unchanged (compactSummary undefined)', () => {
    const legacy = {
      Id: '11111111-1111-1111-1111-111111111111',
      Title: 't', Preview: 'p', UpdatedAt: '2026-08-31T00:00:00.0000000+08:00',
      Messages: null, ContextTokensUsed: 0, PinnedAt: null,
    }
    // The converter must not invent a compactSummary for a pre-P4 snapshot.
    expect(fromWpfSessionSnapshot(legacy as never).compactSummary).toBeUndefined()
  })
})

describe('P4 — renderVerifiedFacts is bounded + priority-ordered', () => {
  it('caps output and orders critical/active first', () => {
    const state = new ContextState()
    state.observe({ documentInstanceId: 'doc-A' })
    state.ingestToolResult('navisworks_find_items', {
      items: Array.from({ length: 200 }, (_, i) => ({ id: `i${i}`, name: `泵-${i}` })),
    }, 'c1')
    const block = renderVerifiedFacts(state.factsForCurrentDocument())
    expect(block).toContain('已验证事实')
    // Capped well under the full 200-item set so it cannot blow the 32K window.
    expect(block.split('\n').length).toBeLessThanOrEqual(26)
  })

  it('returns empty string with no facts', () => {
    expect(renderVerifiedFacts([])).toBe('')
  })
})
