import { describe, expect, it, vi } from 'vitest'
import type { CompletionRequest, CompletionResult, ModelProvider } from '../../model/types'
import { TASK_PLAN_TOOL_NAME, TaskPlanner } from '../taskPlanner'
import type { CuriTask } from '../taskTypes'

function stubProvider(
  handlers: Array<(request: CompletionRequest) => CompletionResult>,
): { provider: ModelProvider; requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = []
  let index = 0
  const provider = {
    async complete(request: CompletionRequest) {
      requests.push(request)
      const handler = handlers[Math.min(index, handlers.length - 1)]
      index += 1
      if (handler === undefined) throw new Error('no stub response configured')
      return handler(request)
    },
  } as unknown as ModelProvider
  return { provider, requests }
}

function planResult(arguments_: Record<string, unknown>): CompletionResult {
  return {
    content: '',
    thinking: '',
    toolCalls: [{ id: 'plan-1', name: TASK_PLAN_TOOL_NAME, arguments: arguments_ }],
    contextTokensUsed: 10,
  }
}

const emptyResult: CompletionResult = { content: '', thinking: '', toolCalls: [], contextTokensUsed: 0 }

const PLANNER_INPUT = {
  userGoal: '帮我检查当前模型里所有 Pump 的 Location，找出为空的，并把名称整理出来。',
  constraints: ['不要修改模型'],
  proposedToolCalls: [
    { name: 'navisworks_find_items', arguments: { query: 'Pump' } },
  ],
} as const

const MULTI_STEP_PLAN = {
  needsTask: true,
  objective: '找出全部 Pump 中 Location 为空的构件并汇总名称',
  completionCriteria: ['目标搜索结果完整 truncated=false', '所有 Pump 均已读取 Location 属性', '空 Location 项均有构件名称'],
  steps: [
    { title: '搜索全部 Pump', completionCriteria: ['搜索返回全部目标，truncated=false'] },
    { title: '读取所有目标 Location', completionCriteria: ['每个目标均有 Location 读取记录'] },
    { title: '汇总空 Location 项名称', completionCriteria: ['汇总数量等于空 Location 项数量'] },
  ],
}

describe('TaskPlanner — plan decisions', () => {
  it('offers ONLY the internal tool and never plain-chat context', async () => {
    const { provider, requests } = stubProvider([() => planResult({ needsTask: false })])
    await new TaskPlanner().plan(provider, 'test-model', { ...PLANNER_INPUT })
    expect(requests[0]?.tools).toHaveLength(1)
    expect(requests[0]?.tools?.[0]?.function.name).toBe('curi_emit_task_plan')
    expect(requests[0]?.messages[0]?.role).toBe('system')
    expect(requests[0]?.think).toBe(false)
  })

  it('needsTask=false rejects a task for simple lookups', async () => {
    const { provider } = stubProvider([() => planResult({ needsTask: false })])
    const decision = await new TaskPlanner().plan(provider, 'test-model', {
      ...PLANNER_INPUT,
      userGoal: '当前选中了什么？',
    })
    expect(decision).toEqual({ needsTask: false })
  })

  it('creates a full plan for a multi-step tool task', async () => {
    const { provider } = stubProvider([() => planResult(MULTI_STEP_PLAN)])
    const decision = await new TaskPlanner().plan(provider, 'test-model', { ...PLANNER_INPUT })
    expect(decision?.needsTask).toBe(true)
    expect(decision?.task?.objective).toContain('Pump')
    expect(decision?.task?.steps).toHaveLength(3)
    expect(decision?.task?.steps.every((step) => step.completionCriteria.length > 0)).toBe(true)
    expect(decision?.task?.completionCriteria).toContain('所有 Pump 均已读取 Location 属性')
  })

  it('falls back to step criteria when task-level criteria are omitted', async () => {
    const bare = {
      needsTask: true,
      objective: '批量读取属性',
      steps: MULTI_STEP_PLAN.steps,
    }
    const { provider } = stubProvider([() => planResult(bare)])
    const decision = await new TaskPlanner().plan(provider, 'test-model', { ...PLANNER_INPUT })
    expect(decision?.task?.completionCriteria.length).toBeGreaterThan(0)
    expect(decision?.task?.completionCriteria).toContain('搜索返回全部目标，truncated=false')
  })

  it('retries once when the first response has no internal tool call', async () => {
    const { provider, requests } = stubProvider([() => emptyResult, () => planResult(MULTI_STEP_PLAN)])
    const decision = await new TaskPlanner().plan(provider, 'test-model', { ...PLANNER_INPUT })
    expect(decision?.needsTask).toBe(true)
    expect(requests).toHaveLength(2)
  })

  it('degrades to null when both attempts are invalid', async () => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const { provider, requests } = stubProvider([() => emptyResult])
      const decision = await new TaskPlanner().plan(provider, 'test-model', { ...PLANNER_INPUT })
      expect(decision).toBeNull()
      expect(requests).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects needsTask=true without usable steps', async () => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const { provider } = stubProvider([() => planResult({ needsTask: true, objective: '无步骤' })])
      const decision = await new TaskPlanner().plan(provider, 'test-model', { ...PLANNER_INPUT })
      expect(decision).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('TaskPlanner — replan', () => {
  const task: CuriTask = {
    id: 'task-1',
    sessionId: 'session-1',
    objective: '找出全部某类型设备的 Location 异常',
    status: 'running',
    steps: [
      { id: '1', title: '按名称搜索', status: 'completed', completionCriteria: ['结果完整'], evidenceIds: ['e1'] },
      { id: '2', title: '读取 Location', status: 'pending', completionCriteria: ['全部读取'], evidenceIds: [] },
    ],
    completionCriteria: ['结果集完整'],
    constraints: [],
    evidence: [{
      id: 'e1',
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'navisworks_find_items',
      status: 'contradicting',
      summary: '按名称搜索结果明显不完整',
      createdAt: Date.now(),
    }],
    planVersion: 1,
    replanCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  it('produces a new route without repeating the failed one', async () => {
    const { provider, requests } = stubProvider([() => planResult({
      needsTask: true,
      completionCriteria: ['按类别搜索结果集完整'],
      steps: [
        { title: '按类别条件重新搜索', completionCriteria: ['结果集完整'] },
        { title: '读取 Location', completionCriteria: ['全部读取'] },
      ],
    })])
    const replan = await new TaskPlanner().replan(provider, 'test-model', {
      task,
      failureReason: '按名称搜索结果不完整',
      missingEvidence: ['还有大量构件未覆盖'],
    })
    expect(replan?.steps[0]?.title).toContain('按类别')
    // The planner sees the failure reason and the old evidence.
    expect(requests[0]?.messages.at(-1)?.content).toContain('按名称搜索结果不完整')
    expect(requests[0]?.messages.at(-1)?.content).toContain('按名称搜索结果明显不完整')
  })

  it('treats needsTask=false on a replan as invalid and degrades to null', async () => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const { provider } = stubProvider([() => planResult({ needsTask: false })])
      const replan = await new TaskPlanner().replan(provider, 'test-model', {
        task,
        failureReason: '路线失败',
      })
      expect(replan).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })
})
