import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRuntime, type AgentBridgeClient } from '../agentRuntime'
import { ContextEngine } from '../context/contextEngine'
import { ContextEpochStore } from '../context/contextEpochStore'
import { contextRegistry } from '../context/contextRegistry'

function ndjson(lines: unknown[]): Response {
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'curi-runtime-context-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

function runtimeWith(dir: string, fetchImpl: typeof fetch): { runtime: AgentRuntime; engine: ContextEngine; store: ContextEpochStore } {
  const store = new ContextEpochStore(dir)
  const engine = new ContextEngine(contextRegistry, store)
  const bridge: AgentBridgeClient = { async call() { return {} as never } }
  const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl, contextEngine: engine })
  return { runtime, engine, store }
}

describe('AgentRuntime × Context Engine (P13/P14)', () => {
  it('success path: prepares through the engine and commits a durable epoch', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      let bodyTexts: string[] = []
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        bodyTexts.push(String(init?.body))
        return ndjson([{ message: { role: 'assistant', content: '你好，我在。' }, prompt_eval_count: 5, eval_count: 3 }])
      }) as unknown as typeof fetch
      const { runtime, store } = runtimeWith(dir, fetchImpl)

      const result = await runtime.run({ sessionId: 's1', text: '你好' })
      expect(result.isSuccess).toBe(true)
      expect(result.contextEpochId).toBeDefined()
      expect(result.contextGeneration).toBe(1)
      // The baseline (system prompt) now carries the two baseline sources joined.
      const firstBody = JSON.parse(bodyTexts[0]!) as { messages: Array<{ role: string; content: string }> }
      // The system prompt IS the assembled baseline: core identity + policy.
      const systemText = firstBody.messages.find((m) => m.role === 'system')?.content ?? ''
      expect(systemText).toContain('Curi')
      expect(systemText.length).toBeGreaterThan(100)
      // The epoch file now exists on disk (committed on success).
      const loaded = await store.load('s1')
      expect(loaded.epoch).not.toBeNull()
      expect(loaded.epoch?.generation).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('prefix stability: turn 2 reuses the epoch and adds no new durable update', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const fetchImpl = vi.fn(async () =>
        ndjson([{ message: { role: 'assistant', content: '好的。' } }])) as unknown as typeof fetch
      const { runtime, engine } = runtimeWith(dir, fetchImpl)

      const turn1 = await runtime.run({ sessionId: 's1', text: '你好' })
      // Turn 2 sees the SAME document state (none) → durable reconcile adds nothing.
      const turn2 = await runtime.run({ sessionId: 's1', text: '你能做什么' })
      expect(turn2.isSuccess).toBe(true)
      expect(turn2.contextEpochId).toBe(turn1.contextEpochId)
      expect(turn2.contextUpdatesAdded).toBe(0)
      expect(turn2.contextPrefixHash).toBe(turn1.contextPrefixHash)
      expect(turn2.contextBaselineHash).toBe(turn1.contextBaselineHash)
      // engine present but no in-memory double-commit
      expect(typeof engine.forgetSession).toBe('function')
    } finally {
      await cleanup()
    }
  })

  it('§65 failure path: an erroring run does NOT commit a durable epoch (§40)', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
      const { runtime, store } = runtimeWith(dir, fetchImpl)

      const result = await runtime.run({ sessionId: 's-fail', text: '你好' })
      expect(result.isSuccess).toBe(false)
      // No successful settlement → the epoch was never persisted.
      const loaded = await store.load('s-fail')
      expect(loaded.epoch).toBeNull()
    } finally {
      await cleanup()
    }
  })
})
