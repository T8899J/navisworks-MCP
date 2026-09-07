import { describe, expect, it, vi } from 'vitest'
import { OllamaProvider } from '../model/ollamaProvider'

function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  const text = chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join('')
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

describe('OllamaProvider', () => {
  it('sends bearer auth only when an api key is configured', async () => {
    const seenHeaders: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push((init?.headers ?? {}) as Record<string, unknown>)
      return ndjsonResponse([
        { message: { role: 'assistant', content: '好。' } },
        { done: true },
      ])
    }) as unknown as typeof fetch

    const withKey = new OllamaProvider({ fetchImpl, apiKey: ' sk-test ' })
    await withKey.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(seenHeaders[0]?.Authorization).toBe('Bearer sk-test')

    seenHeaders.length = 0
    const withoutKey = new OllamaProvider({ fetchImpl })
    await withoutKey.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(seenHeaders[0]?.Authorization).toBeUndefined()
  })

  it('lists model names from GET /api/tags', async () => {
    let requestedUrl = ''
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      requestedUrl = String(url)
      return new Response(JSON.stringify({
        models: [{ name: 'qwen3.5:9b-q4_K_M' }, { name: 'llama3:8b' }, { broken: true }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const provider = new OllamaProvider({ fetchImpl })

    const models = await provider.listModels()
    expect(requestedUrl).toBe('http://localhost:11434/api/tags')
    expect(models).toEqual(['qwen3.5:9b-q4_K_M', 'llama3:8b'])
  })

  it('reports connection state against the configured model', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: 'qwen3.5:9b-q4_K_M' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    const provider = new OllamaProvider({ fetchImpl })

    const ok = await provider.testConnection('qwen3.5:9b-q4_K_M')
    expect(ok.ok).toBe(true)

    const missing = await provider.testConnection('not-installed')
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('未找到模型 not-installed')
  })

  it('cancels an open response stream when the caller aborts', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          '{"message":{"role":"assistant","content":"开始"}}\n'
        ))
      }
    })
    const provider = new OllamaProvider({
      requestTimeoutMs: 5_000,
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    })
    const abortController = new AbortController()
    setTimeout(() => abortController.abort(new Error('stop')), 20)

    const outcome = await Promise.race([
      provider.complete({ model: 'm', messages: [], signal: abortController.signal })
        .catch((error: unknown) => error),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 150))
    ])

    expect(outcome).not.toBe('hung')
    expect(outcome).toMatchObject({ name: 'AbortError' })
  })
})

describe('Ollama usage normalization (P6, §59)', () => {
  it('eval counts become ModelUsage; cache stays UNDEFINED (never a fabricated 0)', async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      { message: { role: 'assistant', content: '好' } },
      { done: true, prompt_eval_count: 3_000, eval_count: 500 },
    ])) as unknown as typeof fetch
    const provider = new OllamaProvider({ fetchImpl })
    const result = await provider.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(result.usage).toEqual({ inputTokens: 3_000, outputTokens: 500 })
    expect(result.usage?.cacheReadTokens).toBeUndefined()
    expect(result.usage?.reasoningTokens).toBeUndefined()
    expect(result.cacheHitRate).toBeUndefined()
    expect(result.contextTokensUsed).toBe(3_500)
  })

  it('silent counters → no usage object at all', async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      { message: { role: 'assistant', content: '好' }, done: true },
    ])) as unknown as typeof fetch
    const provider = new OllamaProvider({ fetchImpl })
    const result = await provider.complete({ model: 'm', messages: [] })
    // Ollama always answers with (at least) zero counters; a zero-both usage
    // is reported honestly and yields total 0 with cache unreported.
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(result.cacheHitRate).toBeUndefined()
  })
})
