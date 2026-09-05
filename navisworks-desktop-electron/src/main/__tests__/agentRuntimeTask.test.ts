import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, type AgentBridgeClient } from '../agentRuntime'
import { TaskManager } from '../agent/taskManager'

// Ollama ndjson wire helpers (same pattern as agentRuntimeP5.test.ts).
function ndjsonResponse(chunks: Array<Record<string, unknown>>): Response {
  return new Response(chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

const toolCallTurn = (id: string, name: string, args: Record<string, unknown>) =>
  ndjsonResponse([{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, function: { index: 0, name, arguments: args } }],
    },
    prompt_eval_count: 10,
    eval_count: 0,
  }])

const textTurn = (content: string) =>
  ndjsonResponse([{ message: { role: 'assistant', content }, prompt_eval_count: 20, eval_count: 1 }])

const internalTurn = (name: string, args: Record<string, unknown>) =>
  ndjsonResponse([{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `internal-${Math.random().toString(36).slice(2, 8)}`, function: { index: 0, name, arguments: args } }],
    },
    prompt_eval_count: 5,
    eval_count: 0,
  }])

const PLAN_TOOL = 'curi_emit_task_plan'
const VERIFY_TOOL = 'curi_emit_task_verification'

const FULL_PLAN = {
  needsTask: true,
  objective: '找出全部 Pump 中 Location 为空的构件并汇总名称',
  completionCriteria: ['目标搜索结果完整 truncated=false', '所有 Pump 均已读取 Location 属性', '空 Location 项均有构件名称'],
  steps: [
    { title: '搜索全部 Pump', completionCriteria: ['搜索返回全部目标'] },
    { title: '读取所有目标 Location', completionCriteria: ['每个目标均有读取记录'] },
  ],
}

const FIND_RESULT = { items: [{ id: 'i1' }, { id: 'i2' }], total: 86, truncated: false }

function makeHarness(responses: Response[]) {
  const bodies: Array<Record<string, unknown>> = []
  let index = 0
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    return response
  }) as unknown as typeof fetch
  const internalCalls = (name: string): number => bodies.filter(
    (body) => JSON.stringify(body.tools ?? []).includes(name),
  ).length
  return { fetchImpl, bodies, internalCalls, requestCount: () => index }
}

const bridge = {
  async call<T>(method: string) {
    if (method === 'navisworks_find_items') return FIND_RESULT as T
    if (method === 'navisworks_get_item_properties') return { items: [{ id: 'i1', properties: { Location: '' } }] } as T
    return { ok: true } as T
  },
} as unknown as AgentBridgeClient

describe('Task runtime integration — off path', () => {
  it('plain chat never triggers the planner and creates no task', async () => {
    const harness = makeHarness([textTurn('你好，我是 Curi。')])
    const taskManager = new TaskManager()
    const runtime = new AgentRuntime({
      bridgeClient: bridge,
      fetchImpl: harness.fetchImpl,
      taskManager,
    })
    const result = await runtime.run({ sessionId: 'session-plain', text: '你好' })
    expect(result.isSuccess).toBe(true)
    expect(harness.requestCount()).toBe(1)
    expect(harness.internalCalls(PLAN_TOOL)).toBe(0)
    expect(taskManager.all()).toEqual([])
  })

  it('runs exactly as before when no TaskManager is configured', async () => {
    const harness = makeHarness([
      toolCallTurn('call-1', 'navisworks_find_items', { query: 'Pump' }),
      textTurn('共找到 2 个构件。'),
    ])
    const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl: harness.fetchImpl })
    const result = await runtime.run({ sessionId: 'session-legacy', text: '查一下 Pump' })
    expect(result.isSuccess).toBe(true)
    expect(harness.internalCalls(PLAN_TOOL)).toBe(0)
  })

  it('a simple single-step tool call with needsTask=false creates no task', async () => {
    const harness = makeHarness([
      toolCallTurn('call-1', 'navisworks_find_items', { query: 'Pump' }),
      internalTurn(PLAN_TOOL, { needsTask: false }),
      textTurn('当前搜索到 2 个构件。'),
    ])
    const taskManager = new TaskManager()
    const runtime = new AgentRuntime({
      bridgeClient: bridge,
      fetchImpl: harness.fetchImpl,
      taskManager,
    })
    const result = await runtime.run({ sessionId: 'session-simple', text: '查一下 Pump' })
    expect(result.isSuccess).toBe(true)
    // The planner ran once and declined; no task, no verifier.
    expect(harness.internalCalls(PLAN_TOOL)).toBe(1)
    expect(harness.internalCalls(VERIFY_TOOL)).toBe(0)
    expect(taskManager.all()).toEqual([])
  })
})

describe('Task runtime integration — full loop', () => {
  it('multi-step task: plan → evidence → verify → complete before answering', async () => {
    const harness = makeHarness([
      toolCallTurn('call-1', 'navisworks_find_items', { query: 'Pump' }),
      internalTurn(PLAN_TOOL, FULL_PLAN),
      textTurn('初步结果：搜索到目标。'),
      internalTurn(VERIFY_TOOL, {
        verdict: 'complete',
        reason: '目标 86，已检查并读取 Location，异常项均有名称与证据',
        stepUpdates: [{ stepId: '1', status: 'completed' }],
      }),
    ])
    const taskManager = new TaskManager()
    const runtime = new AgentRuntime({
      bridgeClient: bridge,
      fetchImpl: harness.fetchImpl,
      taskManager,
    })
    const result = await runtime.run({ sessionId: 'session-task', text: '检查所有 Pump 的 Location' })
    expect(result.isSuccess).toBe(true)
    // One plan call, one verify call.
    expect(harness.internalCalls(PLAN_TOOL)).toBe(1)
    expect(harness.internalCalls(VERIFY_TOOL)).toBe(1)
    const tasks = taskManager.all()
    expect(tasks).toHaveLength(1)
    const task = tasks[0]!
    expect(task.status).toBe('completed')
    expect(task.objective).toContain('Pump')
    expect(task.completedAt).toBeTypeOf('number')
    // find_items result became evidence before completion.
    const toolEvidence = task.evidence.filter((entry) => entry.type === 'tool-result')
    expect(toolEvidence).toHaveLength(1)
    expect(toolEvidence[0]?.toolName).toBe('navisworks_find_items')
    expect(toolEvidence[0]?.summary).toContain('86')
  })

  it('the completion gate keeps the run going while criteria are unmet (continue)', async () => {
    const harness = makeHarness([
      toolCallTurn('call-1', 'navisworks_find_items', { query: 'Pump' }),
      internalTurn(PLAN_TOOL, FULL_PLAN),
      textTurn('初步找到 2 个，先汇报一下。'),
      internalTurn(VERIFY_TOOL, {
        verdict: 'continue',
        reason: '只读取了 2 个目标的属性，目标共 86 个',
        missingEvidence: ['还有 84 个构件没有读取 Location'],
        nextAction: '继续读取剩余对象',
      }),
      toolCallTurn('call-2', 'navisworks_get_item_properties', { itemIds: ['i1', 'i2'] }),
      textTurn('全部检查完成，共 86 个 Pump，其中 5 个 Location 为空。'),
      internalTurn(VERIFY_TOOL, {
        verdict: 'complete',
        reason: '目标 86，检查 86，异常 5 项均有证据',
      }),
    ])
    const taskManager = new TaskManager()
    const runtime = new AgentRuntime({
      bridgeClient: bridge,
      fetchImpl: harness.fetchImpl,
      taskManager,
    })
    const result = await runtime.run({ sessionId: 'session-continue', text: '检查所有 Pump 的 Location' })
    // The run did NOT return the premature answer: it continued tooling, then
    // completed only after the verifier accepted the final answer.
    expect(result.isSuccess).toBe(true)
    expect(result.message).toContain('全部检查完成')
    expect(harness.internalCalls(VERIFY_TOOL)).toBe(2)
    const task = taskManager.all()[0]!
    expect(task.status).toBe('completed')
    expect(task.evidence.some((entry) => entry.type === 'verification' && entry.summary.includes('还有 84 个'))).toBe(true)
  })

  it('repeated replans exhaust the budget and block the task', async () => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const harness = makeHarness([
        toolCallTurn('call-1', 'navisworks_find_items', { query: 'Pump' }),
        internalTurn(PLAN_TOOL, FULL_PLAN),
        textTurn('先按名称搜了一遍。'),
        internalTurn(VERIFY_TOOL, { verdict: 'replan', reason: '按名称搜索结果不完整', nextAction: '改用类别条件搜索' }),
        internalTurn(PLAN_TOOL, {
          needsTask: true,
          completionCriteria: ['按类别搜索结果集完整'],
          steps: [{ title: '按类别重新搜索', completionCriteria: ['结果集完整'] }],
        }),
        textTurn('换了条件再搜。'),
        internalTurn(VERIFY_TOOL, { verdict: 'replan', reason: '类别搜索仍不完整', nextAction: '改用属性条件' }),
        internalTurn(PLAN_TOOL, {
          needsTask: true,
          steps: [{ title: '按属性条件搜索', completionCriteria: ['结果集完整'] }],
        }),
        textTurn('再换一种条件。'),
        internalTurn(VERIFY_TOOL, { verdict: 'replan', reason: '仍然不完整' }),
      ])
      const taskManager = new TaskManager()
      const runtime = new AgentRuntime({
        bridgeClient: bridge,
        fetchImpl: harness.fetchImpl,
        taskManager,
      })
      const result = await runtime.run({ sessionId: 'session-replan', text: '找出所有异常设备' })
      expect(result.isSuccess).toBe(true)
      expect(result.message).toContain('重规划次数已达上限')
      const task = taskManager.all()[0]!
      expect(task.status).toBe('blocked')
      expect(task.blockedReason).toBe('REPLAN_LIMIT')
      expect(task.planVersion).toBe(3)
      // Old evidence survives every replan.
      expect(task.evidence.some((entry) => entry.toolName === 'navisworks_find_items')).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('an aborted run pauses the task with USER_ABORTED instead of leaving it running', async () => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const harness = makeHarness([
        toolCallTurn('call-1', 'navisworks_find_items', { query: 'Pump' }),
        internalTurn(PLAN_TOOL, FULL_PLAN),
      ])
      const taskManager = new TaskManager()
      const controller = new AbortController()
      let resolveBridgeWait: () => void = () => undefined
      const bridgeStarted = new Promise<void>((resolve) => { resolveBridgeWait = resolve })
      const abortableBridge: AgentBridgeClient = {
        call: (_method, _parameters, options) => new Promise((_, reject) => {
          resolveBridgeWait()
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted during execution')))
        }),
      }
      const runtime = new AgentRuntime({
        bridgeClient: abortableBridge,
        fetchImpl: harness.fetchImpl,
        taskManager,
      })
      const run = runtime.run(
        { sessionId: 'session-abort', text: '检查所有 Pump 的 Location' },
        { signal: controller.signal },
      )
      await bridgeStarted
      controller.abort()
      await expect(run).rejects.toThrow()
      const task = taskManager.all()[0]!
      expect(task.status).toBe('paused')
      expect(task.pauseReason).toBe('USER_ABORTED')
    } finally {
      warn.mockRestore()
    }
  })
})
