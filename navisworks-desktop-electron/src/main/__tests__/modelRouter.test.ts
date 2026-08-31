import { describe, expect, it, vi } from 'vitest'
import { LOCAL_OLLAMA_BASE_URL, ModelRouter } from '../model/modelRouter'

describe('ModelRouter', () => {
  it('routes normal completions to the local Ollama daemon', async () => {
    let requestedUrl = ''
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url)
      expect(init?.method).toBe('POST')
      expect(String(init?.body)).toContain('"stream":true')
      return new Response(`${JSON.stringify({ message: { role: 'assistant', content: 'ok' } })}\n`, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }) as unknown as typeof fetch
    const router = new ModelRouter({ fetchImpl })

    const provider = router.local()
    expect(provider.kind).toBe('ollama')
    const result = await provider.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(requestedUrl).toBe(`${LOCAL_OLLAMA_BASE_URL}/api/chat`)
    expect(result.content).toBe('ok')
  })

  it('forEndpoint maps each kind to its provider', () => {
    const router = new ModelRouter()
    expect(router.forEndpoint({ kind: 'ollama' }).kind).toBe('ollama')
    expect(router.forEndpoint({ kind: 'openai', baseUrl: 'https://x/v1' }).kind).toBe('openai')
  })
})
