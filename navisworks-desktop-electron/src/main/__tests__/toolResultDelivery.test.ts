import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRuntime, type AgentBridgeClient } from '../agentRuntime'
import { ToolOutputStore } from '../toolOutputStore'
import { ContextManager } from '../agent/contextManager'
import {
  buildPagedResultContent,
  decideToolResultDelivery,
  serializedByteLength,
  PAGED_TOOL_RESULT_MODEL_MESSAGE,
} from '../agent/toolResultDelivery'
import type { ChatMessage } from '../model/types'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'curi-delivery-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function findItemsResult(count: number, nameFiller = ''): { items: unknown[]; total: number; truncated: boolean } {
  return {
    items: Array.from({ length: count }, (_, i) => ({ id: `id-${i}`, name: `构件-${i}${nameFiller}` })),
    total: count,
    truncated: false,
  }
}

describe('ToolOutputStore.store(): persists the FULL result, unchanged (§五/§六/§46-E)', () => {
  it('writes byte-for-byte complete data to disk and returns a ref + byte count', async () => {
    const dir = await tempDir()
    const store = new ToolOutputStore(dir)
    const data = findItemsResult(500)
    const { resultRef, totalBytes } = await store.store({
      sessionId: 's1', toolCallId: 'c1', toolName: 'navisworks_find_items', data,
    })
    expect(resultRef).toMatch(/^tor_/)
    expect(totalBytes).toBe(serializedByteLength(data))
    // Case E: the落盘 file holds the complete original — not a preview.
    const raw = JSON.parse(await readFile(join(dir, `${resultRef}.json`), 'utf8')) as { data: typeof data }
    expect(raw.data).toEqual(data)
    expect(raw.data.items).toHaveLength(500)
  })

  it('Case D: read_tool_result from 0 to end reassembles the ORIGINAL exactly', async () => {
    const dir = await tempDir()
    const store = new ToolOutputStore(dir)
    const data = findItemsResult(500)
    const { resultRef } = await store.store({
      sessionId: 's1', toolCallId: 'c1', toolName: 'navisworks_find_items', data,
    })
    const merged: unknown[] = []
    let offset = 0
    // Page through to the end (limit is a PAGING size, not a truncation).
    for (;;) {
      const page = await store.read(resultRef, offset, 100)
      expect(page.error).toBeUndefined()
      merged.push(...(page.items ?? []))
      if (!page.hasMore) break
      offset += page.returned
    }
    expect(merged).toEqual(data.items)
  })
})

describe('decideToolResultDelivery: full vs paged by CONTEXT capacity, never a byte cap (§三/§四/§八)', () => {
  it('fits → full content, complete and unmodified', () => {
    const data = findItemsResult(1000)
    const delivery = decideToolResultDelivery({ fits: true, data })
    expect(delivery.mode).toBe('full')
    expect(delivery.mode === 'full' && delivery.content).toEqual(data)
  })

  it('does not fit → paged with a resultRef, size and context-capacity reason', async () => {
    const dir = await tempDir()
    const store = new ToolOutputStore(dir)
    const data = findItemsResult(2000)
    const { resultRef } = await store.store({ sessionId: 's', toolCallId: 'c', toolName: 'navisworks_find_items', data })
    const delivery = decideToolResultDelivery({ fits: false, data, proactiveResultRef: resultRef })
    expect(delivery).toMatchObject({ mode: 'paged', resultRef, reason: 'context-capacity' })
    if (delivery.mode === 'paged') {
      expect(delivery.totalBytes).toBe(serializedByteLength(data))
      expect(delivery.estimatedTokens).toBeGreaterThan(0)
    }
  })

  it('paged delivery REQUIRES a resultRef — it can never be constructed by slicing (§三)', () => {
    expect(() => decideToolResultDelivery({ fits: false, data: { big: true } })).toThrow(/resultRef/)
  })

  it('buildPagedResultContent carries the recover instruction, no truncation wording (§七/§十/§44)', () => {
    const content = buildPagedResultContent('tor_x', 123456, 90000)
    expect(content).toMatchObject({ delivery: 'paged', resultRef: 'tor_x', totalBytes: 123456 })
    expect(content.message).toBe(PAGED_TOOL_RESULT_MODEL_MESSAGE)
    expect(JSON.stringify(content)).not.toContain('截断')
    expect(content).not.toHaveProperty('truncated')
  })
})

describe('ContextManager.fitsProjectedToolExchange: the protected floor decides full vs paged (§八/§九)', () => {
  function managerWithTurn(): ContextManager {
    const cm = new ContextManager({ systemPrompt: 'SYS' })
    cm.addUserTurn({ role: 'user', content: '问题' })
    return cm
  }
  const assistant: ChatMessage = { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'navisworks_find_items', arguments: {} }] }
  function toolMsg(data: unknown): ChatMessage {
    return { role: 'tool', toolCallId: 'c1', content: JSON.stringify(data) }
  }

  it('a result that fits the window projects as fitting (big window)', () => {
    const data = findItemsResult(50)
    const fits = managerWithTurn().fitsProjectedToolExchange({
      tools: [], outputReserve: 1024, effectiveWindow: 1_000_000,
      candidateMessages: [assistant, toolMsg(data)],
    })
    expect(fits).toBe(true)
  })

  it('a result that cannot fit even with all history dropped projects as NOT fitting → paged', () => {
    const data = findItemsResult(5000)
    const fits = managerWithTurn().fitsProjectedToolExchange({
      tools: [], outputReserve: 1024, effectiveWindow: 4096,
      candidateMessages: [assistant, toolMsg(data)],
    })
    expect(fits).toBe(false)
  })

  it('Case A: a 1M-token window holds a 60KB-class result fully (no fixed 32K clip)', () => {
    // ~60KB payload. The OLD resolveToolResultCharLimit capped at 32_000 chars
    // REGARDLESS of window; the new predicate is window-driven.
    const data = findItemsResult(1200, '（padding 中文内容）')
    const bytes = serializedByteLength(data)
    expect(bytes).toBeGreaterThan(60_000)
    const fits1M = managerWithTurn().fitsProjectedToolExchange({
      tools: [], outputReserve: 2048, effectiveWindow: 1_000_000,
      candidateMessages: [assistant, toolMsg(data)],
    })
    expect(fits1M).toBe(true)
  })

  it('dropping history never drops the protected current exchange (floor is honest)', () => {
    const cm = new ContextManager({
      systemPrompt: 'SYS',
      history: Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `历史-${i}` })),
    })
    cm.addUserTurn({ role: 'user', content: '当前问题' })
    const data = findItemsResult(30)
    // Even with heavy history, a small protected exchange still fits a small window.
    const fits = cm.fitsProjectedToolExchange({
      tools: [], outputReserve: 512, effectiveWindow: 8192,
      candidateMessages: [assistant, toolMsg(data)],
    })
    expect(fits).toBe(true)
  })
})

describe('runtime delivery: big window → COMPLETE result inline (Case A/B, §46/§59)', () => {
  // OpenAI-compatible SSE (the run drives the API provider, not Ollama).
  function sse(chunks: Array<Record<string, unknown>>): Response {
    const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  async function runWithResult(result: unknown) {
    const dir = await tempDir()
    const bridge: AgentBridgeClient = { async call<T>() { return result as T } }
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
    let round = 0
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ role: string; content: string }> })
      round += 1
      if (round === 1) {
        return sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'navisworks_find_items', arguments: JSON.stringify({ query: '泵' }) } }] } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
        ])
      }
      return sse([
        { choices: [{ delta: { content: '完成。' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
      ])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      bridgeClient: bridge, fetchImpl, toolOutputStore: new ToolOutputStore(dir),
    })
    // Drive through an API endpoint so effectiveWindow is the configured 1M —
    // the local 32K clamp does not apply to openai-compatible providers.
    await runtime.run({
      sessionId: 's1',
      text: '查泵',
      api: {
        baseUrl: 'https://api.example.com/v1',
        model: 'qwen-max',
        advanced: {
          contextWindowTokens: 1_000_000, maxOutputTokens: null, temperature: null,
          requestTimeoutMs: 300_000, maxTokensParameter: 'auto', sendReasoningEffort: 'auto', sendStreamOptions: true,
        },
      },
    })
    const toolMessage = bodies
      .flatMap((body) => body.messages ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
      .join('\n')
    return { toolMessage, dir }
  }

  it('Case A: a 60KB result on a 1M window is delivered COMPLETE (no truncated/preview)', async () => {
    const data = findItemsResult(1200, '（中文内容填充）')
    expect(serializedByteLength(data)).toBeGreaterThan(60_000)
    const { toolMessage } = await runWithResult(data)
    // Every item is present — the LAST id survives, proving no slice.
    expect(toolMessage).toContain('构件-1199')
    expect(toolMessage).not.toContain('截断')
    expect(toolMessage).not.toContain('"delivery":"paged"')
    expect(toolMessage).not.toContain('"truncated":true')
  })

  it('Case B: a ~300KB result still within a 1M window goes COMPLETE into the model', async () => {
    const data = findItemsResult(5000, '（较长的中文构件名称内容用于放大负载）')
    const bytes = serializedByteLength(data)
    // 300KB is comfortably under a 1M-token budget (≈ >300K chars capacity).
    expect(bytes).toBeGreaterThan(300_000)
    const { toolMessage } = await runWithResult(data)
    expect(toolMessage).toContain('构件-4999')
    expect(toolMessage).not.toContain('"delivery":"paged"')
  })
})
