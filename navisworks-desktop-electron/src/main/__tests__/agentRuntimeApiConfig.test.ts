import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, toAgentRuntimeSettings, type AgentBridgeClient, type ApiEndpointConfig } from '../agentRuntime'
import { ContextManager } from '../agent/contextManager'
import { DEFAULT_RUNTIME_SETTINGS } from '../agentRuntime'

// OpenAI-compatible SSE helpers (same wire style as openaiProvider.test.ts).
function sseResponse(chunks: Array<Record<string, unknown>>): Response {
  const text = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('') + 'data: [DONE]\n\n'
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const textTurn = (content: string) => sseResponse([
  { choices: [{ delta: { content } }] },
  { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
])

const toolCallTurn = (id: string, name: string, args: Record<string, unknown>) => sseResponse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
])

const API_BASE = 'https://cloud.example.com/v1'

function autoAdvanced(): NonNullable<ApiEndpointConfig['advanced']> {
  return {
    contextWindowTokens: null,
    maxOutputTokens: null,
    temperature: null,
    requestTimeoutMs: 300_000,
    maxTokensParameter: 'auto',
    sendReasoningEffort: 'auto',
    sendStreamOptions: true,
  }
}

interface Harness {
  bodies: Array<Record<string, unknown>>
  urls: string[]
  fetchCount(): number
  fetchImpl: typeof fetch
}

// Responses are FACTORIES: a Response body can only be read once, and the
// harness deliberately replays the last entry for unbounded tool loops.
function makeHarness(responses: Array<() => Response>): Harness {
  const bodies: Array<Record<string, unknown>> = []
  const urls: string[] = []
  let index = 0
  const fetchImpl = vi.fn(async (url: unknown, init?: { body?: string }) => {
    urls.push(String(url))
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    const make = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (make === undefined) throw new Error('no stub response configured')
    return make()
  }) as unknown as typeof fetch
  return { bodies, urls, fetchCount: () => index, fetchImpl }
}

const bridge: AgentBridgeClient = {
  async call<T>() {
    // A payload large enough that the OLD 4000-char cap would truncate it.
    const blob = 'x'.repeat(9_000)
    return { items: [{ id: 'i1', blob }, { id: 'i2', blob }], total: 2, truncated: false } as T
  },
}

describe('API-first runtime configuration (run scope, no restart)', () => {
  it('a 128K profile window is used verbatim instead of the 32K local clamp', async () => {
    const harness = makeHarness([() => textTurn('完成。')])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    const result = await runtime.run({
      text: '你好',
      api: {
        baseUrl: API_BASE,
        model: 'qwen-max',
        advanced: { ...autoAdvanced(), contextWindowTokens: 131_072 },
      },
    })
    expect(result.isSuccess).toBe(true)
    expect(result.contextWindowTokens).toBe(131_072)
    // The request never hit the local daemon.
    expect(harness.urls[0]?.startsWith(API_BASE)).toBe(true)
  })

  it('maxOutputTokens=null sends NO output-limit parameter', async () => {
    const harness = makeHarness([() => textTurn('完成。')])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    await runtime.run({
      text: '你好',
      api: { baseUrl: API_BASE, model: 'qwen-max', advanced: autoAdvanced() },
    })
    const body = harness.bodies[0]!
    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('maxOutputTokens=8192 is sent under the configured parameter name', async () => {
    const harness = makeHarness([() => textTurn('完成。'), () => textTurn('完成。')])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    await runtime.run({
      text: '你好',
      api: { baseUrl: API_BASE, model: 'qwen-max', advanced: { ...autoAdvanced(), maxOutputTokens: 8_192 } },
    })
    expect(harness.bodies[0]?.max_tokens).toBe(8_192)
    await runtime.run({
      text: '你好',
      api: {
        baseUrl: API_BASE,
        model: 'qwen-max',
        advanced: { ...autoAdvanced(), maxOutputTokens: 8_192, maxTokensParameter: 'max_completion_tokens' },
      },
    })
    expect(harness.bodies[1]?.max_completion_tokens).toBe(8_192)
    expect(harness.bodies[1]?.max_tokens).toBeUndefined()
  })

  it('historyMode=auto hands the FULL history to the context budget (no slice(-24))', async () => {
    const harness = makeHarness([() => textTurn('完成。')])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `历史消息-${index}`,
    }))
    await runtime.run({
      text: '你好',
      history,
      api: {
        baseUrl: API_BASE,
        model: 'qwen-max',
        // Big window so nothing is budget-trimmed either — full history in.
        advanced: { ...autoAdvanced(), contextWindowTokens: 131_072 },
      },
      runtimeConfig: { ...DEFAULT_RUNTIME_SETTINGS, historyMode: 'auto' },
    })
    const messages = harness.bodies[0]?.messages as Array<{ content: string }>
    expect(messages.some((message) => message.content === '历史消息-0')).toBe(true)
  })

  it('historyMode=fixed still slices to the configured limit', async () => {
    const harness = makeHarness([() => textTurn('完成。')])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `历史消息-${index}`,
    }))
    await runtime.run({
      text: '你好',
      history,
      api: { baseUrl: API_BASE, model: 'qwen-max', advanced: { ...autoAdvanced(), contextWindowTokens: 131_072 } },
      runtimeConfig: { ...DEFAULT_RUNTIME_SETTINGS, historyMode: 'fixed', historyMessageLimit: 4 },
    })
    const messages = harness.bodies[0]?.messages as Array<{ content: string }>
    expect(messages.some((message) => message.content === '历史消息-0')).toBe(false)
    expect(messages.some((message) => message.content === '历史消息-39')).toBe(true)
  })

  it('toolResultMode=auto lets big tool results through on a big window', async () => {
    const harness = makeHarness([
      () => toolCallTurn('call-1', 'navisworks_find_items', { query: 'Pump' }),
      () => textTurn('完成。'),
    ])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    await runtime.run({
      text: '查一下',
      api: { baseUrl: API_BASE, model: 'qwen-max', advanced: { ...autoAdvanced(), contextWindowTokens: 131_072 } },
      runtimeConfig: { ...DEFAULT_RUNTIME_SETTINGS, toolResultMode: 'auto' },
    })
    const toolMessage = (harness.bodies[1]?.messages as Array<{ role: string; content: string }>)
      .find((message) => message.role === 'tool')
    // ~19KB wire payload survives: auto mode is NOT the old 4000-char cap.
    expect(toolMessage?.content.length).toBeGreaterThan(9_000)
    expect(toolMessage?.content).not.toContain('已截断至')
  })

  it('toolResultMode=fixed NO LONGER truncates — the char cap is deprecated (§15/§47, Invariant A)', async () => {
    const harness = makeHarness([
      () => toolCallTurn('call-1', 'navisworks_find_items', { query: 'Pump' }),
      () => textTurn('完成。'),
    ])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    await runtime.run({
      text: '查一下',
      api: { baseUrl: API_BASE, model: 'qwen-max', advanced: { ...autoAdvanced(), contextWindowTokens: 131_072 } },
      runtimeConfig: {
        ...DEFAULT_RUNTIME_SETTINGS,
        toolResultMode: 'fixed',
        toolResultMaxChars: 600,
      },
    })
    const toolMessage = (harness.bodies[1]?.messages as Array<{ role: string; content: string }>)
      .find((message) => message.role === 'tool')
    // The full ~18KB payload still reaches the model: no fixed char cap, no
    // "已截断至" notice, no slice. The deprecated setting is accepted but ignored
    // for truncation (Tool Result Delivery v2 — capacity is the ONLY limiter).
    expect(toolMessage?.content.length).toBeGreaterThan(9_000)
    expect(toolMessage?.content).not.toContain('已截断')
  })

  it('maxToolRounds from run-scoped settings applies immediately', async () => {
    const harness = makeHarness([
      () => toolCallTurn('call-loop', 'navisworks_status', {}),
    ])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    const result = await runtime.run({
      text: '循环一下',
      api: { baseUrl: API_BASE, model: 'qwen-max', advanced: autoAdvanced() },
      runtimeConfig: { ...DEFAULT_RUNTIME_SETTINGS, maxToolRounds: 2 },
    })
    expect(result.errorCode).toBe('TOOL_ROUND_LIMIT')
    // Exactly 2 model rounds — the old constant (8) would have made 8 calls.
    expect(harness.fetchCount()).toBe(2)
  })

  it('API-mode title generation answers on the active endpoint, never Ollama', async () => {
    const harness = makeHarness([() => textTurn('会话标题')])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    const title = await runtime.summarizeTitle('帮我检查所有泵的位置', undefined, {
      baseUrl: API_BASE,
      model: 'qwen-max',
      advanced: autoAdvanced(),
    })
    expect(title).toBe('会话标题')
    expect(harness.urls.every((url) => url.startsWith(API_BASE))).toBe(true)
  })

  it('without an API endpoint, title generation still uses the local provider', async () => {
    const urls: string[] = []
    let index = 0
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url))
      index += 1
      // Ollama summarizeTitle posts a plain-JSON /api/chat request.
      return new Response(JSON.stringify({ message: { content: '本地标题' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })
    const title = await runtime.summarizeTitle('帮我检查')
    expect(title).toBe('本地标题')
    expect(urls[0]?.startsWith('http://localhost:11434')).toBe(true)
    expect(index).toBe(1)
  })
})

describe('hard safety ceilings on the runtime settings mapping', () => {
  it('clamps round/replan budgets and keeps window tokens sane', () => {
    const mapped = toAgentRuntimeSettings({
      maxToolRounds: 999,
      compactionEnabled: true,
      compactionTriggerRatio: 0.99,
      compactKeepRecentFrames: 99,
      compactMaxTranscriptChars: 9_999_999,
      historyMode: 'fixed',
      historyMessageLimit: 99_999,
      toolResultMode: 'fixed',
      toolResultMaxChars: 9_999_999,
      plannerMaxAttempts: 99,
      plannerMaxSteps: 99,
      plannerMaxTokens: 9_999_999,
      verifierMaxAttempts: 99,
      verifierMaxEvidence: 99,
      maxTaskReplans: 99,
    })
    expect(mapped.maxToolRounds).toBe(64)
    expect(mapped.maxTaskReplans).toBe(16)
    expect(mapped.compactionTriggerRatio).toBe(0.98)
    expect(mapped.compactKeepRecentFrames).toBe(20)
    expect(mapped.plannerMaxAttempts).toBe(5)
    expect(mapped.plannerMaxSteps).toBe(32)
    expect(mapped.verifierMaxAttempts).toBe(5)
    expect(mapped.verifierMaxEvidence).toBe(50)
    expect(mapped.historyMessageLimit).toBe(1_000)
    expect(mapped.toolResultMaxChars).toBe(200_000)
    expect(mapped.compactMaxTranscriptChars).toBe(200_000)
    expect(mapped.plannerMaxTokens).toBe(200_000)
  })

  it('falls back to defaults when no execution settings exist', () => {
    expect(toAgentRuntimeSettings(undefined)).toEqual(DEFAULT_RUNTIME_SETTINGS)
  })
})

describe('compaction trigger ratio is run-configurable', () => {
  it('a lower ratio triggers compact earlier than the 0.85 default', () => {
    // 55% usage with a 0.5 trigger → compact; the default ratio stays idle.
    expect(ContextManager.contextPressure(5_500, 10_000, 0.5)).toBe('compact')
    expect(ContextManager.contextPressure(5_500, 10_000)).toBe('idle')
    // The user ratio shifts the trigger BELOW the defaults.
    expect(ContextManager.contextPressure(8_300, 10_000)).toBe('soft')
    expect(ContextManager.contextPressure(8_300, 10_000, 0.5)).toBe('compact')
    // The trigger never exceeds the hard 0.98 bound.
    expect(ContextManager.contextPressure(9_900, 10_000, 0.99)).toBe('compact')
    expect(ContextManager.contextPressure(9_700, 10_000, 0.99)).toBe('soft')
  })
})

// Ollama ndjson helper for the local-window case.
function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  return new Response(chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

import { resolveApiContextWindow } from '../agentRuntime'
import { eventSchemas } from '../../shared/ipc/schemas'

describe('context window source resolution (Cases 1–4)', () => {
  it('Case 1: profile 128000 wins over unknown capability → profile', () => {
    const resolved = resolveApiContextWindow(128_000, {}, 32_768)
    expect(resolved).toEqual({ window: 128_000, source: 'profile' })
  })

  it('Case 2: profile Auto + provider-reported 200000 → provider', () => {
    expect(resolveApiContextWindow(
      null,
      { maxContextWindow: 200_000, defaultContextWindow: 200_000 },
      32_768,
    )).toEqual({ window: 200_000, source: 'provider' })
    // defaultContextWindow alone still counts as provider knowledge.
    expect(resolveApiContextWindow(null, { defaultContextWindow: 65_536 }, 32_768))
      .toEqual({ window: 65_536, source: 'provider' })
  })

  it('Case 3: profile Auto + no capability → the configured safety fallback', () => {
    const resolved = resolveApiContextWindow(null, {}, 32_768)
    expect(resolved).toEqual({ window: 32_768, source: 'fallback' })
  })

  it('run() end-to-end: profile source on the result (128K stays 128K)', async () => {
    const harness = makeHarness([() => textTurn('完成。')])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    const result = await runtime.run({
      text: '你好',
      api: {
        baseUrl: API_BASE,
        model: 'qwen-max',
        advanced: { ...autoAdvanced(), contextWindowTokens: 131_072 },
      },
    })
    expect(result.contextWindowTokens).toBe(131_072)
    expect(result.contextWindowSource).toBe('profile')
  })

  it('run() end-to-end: fallback source when nothing is known', async () => {
    const harness = makeHarness([() => textTurn('完成。')])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    const result = await runtime.run({
      text: '你好',
      api: { baseUrl: API_BASE, model: 'qwen-max', advanced: autoAdvanced() },
    })
    expect(result.contextWindowTokens).toBe(32_768)
    expect(result.contextWindowSource).toBe('fallback')
  })

  it('Case 4: a local Ollama run reports the local source (clamp intact)', async () => {
    const responses = [
      () => ndjsonResponse([{ message: { role: 'assistant', content: '本地回答。' }, prompt_eval_count: 20, eval_count: 1 }]),
    ]
    const bodies: Array<Record<string, unknown>> = []
    const urls: string[] = []
    let index = 0
    const fetchImpl = vi.fn(async (url: unknown, init?: { body?: string }) => {
      urls.push(String(url))
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      const make = responses[Math.min(index, responses.length - 1)]
      index += 1
      if (make === undefined) throw new Error('no stub response configured')
      return make()
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl, contextWindow: 16384 })
    const result = await runtime.run({ text: '本地问题' })
    expect(result.isSuccess).toBe(true)
    expect(result.contextWindowSource).toBe('local')
    // Local clamp: the configured 16384 stays 16384 (no 32K inflation), and
    // num_predict is still sent locally (outputReserve = numPredict).
    expect(result.contextWindowTokens).toBe(16_384)
    expect(urls[0]?.startsWith('http://localhost:11434')).toBe(true)
  })

  it('Cases 7–8: flipping the profile between fixed and Auto re-resolves on the NEXT run, no restart', async () => {
    const harness = makeHarness([() => textTurn('完成。'), () => textTurn('完成。')])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    // First run: the profile pins 128000 → profile source.
    const fixed = await runtime.run({
      text: '第一轮',
      api: {
        baseUrl: API_BASE,
        model: 'qwen-max',
        advanced: { ...autoAdvanced(), contextWindowTokens: 128_000 },
      },
    })
    expect(fixed.contextWindowSource).toBe('profile')
    expect(fixed.contextWindowTokens).toBe(128_000)
    // The user flips the profile back to Auto in settings; the next chat.start
    // sends the fresh advanced (null) — no restart, runtime re-decides.
    const auto = await runtime.run({
      text: '第二轮',
      api: { baseUrl: API_BASE, model: 'qwen-max', advanced: autoAdvanced() },
    })
    expect(auto.contextWindowSource).toBe('fallback')
    expect(auto.contextWindowTokens).toBe(32_768)
  })

  it('Case 5: the REAL IPC schema (eventSchemas[chat.done]) carries window + source', () => {
    // The Electron wire validates against eventSchemas['chat.done'] — testing
    // any other done definition is what let the schema drift ship.
    const parsed = eventSchemas['chat.done'].parse({
      kind: 'done',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'message-1',
      content: '完成。',
      contextTokensUsed: 1_820,
      contextWindowTokens: 128_000,
      contextWindowSource: 'profile',
    })
    expect(parsed).toMatchObject({ contextWindowTokens: 128_000, contextWindowSource: 'profile' })
  })

  it.each(['local', 'profile', 'provider', 'fallback', 'model'] as const)(
    'Cases A–E: eventSchemas[chat.done] accepts contextWindowSource=%s',
    (source) => {
      const parsed = eventSchemas['chat.done'].parse({
        kind: 'done',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        messageId: 'message-1',
        content: '完成。',
        contextWindowTokens: 32_768,
        contextWindowSource: source,
      })
      expect(parsed).toMatchObject({ contextWindowSource: source })
    },
  )

  it('§53: the REAL chat.done schema carries modelRef (never silently drops it)', () => {
    const parsed = eventSchemas['chat.done'].parse({
      kind: 'done',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'message-1',
      content: '完成。',
      contextWindowTokens: 1_000_000,
      contextWindowSource: 'model',
      modelRef: { providerId: 'api:x', modelId: 'qwen3.8-max' },
    })
    // A field present in TS but rejected/omitted by the strict runtime schema is
    // exactly the old chat.done drift bug — assert it survives validation.
    expect(parsed).toMatchObject({
      contextWindowSource: 'model',
      modelRef: { providerId: 'api:x', modelId: 'qwen3.8-max' },
    })
  })

  it('Case E: a legacy done without contextWindowSource stays valid (no migration)', () => {
    const parsed = eventSchemas['chat.done'].parse({
      kind: 'done',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'message-1',
      content: '完成。',
      contextWindowTokens: 32_768,
    })
    expect(parsed).toMatchObject({ contextWindowTokens: 32_768 })
    expect('contextWindowSource' in parsed).toBe(false)
  })

  it('§35/§39: a resolved 1M/128K model config drives effectiveWindow AND the wire output cap', async () => {
    const harness = makeHarness([() => textTurn('完成。')])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    // The endpoint is Auto (advanced.contextWindowTokens null → old code fell to
    // the 32K fallback); the RESOLVED runtimeModel carries the model override.
    const result = await runtime.run({
      text: '你好',
      api: { baseUrl: API_BASE, model: 'qwen-max', advanced: autoAdvanced() },
      runtimeModel: {
        ref: { providerId: 'api:x', modelId: 'qwen-max' },
        displayName: 'qwen-max',
        provider: { id: 'api:x', displayName: 'X', kind: 'openai-compatible' },
        capabilities: { tools: true, temperature: true },
        limits: { context: 1_000_000, output: 128_000 },
        reasoning: { modes: [] },
        metadataSource: 'model',
      },
    })
    expect(result.isSuccess).toBe(true)
    expect(result.contextWindowTokens).toBe(1_000_000)
    expect(result.contextWindowSource).toBe('model')
    // §39: the SAME 128K cap rides on the wire, not the old 4096 reserve.
    const body = harness.bodies[0]!
    expect(body.max_tokens).toBe(128_000)
  })
})
