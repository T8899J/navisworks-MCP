import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, type AgentBridgeClient } from '../agentRuntime'
import { CURI_CORE_PROMPT, NAVISWORKS_CAPABILITY_PROMPT } from '../agent/prompts'

/** Builds a fetch response whose body is the ndjson stream Ollama actually sends. */
function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  const text = chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join('')
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

function toolMessageContent(body?: Record<string, unknown>): string {
  const messages = body?.messages
  if (!Array.isArray(messages)) return ''
  const toolMessage = messages.find((message) => (
    typeof message === 'object'
    && message !== null
    && 'role' in message
    && message.role === 'tool'
  ))
  return typeof toolMessage === 'object'
    && toolMessage !== null
    && 'content' in toolMessage
    && typeof toolMessage.content === 'string'
    ? toolMessage.content
    : ''
}

describe('AgentRuntime streaming tool loop', () => {
  it('sends core and capability prompts before dynamic context and the current turn', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ndjsonResponse([
        { message: { role: 'assistant', content: '收到。' }, prompt_eval_count: 10, eval_count: 2 },
      ])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      bridgeClient: { async call<T>() { return { connected: true } as T } },
      fetchImpl,
    })

    await runtime.run({
      text: '继续检查',
      currentDocument: {
        connected: true,
        documentName: 'Current.nwf',
        documentInstanceId: 'doc-current',
      },
      documentNotice: {
        revision: 1,
        previous: { documentName: 'Previous.nwf', documentInstanceId: 'doc-previous' },
        current: { documentName: 'Current.nwf', documentInstanceId: 'doc-current' },
        changedAt: 1,
        reason: 'document-changed',
      },
      semanticMemory: {
        goals: ['核对当前模型'],
        constraints: [],
        decisions: [],
        notes: [],
        updatedAt: 1,
      },
      compactSummary: '此前已完成准备工作',
    })

    const messages = requestBodies[0]?.messages as Array<{ role: string; content: string }>
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'system',
      'system',
      'system',
      'system',
      'system',
      'user',
    ])
    expect(messages[0]?.content).toBe(CURI_CORE_PROMPT)
    expect(messages[1]?.content).toBe(NAVISWORKS_CAPABILITY_PROMPT)
    expect(messages[2]?.content).toContain('【当前 Navisworks 文档】')
    expect(messages[3]?.content).toContain('【Navisworks 当前环境发生变化】')
    expect(messages[4]?.content).toContain('【会话语义记忆')
    expect(messages[5]?.content).toContain('此前已完成准备工作')
    expect(messages[6]?.content).toBe('继续检查')
  })

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
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    const result = await runtime.run('检查连接', {
      onEvent: (event) => events.push(event.phase === 'started' || event.phase === 'completed'
        ? `${event.phase}:${event.tool}`
        : `${event.phase}:${event.delta}`),
    })

    expect(result).toEqual({
      isSuccess: true,
      message: 'Navisworks 已连接。',
      contextTokensUsed: 38,
      // No contextWindow was configured, so the local clamp's ceiling is the
      // budget this run reported back for the UI's usage ring.
      contextWindowTokens: 32768,
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
    const observation = JSON.parse(toolMessageContent(requestBodies[1])) as Record<string, unknown>
    expect(observation).toMatchObject({
      status: 'success',
      tool: 'navisworks_status',
      summary: 'Navisworks 已连接。',
      next_actions: [],
      artifacts: [],
    })
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
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    const result = await runtime.run('你好', {
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
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    const result = await runtime.run('看状态和文档')
    expect(result.isSuccess).toBe(false)
    expect(result.errorCode).toBe('MODEL_EMPTY_RESPONSE')
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
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    const result = await runtime.run('运行脚本')
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
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    const result = await runtime.run('查属性')
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
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    const result = await runtime.run({ text: '隐藏构件', disabledTools: ['navisworks_set_visibility'] })

    const tools = (requestBodies[0]?.tools ?? []) as Array<{ function: { name: string } }>
    expect(tools.some((tool) => tool.function.name === 'navisworks_set_visibility')).toBe(false)
    expect(tools.length).toBeGreaterThan(0) // the other eight are still offered
    expect(bridgeCalls).toEqual([]) // the disabled call never reached the bridge
    expect(JSON.stringify(requestBodies[1])).toContain('工具已被用户禁用')
    expect(JSON.stringify(requestBodies[1])).toContain('改用允许列表中的最小必要工具')
    expect(result.isSuccess).toBe(true)
  })

  it('does not execute a view-state tool until the approval callback confirms it', async () => {
    const bridgeCall = vi.fn()
    const makeRuntime = (decision: boolean) => {
      const replies = [
        ndjsonResponse([{ message: { role: 'assistant', content: '', tool_calls: [
          { function: { name: 'navisworks_set_visibility', arguments: { action: 'hide', itemIds: ['1'] } } },
        ] } }]),
        ndjsonResponse([{ message: { role: 'assistant', content: '操作已处理。' } }]),
      ]
      const runtime = new AgentRuntime({
        bridgeClient: {
          async call<T>(method: string, parameters?: Record<string, unknown>) {
            bridgeCall(method, parameters)
            return { hidden: 1 } as T
          },
        },
        fetchImpl: vi.fn(async () => replies.shift() as Response) as unknown as typeof fetch,
      })
      return runtime.run('隐藏构件', {
        requestToolApproval: async () => decision,
      })
    }

    await expect(makeRuntime(false)).resolves.toMatchObject({ isSuccess: true })
    expect(bridgeCall).not.toHaveBeenCalled()

    await expect(makeRuntime(true)).resolves.toMatchObject({ isSuccess: true })
    expect(bridgeCall).toHaveBeenCalledTimes(1)
  })

  it('propagates caller cancellation as AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    const runtime = new AgentRuntime({
      bridgeClient: { call: vi.fn() },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    await expect(runtime.run('检查连接', { signal: controller.signal })).rejects.toEqual(
      expect.objectContaining({ name: 'AbortError' }),
    )
  })

  it('caps the local context window at 32K when building num_ctx', async () => {
    const bridge: AgentBridgeClient = { async call<T>() { return undefined as T } }
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ndjsonResponse([
        { message: { role: 'assistant', content: '好。' }, prompt_eval_count: 1, eval_count: 1 },
      ])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl, contextWindow: 65536 })

    await runtime.run('你好')

    const options = requestBodies[0]?.options as Record<string, unknown>
    expect(options.num_ctx).toBe(32768)
  })

  it('auto-compacts older rounds when usage crosses 90% of the window', async () => {
    const bridgeCalls: string[] = []
    const bridge: AgentBridgeClient = {
      async call(method) {
        bridgeCalls.push(method)
        return { marker: `结果${bridgeCalls.length}` } as never
      },
    }
    // Window 1024 → trigger at 90% = 921.6 tokens of usage. Three tool rounds
    // with big usage push past it; the fourth response is the final answer.
    const toolCallChunk = (usage: number) => ndjsonResponse([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'navisworks_status', arguments: {} } }],
        },
        prompt_eval_count: usage,
        eval_count: 0,
      },
    ])
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const calls = requestBodies.length
      if (calls <= 3) return toolCallChunk(calls === 1 ? 450 : 1000)
      // Compaction summarizer call (4th) — the compact summary text.
      return ndjsonResponse([
        { message: { role: 'assistant', content: '已完成第一、二轮；第三轮进行中。' } },
      ])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl, contextWindow: 1024 })

    const result = await runtime.run('第一步：检查一个')

    expect(result.isSuccess).toBe(true)
    expect(result.compacted).toBe(true)
    // 5th request = the final answer round, AFTER compaction: the summary
    // replaced the early rounds.
    const answerMessages = JSON.stringify(requestBodies[4]?.messages)
    expect(answerMessages).toContain('压缩摘要')
    expect(answerMessages).toContain('已完成第一、二轮')
    // The active user instruction is never summarized away.
    expect(answerMessages).toContain('第一步')
    // The latest complete tool exchange stays verbatim for live references.
    expect(answerMessages).toContain('结果3')
  })

  it('keeps automatic and manual compaction local without an API endpoint', async () => {
    let localCalls = 0
    const toolCallChunk = () => ndjsonResponse([{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'navisworks_status', arguments: {} } }],
      },
      prompt_eval_count: 1000,
      eval_count: 0,
    }])
    const fetchImpl = vi.fn(async () => {
      localCalls += 1
      if (localCalls <= 3) return toolCallChunk()
      return ndjsonResponse([{
        message: {
          role: 'assistant',
          content: localCalls === 4 ? '本地压缩摘要' : '本地最终回答',
        },
        prompt_eval_count: 10,
        eval_count: 2,
      }])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      bridgeClient: { async call<T>() { return { ok: true } as T } },
      contextWindow: 1024,
      fetchImpl,
    })
    const automatic = await runtime.run({ text: '只在本地执行' })
    const manual = await runtime.compactConversation(
      [{ role: 'user', content: '不要上传这段会话' }],
      { model: 'local-model' },
    )

    expect(automatic.compacted).toBe(true)
    expect(manual).toBe('本地最终回答')
  })

  it('compacts local runs against the clamped 32K num_ctx, not the raw configured window', async () => {
    // Drive `rounds` tool-call responses (each pushing usage to 30000) and then a plain
    // text answer. The bridge call itself also returns a valid tool result.
    const scripted = (rounds: number, usage: number, reply: string) => {
      const bridge: AgentBridgeClient = { async call<T>() { return { connected: true } as T } }
      let calls = 0
      const fetchImpl = vi.fn(async () => {
        calls += 1
        if (calls <= rounds) {
          return ndjsonResponse([{
            message: {
              role: 'assistant', content: '',
              tool_calls: [{ function: { name: 'navisworks_status', arguments: {} } }],
            },
            prompt_eval_count: usage, eval_count: 0,
          }])
        }
        return ndjsonResponse([
          { message: { role: 'assistant', content: reply }, prompt_eval_count: usage, eval_count: 1 },
        ])
      }) as unknown as typeof fetch
      return { bridge, fetchImpl }
    }

    // Window 65536 is clamped to num_ctx 32768 → trigger 0.9*32768 = 29491.
    // Usage 30000 is above the clamped trigger but far below 0.9*65536 = 58982,
    // so only a run that compares against the CLAMPED window will compact here.
    const clamped = scripted(5, 30_000, '最终回答。')
    const compactedResult = await new AgentRuntime({
      bridgeClient: clamped.bridge, fetchImpl: clamped.fetchImpl, contextWindow: 65_536,
    }).run('多轮查询')
    expect(compactedResult.compacted).toBe(true)

    // Negative control: identical script with usage BELOW even the clamped trigger must
    // NOT compact — proving the previous assertion reflects the window policy, not a
    // size effect from the five rounds themselves.
    const below = scripted(5, 10_000, '最终回答。')
    const untouchedResult = await new AgentRuntime({
      bridgeClient: below.bridge, fetchImpl: below.fetchImpl, contextWindow: 65_536,
    }).run('多轮查询')
    expect(untouchedResult.compacted).toBeUndefined()
  })

  it('adds a structural digest to a truncated oversized tool result', async () => {
    const bigItems = Array.from({ length: 200 }, (_, i) => ({ id: `id${i}`, name: `泵体-${i}` }))
    const bridge: AgentBridgeClient = {
      async call<T>() { return { items: bigItems, total: 300, truncated: true } as T },
    }
    const bodies: Array<Record<string, unknown>> = []
    let round = 0
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      round += 1
      if (round === 1) {
        return ndjsonResponse([{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'c1', function: { index: 0, name: 'navisworks_find_items', arguments: { query: '泵' } } },
        ] }, prompt_eval_count: 10, eval_count: 0 }])
      }
      return ndjsonResponse([{ message: { role: 'assistant', content: '完成。' }, prompt_eval_count: 20, eval_count: 1 }])
    }) as unknown as typeof fetch
    await new AgentRuntime({ bridgeClient: bridge, fetchImpl }).run('查大量构件')
    const toolMessage = toolMessageContent(bodies[1])
    // The oversized wire result was sliced, but the notice still reports the item count and
    // that the full payload remains locally recallable (P3-C: not a blind slice).
    expect(toolMessage).toContain('结构：items=200')
    expect(toolMessage).toContain('完整结果仍保留在本地')
    expect(toolMessage).toContain('搜索完成：返回 200 个构件，共 300 个，结果尚未完整。')
    expect(toolMessage).toContain('使用完全相同的搜索参数继续调用 navisworks_find_items')
    expect(toolMessage).toContain('"artifacts":["id0","id1"')
  })

  it('maps the reasoning effort onto the local think flag', async () => {
    const bridge: AgentBridgeClient = {
      async call<T>() { return { connected: true, hasDocument: true } as T },
    }
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return ndjsonResponse([
        { message: { role: 'assistant', content: '答。' }, done: true, prompt_eval_count: 10, eval_count: 2 },
      ])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    await runtime.run({ text: '你好', reasoningMode: 'max' })
    await runtime.run({ text: '你好', reasoningMode: 'low' })

    expect(bodies[0]?.think).toBe(true)
    expect(bodies[1]?.think).toBe(false)
  })

  it('sends the reasoning effort verbatim on API runs', async () => {
    const bridge: AgentBridgeClient = {
      async call<T>() { return { connected: true, hasDocument: true } as T },
    }
    const urls: string[] = []
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url))
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        'data: {"choices":[{"delta":{"content":"云端回答"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })

    const result = await runtime.run({
      text: '你好',
      reasoningMode: 'xhigh',
      api: { baseUrl: 'https://cloud.example.com/v1', model: 'qwen-plus' },
    })

    expect(result.isSuccess).toBe(true)
    expect(urls[0]).toBe('https://cloud.example.com/v1/chat/completions')
    expect(bodies[0]?.reasoning_effort).toBe('xhigh')
    // The OpenAI wire never carries Ollama's think flag.
    expect(bodies[0]).not.toHaveProperty('think')
  })
})
