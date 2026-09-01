import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../model/types'
import type { AgentToolContract } from '../../toolCatalog'
import { OllamaProvider } from '../../model/ollamaProvider'
import { OpenAICompatibleProvider } from '../../model/openaiProvider'
import { findOrphanToolMessages } from '../contextFrames'
import {
  ContextManager,
  buildAgentRequest,
  providerSendsContextWindow,
} from '../contextManager'

const tool = (name: AgentToolContract['function']['name']): AgentToolContract => ({
  type: 'function',
  function: { name, description: 'd', parameters: { type: 'object', properties: {} } },
  impact: 'read-only',
})

describe('ContextManager.buildRequest — provider-neutral window policy', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ]

  it('sends the already-clamped local window and preserves complete frames', () => {
    const manager = new ContextManager({ systemPrompt: 'S', history })
    const built = manager.assembleBudgetedFrames({
      tools: [], temperature: 0.1, maxTokens: 2048, effectiveWindow: 32768,
      sendContextWindow: true,
    })
    expect(built.sampling.contextWindow).toBe(32768)
    expect(built.sampling.temperature).toBe(0.1)
    expect(built.sampling.maxTokens).toBe(2048)
    expect(built.messages).toEqual([{ role: 'system', content: 'S' }, ...history])
  })

  it('budgets a finite cloud window without sending contextWindow', () => {
    const manager = new ContextManager({ systemPrompt: 'S', history })
    const built = manager.assembleBudgetedFrames({
      tools: [], temperature: 0.1, maxTokens: 2048, effectiveWindow: 128000,
      sendContextWindow: false,
    })
    expect('contextWindow' in built.sampling).toBe(false)
    expect(built.report.contextWindow).toBe(128000)
  })

  it('reports tool-schema tokens when tools are offered', () => {
    const manager = new ContextManager({ systemPrompt: 'S', history })
    const built = manager.assembleBudgetedFrames({
      tools: [tool('navisworks_status')], temperature: 0.1, maxTokens: 2048,
      effectiveWindow: 32768, sendContextWindow: true,
    })
    expect(built.report.toolSchemaTokens).toBeGreaterThan(0)
    expect(built.report.systemTokens).toBeGreaterThan(0)
  })
})

describe('buildAgentRequest — assembles system + history + input + in-flight', () => {
  it('keeps the leading system prompt and uses the supplied effective window', () => {
    const built = buildAgentRequest({
      systemPrompt: 'SYS',
      history: [{ role: 'user', content: 'h1' }, { role: 'assistant', content: 'h2' }],
      currentInput: 'now',
      inFlight: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'navisworks_status', arguments: {} }] },
        { role: 'tool', toolCallId: 'c1', content: 'ok' },
      ],
      tools: [tool('navisworks_status')],
      temperature: 0.1,
      maxTokens: 2048,
      effectiveWindow: 128000,
    })
    expect(built.messages.map((message) => message.role)).toEqual([
      'system', 'user', 'assistant', 'user', 'assistant', 'tool',
    ])
    expect(built.messages[0]?.content).toBe('SYS')
    expect(built.messages[3]?.content).toBe('now')
    expect(built.sampling.contextWindow).toBe(128000)
    expect(findOrphanToolMessages(built.messages)).toEqual([])
  })

  it('records prior compaction on the report', () => {
    const built = buildAgentRequest({
      systemPrompt: 'SYS', history: [], currentInput: 'x', tools: [],
      temperature: 0.1, maxTokens: 1024, effectiveWindow: 32768, alreadyCompacted: true,
    })
    expect(built.report.compacted).toBe(true)
  })
})

describe('ContextManager.tryCompact — never orphans a tool result', () => {
  it('replaces the compressible middle with one summary and keeps the recent window verbatim', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ]
    const manager = new ContextManager({ systemPrompt: 'S', history: messages.slice(1) })
    const changed = await manager.tryCompact({
      summarizerModel: 'm',
      summarize: async () => 'EARLY_SUMMARY',
    })
    const built = manager.assembleBudgetedFrames({
      tools: [], temperature: 0.1, maxTokens: 512,
      effectiveWindow: 32768, sendContextWindow: true,
    })
    expect(changed).toBe(true)
    expect(built.messages[1]?.content).toContain('EARLY_SUMMARY')
    expect(built.messages[1]?.role).toBe('system')
    // The last four turns survive verbatim; the two compressible ones are gone.
    expect(built.messages.map((message) => message.content)).not.toContain('a1')
    expect(built.messages.at(-1)?.content).toBe('a3')
    expect(findOrphanToolMessages(built.messages)).toEqual([])
  })

  it('is best-effort: a failing summarizer leaves the array untouched', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' }, { role: 'assistant', content: 'a3' },
    ]
    const snapshot = messages.map((message) => ({ ...message }))
    const manager = new ContextManager({ systemPrompt: 'S', history: messages.slice(1) })
    const changed = await manager.tryCompact({
      summarizerModel: 'm',
      summarize: async () => { throw new Error('boom') },
    })
    expect(changed).toBe(false)
    expect(manager.frames.flatMap((frame) => frame.type === 'tool-exchange'
      ? [frame.assistant, ...frame.results]
      : [frame.message])).toEqual(snapshot.slice(1))
  })

  it('does nothing when there is not enough to compress', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]
    const before = messages.length
    const changed = await new ContextManager({ systemPrompt: 'S', history: messages.slice(1) }).tryCompact({
      summarizerModel: 'm',
      summarize: vi.fn(async () => 'x'),
    })
    expect(changed).toBe(false)
    expect(messages).toHaveLength(before)
  })

  it('flags a tool result that is separated from its assistant call', () => {
    expect(findOrphanToolMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'navisworks_status', arguments: {} }] },
      { role: 'user', content: '插入消息' },
      { role: 'tool', toolCallId: 'c1', content: 'late' },
    ])).toEqual(['c1'])
  })
})

describe('buildAgentRequest — P4 layer order (summary → facts → history → input)', () => {
  it('injects compact summary then verified facts as leading system blocks', () => {
    const built = buildAgentRequest({
      systemPrompt: 'SYS',
      history: [{ role: 'user', content: 'h' }],
      currentInput: 'now',
      tools: [],
      temperature: 0.1,
      maxTokens: 2048,
      effectiveWindow: 32768,
      compactSummary: '早前查了三台泵',
      verifiedFactsBlock: '【已验证事实】\n- [item] item:a = {}',
    })
    expect(built.messages.map((m) => m.role)).toEqual([
      'system', 'system', 'system', 'user', 'user',
    ])
    expect(built.messages[1]?.content).toContain('早前查了三台泵')
    expect(built.messages[2]?.content).toContain('已验证事实')
    expect(built.messages.at(-1)?.content).toBe('now')
  })

  it('omits the layers when not provided (unchanged array for the common case)', () => {
    const built = buildAgentRequest({
      systemPrompt: 'SYS', history: [], currentInput: 'x', tools: [],
      temperature: 0.1, maxTokens: 1024, effectiveWindow: 32768,
    })
    expect(built.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'x' },
    ])
  })
})

describe('contextPressure — provider-neutral ratio gate (P4-A)', () => {
  it('is idle for an unbounded window (never compacts a cloud endpoint)', () => {
    expect(ContextManager.contextPressure(999_999, Number.POSITIVE_INFINITY)).toBe('idle')
  })
  it('soft at ≥0.80 and compact at ≥0.85 of a local window', () => {
    expect(ContextManager.contextPressure(0, 1000)).toBe('idle')
    expect(ContextManager.contextPressure(820, 1000)).toBe('soft')
    expect(ContextManager.contextPressure(900, 1000)).toBe('compact')
  })
})

describe('ModelCapabilities — no local/cloud branching leaks into the contract', () => {
  it('Ollama advertises tools, thinking and a 32K window', () => {
    const caps = new OllamaProvider().capabilities('m')
    expect(caps).toMatchObject({ supportsTools: true, supportsThinking: true, maxContextWindow: 32768 })
  })

  it('OpenAI-compatible advertises tools/thinking but no assumed window by default', () => {
    const caps = new OpenAICompatibleProvider({ baseUrl: 'https://x/v1' }).capabilities('m')
    expect(caps.supportsTools).toBe(true)
    expect(caps.maxContextWindow).toBeUndefined()
  })

  it('OpenAI-compatible surfaces a configured window without assuming 1M', () => {
    const caps = new OpenAICompatibleProvider({ baseUrl: 'https://x/v1', contextWindow: 65536 }).capabilities('m')
    expect(caps.maxContextWindow).toBe(65536)
  })
})

describe('providerSendsContextWindow', () => {
  it('only the local Ollama provider consumes a finite window', () => {
    expect(providerSendsContextWindow('ollama', true, 32768)).toBe(true)
    expect(providerSendsContextWindow('ollama', false, Number.POSITIVE_INFINITY)).toBe(false)
    expect(providerSendsContextWindow('openai', true, 32768)).toBe(false)
  })
})
