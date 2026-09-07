import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, type AgentBridgeClient } from '../agentRuntime'
import { buildOllamaModelInfo } from '../model/catalog/modelResolver'
import type { ModelInfo } from '../../shared/model'

/** Minimal ndjson stream response with a final usage line. */
function ndjson(lines: unknown[]): Response {
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

const ollamaModel: ModelInfo = buildOllamaModelInfo({ providerId: 'ollama', modelId: 'qwen3.5:9b' })

describe('P7 runtime floor — an illegal reasoning step never reaches the wire (§63)', () => {
  it('xhigh against Ollama modes [low, max] is applied as max (think:true), not xhigh', async () => {
    const bridge: AgentBridgeClient = { async call() { return {} as never } }
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ndjson([
        { message: { role: 'assistant', content: '好。' }, prompt_eval_count: 3, eval_count: 1 },
      ])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    // The caller persisted xhigh from an API run and switched to Ollama.
    const result = await runtime.run({ text: '你好', reasoningMode: 'xhigh', runtimeModel: ollamaModel })
    expect(result.isSuccess).toBe(true)
    // think is the ONLY local reasoning knob; the snapped effort (max) says true.
    expect(bodies[0]?.think).toBe(true)
  })

  it('low against [low, max] stays think:false', async () => {
    const bridge: AgentBridgeClient = { async call() { return {} as never } }
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ndjson([{ message: { role: 'assistant', content: '好。' } }])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })
    await runtime.run({ text: '你好', reasoningMode: 'medium', runtimeModel: ollamaModel })
    // medium snaps to the nearer local step low → think stays off (no thinking request).
    expect(bodies[0]?.think).toBe(false)
  })
})
