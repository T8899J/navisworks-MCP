import { describe, expect, it, vi } from 'vitest'
import { OllamaAgent, type AgentBridgeClient } from '../ollamaAgent'

/** Builds a fetch response whose body is the ndjson stream Ollama actually sends. */
function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  const text = chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join('')
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

describe('Ollama streaming tool loop', () => {
  it('executes an allowed tool then returns the second-round answer', async () => {
    let bridgeCalls = 0
    const bridge: AgentBridgeClient = {
      async call<T>() {
        bridgeCalls += 1
        return { connected: true, hasDocument: true } as T
      },
    }
    const requestBodies: Array<Record<string, unknown>> = []
    const replies = [
      ndjsonResponse([
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call-1',
              function: { index: 0, name: 'navisworks_status', arguments: {} },
            }],
          },
          prompt_eval_count: 20,
          eval_count: 5,
        },
      ]),
      ndjsonResponse([
        { message: { role: 'assistant', content: 'Navisworks ' } },
        { message: { role: 'assistant', content: '已连接。' } },
        { done: true, prompt_eval_count: 30, eval_count: 8 },
      ]),
    ]
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return replies.shift() as unknown as Response
    }) as unknown as typeof fetch
    const events: string[] = []
    const agent = new OllamaAgent({ bridgeClient: bridge, fetchImpl })

    const result = await agent.run('检查连接', {
      onEvent: (event) => events.push(event.phase === 'started' || event.phase === 'completed'
        ? `${event.phase}:${event.tool}`
        : `${event.phase}:${event.delta}`),
    })

    expect(result).toEqual({
      isSuccess: true,
      message: 'Navisworks 已连接。',
      contextTokensUsed: 38,
    })
    expect(bridgeCalls).toBe(1)
    expect(events).toEqual([
      'started:navisworks_status',
      'completed:navisworks_status',
      'text:Navisworks ',
      'text:已连接。',
    ])
    expect(requestBodies).toHaveLength(2)
    expect(requestBodies[0]?.stream).toBe(true)
    expect(JSON.stringify(requestBodies[1])).toContain('"role":"tool"')
  })

  it('forwards thinking deltas and returns the accumulated thinking text', async () => {
    const bridge: AgentBridgeClient = { async call<T>() { return undefined as T } }
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      { message: { role: 'assistant', thinking: '先想' } },
      { message: { role: 'assistant', thinking: '一步。' } },
      { message: { role: 'assistant', content: '答案。' } },
      { done: true, prompt_eval_count: 10, eval_count: 6 },
    ])) as unknown as typeof fetch
    const deltas: string[] = []
    const agent = new OllamaAgent({ bridgeClient: bridge, fetchImpl })

    const result = await agent.run('你好', {
      onEvent: (event) => {
        if (event.phase === 'thinking' || event.phase === 'text') deltas.push(`${event.phase}:${event.delta}`)
      },
    })

    expect(result.isSuccess).toBe(true)
    expect(result.thinkingText).toBe('先想一步。')
    expect(deltas).toEqual(['thinking:先想', 'thinking:一步。', 'text:答案。'])
  })

  it('merges tool_calls that arrive in separate stream chunks', async () => {
    const bridgeCalls: string[] = []
    const bridge: AgentBridgeClient = {
      async call(method) {
        bridgeCalls.push(method)
        return {} as never
      },
    }
    let chatResponses = 0
    const fetchImpl = vi.fn(async () => {
      chatResponses += 1
      if (chatResponses === 1) {
        return ndjsonResponse([
          { message: { role: 'assistant', content: '', tool_calls: [
            { id: 'call-1', function: { index: 0, name: 'navisworks_status', arguments: {} } },
          ] } },
          { message: { role: 'assistant', content: '', tool_calls: [
            { id: 'call-2', function: { index: 1, name: 'navisworks_get_document', arguments: {} } },
          ] } },
          { done: true },
        ])
      }
      // Second round: nothing left to say → the empty-response guard stops the run.
      return ndjsonResponse([{ done: true, prompt_eval_count: 5, eval_count: 0 }])
    }) as unknown as typeof fetch
    const agent = new OllamaAgent({ bridgeClient: bridge, fetchImpl })

    const result = await agent.run('看状态和文档')
    expect(result.isSuccess).toBe(false)
    expect(result.errorCode).toBe('OLLAMA_EMPTY_RESPONSE')
    expect(bridgeCalls).toEqual(['navisworks_status', 'navisworks_get_document'])
  })

  it('does not execute an unknown model-supplied tool', async () => {
    let bridgeCalls = 0
    const bridge: AgentBridgeClient = {
      async call<T>() {
        bridgeCalls += 1
        return undefined as T
      },
    }
    const replies = [
      ndjsonResponse([
        { message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'run_powershell', arguments: {} } }],
        } },
      ]),
      ndjsonResponse([{ message: { role: 'assistant', content: '该工具不可用。' } }]),
    ]
    const fetchImpl = vi.fn(async () => replies.shift() as unknown as Response) as unknown as typeof fetch
    const agent = new OllamaAgent({ bridgeClient: bridge, fetchImpl })

    const result = await agent.run('运行脚本')
    expect(result.isSuccess).toBe(true)
    expect(bridgeCalls).toBe(0)
  })

  it('drops empty optional string arguments before the bridge call', async () => {
    const received: Array<Record<string, unknown>> = []
    const bridge: AgentBridgeClient = {
      async call(_method, parameters) {
        received.push(parameters ?? {})
        return { items: [] } as never
      },
    }
    let round = 0
    const fetchImpl = vi.fn(async () => {
      round += 1
      if (round === 1) {
        return ndjsonResponse([
          { message: { role: 'assistant', content: '', tool_calls: [
            { function: { name: 'navisworks_get_item_properties', arguments: {
              itemIds: ['item-2-59'],
              category: '',
              property: '',
            } } },
          ] } },
          { done: true },
        ])
      }
      return ndjsonResponse([
        { message: { role: 'assistant', content: '查到了。' } },
        { done: true },
      ])
    }) as unknown as typeof fetch
    const agent = new OllamaAgent({ bridgeClient: bridge, fetchImpl })

    const result = await agent.run('查属性')
    expect(result.isSuccess).toBe(true)
    expect(received[0]).toEqual({ itemIds: ['item-2-59'] })
  })

  it('omits disabled tools from the request and rejects model calls to them', async () => {
    const bridgeCalls: string[] = []
    const bridge: AgentBridgeClient = {
      async call(method) {
        bridgeCalls.push(method)
        return {} as never
      },
    }
    const requestBodies: Array<Record<string, unknown>> = []
    let round = 0
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      round += 1
      if (round === 1) {
        return ndjsonResponse([
          { message: { role: 'assistant', content: '', tool_calls: [
            { function: { name: 'navisworks_set_visibility', arguments: { action: 'hide' } } },
          ] } },
          { done: true },
        ])
      }
      return ndjsonResponse([
        { message: { role: 'assistant', content: '该操作在只读模式下不可用。' } },
        { done: true },
      ])
    }) as unknown as typeof fetch
    const agent = new OllamaAgent({
      bridgeClient: bridge,
      fetchImpl,
      disabledTools: ['navisworks_set_visibility'],
    })

    const result = await agent.run('隐藏构件')

    const tools = (requestBodies[0]?.tools ?? []) as Array<{ function: { name: string } }>
    expect(tools.some((tool) => tool.function.name === 'navisworks_set_visibility')).toBe(false)
    expect(tools.length).toBeGreaterThan(0) // the other eight are still offered
    expect(bridgeCalls).toEqual([]) // the disabled call never reached the bridge
    expect(JSON.stringify(requestBodies[1])).toContain('工具已被用户禁用')
    expect(result.isSuccess).toBe(true)
  })

  it('sends bearer auth only when an api key is configured', async () => {
    const bridge: AgentBridgeClient = { async call<T>() { return undefined as T } }
    const seenHeaders: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push((init?.headers ?? {}) as Record<string, unknown>)
      return ndjsonResponse([
        { message: { role: 'assistant', content: '好。' } },
        { done: true },
      ])
    }) as unknown as typeof fetch

    const withKey = new OllamaAgent({ bridgeClient: bridge, fetchImpl, apiKey: ' sk-test ' })
    await withKey.run('你好')
    expect(seenHeaders[0]?.Authorization).toBe('Bearer sk-test')

    seenHeaders.length = 0
    const withoutKey = new OllamaAgent({ bridgeClient: bridge, fetchImpl })
    await withoutKey.run('你好')
    expect(seenHeaders[0]?.Authorization).toBeUndefined()
  })

  it('propagates caller cancellation as AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    const agent = new OllamaAgent({
      bridgeClient: { call: vi.fn() },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    await expect(agent.run('检查连接', { signal: controller.signal })).rejects.toEqual(
      expect.objectContaining({ name: 'AbortError' }),
    )
  })
})
