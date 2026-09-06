import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, DEFAULT_RUNTIME_SETTINGS, type AgentBridgeClient } from '../agentRuntime'
import { TaskManager } from '../agent/taskManager'

// Ollama ndjson helper (same wire style as agentRuntimeTask.test.ts).
function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  return new Response(chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

const textTurn = (content: string) => ndjsonResponse([
  { message: { role: 'assistant', content }, prompt_eval_count: 20, eval_count: 1 },
])

const PLAN_TOOL = 'curi_emit_task_plan'
const VERIFY_TOOL = 'curi_emit_task_verification'

const internalTurn = (name: string, args: Record<string, unknown>) => ndjsonResponse([
  {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `internal-${Math.random().toString(36).slice(2, 8)}`,
        function: { index: 0, name, arguments: args },
      }],
    },
    prompt_eval_count: 5,
    eval_count: 0,
  },
])

const FULL_PLAN = {
  needsTask: true,
  objective: '找出全部 Pump 中 Location 为空的构件',
  completionCriteria: ['所有 Pump 均已读取 Location 属性'],
  steps: [
    { title: '搜索全部 Pump', completionCriteria: ['搜索返回全部目标'] },
  ],
}

/** The main answer + full task-system scaffolding: one tool round, then the
 * final text that triggers the completion gate. */
function makeTaskHarness(options: {
  verify: (requestInit: { body: string; signal?: AbortSignal }) => Response | Promise<Response>
}) {
  const bodies: Array<Record<string, unknown>> = []
  const events: Array<Record<string, unknown>> = []
  let index = 0
  const fetchImpl = vi.fn(async (url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    bodies.push(body)
    const tools = JSON.stringify(body.tools ?? [])
    let response: Response | Promise<Response>
    if (tools.includes(PLAN_TOOL)) {
      response = internalTurn(PLAN_TOOL, FULL_PLAN)
    } else if (tools.includes(VERIFY_TOOL)) {
      response = options.verify({ body: String(init?.body ?? '{}'), signal: init?.signal })
    } else {
      // Round 1: a tool call; round 2: the final answer (enters the gate).
      response = index === 0
        ? ndjsonResponse([{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call-1', function: { index: 0, name: 'navisworks_status', arguments: '{}' } }],
            },
            prompt_eval_count: 10,
            eval_count: 0,
          }])
        : textTurn('任务回答已经生成完毕。')
    }
    index += 1
    return response
  }) as unknown as typeof fetch
  const onEvent = (event: Record<string, unknown>): void => { events.push(event) }
  return { bodies, events, onEvent, fetchImpl, fetchCount: () => index }
}

const bridge: AgentBridgeClient = {
  async call<T>() {
    return { connected: true } as T
  },
}

describe('chat run lifecycle — terminal states (Cases 1–4)', () => {
  it('Case 1: a plain chat finishes with the answer and no lingering run state', async () => {
    let index = 0
    const fetchImpl = vi.fn(async () => {
      index += 1
      return textTurn('普通回答。')
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl })
    const result = await runtime.run({ sessionId: 's-plain', text: '你好' })
    expect(result.isSuccess).toBe(true)
    expect(result.message).toBe('普通回答。')
    expect(index).toBe(1)
  })

  it('Case 2: multi-step task emits a verifying phase, then completes with done semantics', async () => {
    const harness = makeTaskHarness({
      verify: () => internalTurn(VERIFY_TOOL, { verdict: 'complete', reason: '所有条件均有证据支持' }),
    })
    const taskManager = new TaskManager()
    const runtime = new AgentRuntime({
      bridgeClient: bridge,
      fetchImpl: harness.fetchImpl,
      taskManager,
    })
    const result = await runtime.run(
      { sessionId: 's-phase', text: '检查所有 Pump 的 Location' },
      { onEvent: (event) => harness.onEvent(event as unknown as Record<string, unknown>) },
    )
    expect(result.isSuccess).toBe(true)
    // The renderer saw the run enter (and leave) the verifying phase.
    expect(harness.events.some((event) => event.phase === 'verifying')).toBe(true)
    const verifyIndex = harness.events.findIndex((event) => event.phase === 'verifying')
    // The final text chunk reached the user BEFORE the gate started.
    const textIndex = harness.events.findIndex((event) => event.phase === 'text')
    expect(textIndex).toBeGreaterThanOrEqual(0)
    expect(verifyIndex).toBeGreaterThan(textIndex)
    expect(taskManager.all()[0]?.status).toBe('completed')
  })

  it('Case 3: a wedged verifier times out internally, degrades, and the run returns', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const harness = makeTaskHarness({
        // Verifier calls hang forever; they only settle when the fetch signal
        // aborts — exactly how a real provider honors cancellation.
        verify: (init) => new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
        }),
      })
      const taskManager = new TaskManager()
      const runtime = new AgentRuntime({
        bridgeClient: bridge,
        fetchImpl: harness.fetchImpl,
        taskManager,
      })
      const result = await runtime.run({
        sessionId: 's-wedge',
        text: '检查所有 Pump 的 Location',
        runtimeConfig: {
          ...DEFAULT_RUNTIME_SETTINGS,
          taskCallTimeoutMs: 60,
        },
      })
      // The run ENDED — no permanent "generating". The generated answer is kept.
      expect(result.isSuccess).toBe(true)
      expect(result.message).toContain('任务回答已经生成完毕')
      expect(result.message).toContain('任务完成状态暂时无法确认')
      const task = taskManager.all()[0]!
      expect(task.status).toBe('paused')
      expect(task.pauseReason).toBe('VERIFIER_ERROR')
      // Both verifier attempts timed out and degraded.
      const verifyCalls = harness.bodies.filter((body) => JSON.stringify(body.tools ?? []).includes(VERIFY_TOOL))
      expect(verifyCalls.length).toBeGreaterThanOrEqual(2)
    } finally {
      vi.restoreAllMocks()
    }
  }, 15_000)

  it('Case 4: a verifier returning invalid structure degrades after maxAttempts', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const harness = makeTaskHarness({
        verify: () => textTurn('（模型没有调用内部验证工具）'),
      })
      const taskManager = new TaskManager()
      const runtime = new AgentRuntime({
        bridgeClient: bridge,
        fetchImpl: harness.fetchImpl,
        taskManager,
      })
      const result = await runtime.run({
        sessionId: 's-invalid',
        text: '检查所有 Pump 的 Location',
        runtimeConfig: { ...DEFAULT_RUNTIME_SETTINGS, taskCallTimeoutMs: 500 },
      })
      expect(result.isSuccess).toBe(true)
      expect(result.message).toContain('任务完成状态暂时无法确认')
      const task = taskManager.all()[0]!
      expect(task.status).toBe('paused')
      expect(task.pauseReason).toBe('VERIFIER_ERROR')
      const verifyCalls = harness.bodies.filter((body) => JSON.stringify(body.tools ?? []).includes(VERIFY_TOOL))
      expect(verifyCalls).toHaveLength(2)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
