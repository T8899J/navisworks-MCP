import { describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleProvider } from '../model/openaiProvider'
import type { ChatMessage } from '../model/types'

function sseResponse(chunks: Array<Record<string, unknown>>): Response {
  const text = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('') + 'data: [DONE]\n\n'
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const BASE = 'https://cloud.example.com/v1'

describe('OpenAICompatibleProvider', () => {
  it('streams text and reasoning_content deltas and merges indexed tool_call fragments', async () => {
    const deltas: string[] = []
    const fetchImpl = vi.fn(async () => sseResponse([
      { choices: [{ delta: { reasoning_content: '先想' } }] },
      { choices: [{ delta: { reasoning_content: '一步。' } }] },
      { choices: [{ delta: { content: '你好' } }] },
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call-1', function: { name: 'navisworks_status', arguments: '' } },
            ],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{"query":' } },
              { index: 1, id: 'call-2', function: { name: 'navisworks_get_document', arguments: '{}' } },
            ],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: ' "a"}' } },
            ],
          },
        }],
      },
      {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 30, completion_tokens: 8 },
      },
    ])) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider({ baseUrl: BASE, fetchImpl })

    const result = await provider.complete({
      model: 'qwen-plus',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (delta) => {
        if (delta.text !== undefined) deltas.push(`text:${delta.text}`)
        if (delta.thinking !== undefined) deltas.push(`thinking:${delta.thinking}`)
      },
    })

    expect(deltas).toEqual(['thinking:先想', 'thinking:一步。', 'text:你好'])
    expect(result.thinking).toBe('先想一步。')
    expect(result.content).toBe('你好')
    expect(result.contextTokensUsed).toBe(38)
    expect(result.toolCalls).toEqual([
      { id: 'call-1', name: 'navisworks_status', arguments: { query: 'a' } },
      { id: 'call-2', name: 'navisworks_get_document', arguments: {} },
    ])
  })

  it('maps assistant tool_calls and tool results onto the OpenAI wire format', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseResponse([
        { choices: [{ delta: { content: '完成。' } }] },
      ])
    }) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider({ baseUrl: BASE, fetchImpl })

    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'goal' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-9', name: 'navisworks_status', arguments: {} }],
      },
      { role: 'tool', toolCallId: 'call-9', content: '{"connected":true}' },
    ]
    await provider.complete({ model: 'qwen-plus', messages })

    const wireMessages = bodies[0]?.messages as Array<Record<string, unknown>>
    expect(wireMessages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-9',
        type: 'function',
        function: { name: 'navisworks_status', arguments: '{}' },
      }],
    })
    expect(wireMessages[3]).toEqual({
      role: 'tool',
      content: '{"connected":true}',
      tool_call_id: 'call-9',
    })
  })

  it('sends the reasoning effort verbatim when provided', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseResponse([
        { choices: [{ delta: { content: '好。' } }] },
      ])
    }) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider({ baseUrl: BASE, fetchImpl })

    await provider.complete({
      model: 'qwen-plus',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'xhigh',
    })
    expect(bodies[0]?.reasoning_effort).toBe('xhigh')

    // A request without an effort step must not add the field.
    await provider.complete({
      model: 'qwen-plus',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
  })

  it('sends bearer auth only when an api key is configured', async () => {
    const seenHeaders: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push((init?.headers ?? {}) as Record<string, unknown>)
      return sseResponse([{ choices: [{ delta: { content: '好。' } }] }])
    }) as unknown as typeof fetch

    const withKey = new OpenAICompatibleProvider({ baseUrl: BASE, apiKey: ' sk-test ', fetchImpl })
    await withKey.complete({ model: 'm', messages: [] })
    expect(seenHeaders[0]?.Authorization).toBe('Bearer sk-test')

    seenHeaders.length = 0
    const withoutKey = new OpenAICompatibleProvider({ baseUrl: BASE, fetchImpl })
    await withoutKey.complete({ model: 'm', messages: [] })
    expect(seenHeaders[0]?.Authorization).toBeUndefined()
  })

  it('lists models from GET /models and requires a non-empty base URL', async () => {
    let requestedUrl = ''
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      requestedUrl = String(url)
      return new Response(JSON.stringify({ data: [{ id: 'qwen-plus' }, { id: 'qwen-max' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider({ baseUrl: `${BASE}/`, apiKey: 'k', fetchImpl })

    const models = await provider.listModels()
    expect(requestedUrl).toBe(`${BASE}/models`)
    expect(models).toEqual(['qwen-plus', 'qwen-max'])

    expect(() => new OpenAICompatibleProvider({ baseUrl: '   ' })).toThrow()
  })

  it('keeps the request timeout active while the response stream is open', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n'))
      }
    })
    const provider = new OpenAICompatibleProvider({
      baseUrl: BASE,
      requestTimeoutMs: 20,
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    })

    const outcome = await Promise.race([
      provider.complete({ model: 'm', messages: [] }).catch((error: unknown) => error),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 150))
    ])

    expect(outcome).not.toBe('hung')
    expect(outcome).toMatchObject({ code: 'MODEL_TIMEOUT' })
  })
})

describe('OpenAI usage normalization (P6, §54–§58)', () => {
  async function completeWithUsage(usage: Record<string, unknown>) {
    const fetchImpl = vi.fn(async () => sseResponse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage },
    ])) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider({ baseUrl: BASE, fetchImpl })
    return provider.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  }

  it('§54 OpenAI cached_tokens → cacheReadTokens; legacy fields derive from usage', async () => {
    const result = await completeWithUsage({
      prompt_tokens: 12_000,
      completion_tokens: 1_000,
      prompt_tokens_details: { cached_tokens: 8_000 },
    })
    expect(result.usage).toEqual({ inputTokens: 12_000, outputTokens: 1_000, cacheReadTokens: 8_000 })
    expect(result.contextTokensUsed).toBe(13_000)
    expect(result.cacheHitRate).toBeCloseTo(0.666667, 5)
    expect(result.usage?.cacheWriteTokens).toBeUndefined()
  })

  it('§55 reasoning_tokens are recorded but NOT re-added to the total', async () => {
    const result = await completeWithUsage({
      prompt_tokens: 12_000,
      completion_tokens: 1_000,
      completion_tokens_details: { reasoning_tokens: 500 },
    })
    expect(result.usage?.reasoningTokens).toBe(500)
    // completion already includes reasoning → total stays input+output.
    expect(result.contextTokensUsed).toBe(13_000)
  })

  it('§56 DeepSeek hit/miss split: hit → cacheReadTokens; miss is NOT a cache write', async () => {
    const result = await completeWithUsage({
      prompt_tokens: 10_000,
      completion_tokens: 1_000,
      prompt_cache_hit_tokens: 7_000,
      prompt_cache_miss_tokens: 3_000,
    })
    expect(result.usage).toEqual({ inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 7_000 })
    expect(result.usage?.cacheWriteTokens).toBeUndefined()
    expect(result.cacheHitRate).toBeCloseTo(0.7, 5)
  })

  it('§57 no cache fields → cacheReadTokens undefined + cacheHitRate undefined (≠ 0)', async () => {
    const result = await completeWithUsage({ prompt_tokens: 10_000, completion_tokens: 1_000 })
    expect(result.usage).toEqual({ inputTokens: 10_000, outputTokens: 1_000 })
    expect(result.usage?.cacheReadTokens).toBeUndefined()
    expect(result.cacheHitRate).toBeUndefined()
  })

  it('§58 reported cached_tokens=0 stays 0 — distinct from unreported', async () => {
    const result = await completeWithUsage({
      prompt_tokens: 10_000,
      completion_tokens: 1_000,
      prompt_tokens_details: { cached_tokens: 0 },
    })
    expect(result.usage?.cacheReadTokens).toBe(0)
    expect(result.cacheHitRate).toBe(0)
  })

  it('a stream with no usage line at all reports no usage (≠ zeros)', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      { choices: [{ delta: { content: 'ok' } }] },
    ])) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider({ baseUrl: BASE, fetchImpl })
    const result = await provider.complete({ model: 'm', messages: [] })
    expect(result.usage).toBeUndefined()
    expect(result.contextTokensUsed).toBe(0)
    expect(result.cacheHitRate).toBeUndefined()
  })
})
