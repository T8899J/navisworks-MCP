import { describe, expect, it, vi } from 'vitest'
import type { CompletionRequest, CompletionResult, ModelProvider } from '../../model/types'
import { TASK_VERIFICATION_TOOL_NAME, TaskVerifier } from '../taskVerifier'
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

function verdictResult(arguments_: Record<string, unknown>): CompletionResult {
  return {
    content: '',
    thinking: '',
    toolCalls: [{ id: 'verify-1', name: TASK_VERIFICATION_TOOL_NAME, arguments: arguments_ }],
    contextTokensUsed: 10,
  }
}

const failingProvider: ModelProvider = {
  async complete() {
    throw new Error('verifier backend down')
  },
} as unknown as ModelProvider

function makeTask(overrides: Partial<CuriTask> = {}): CuriTask {
  const now = Date.now()
  return {
    id: 'task-1',
    sessionId: 'session-1',
    objective: '找出全部 Pump 中 Location 为空的构件',
    status: 'running',
    steps: [
      { id: '1', title: '搜索全部 Pump', status: 'completed', completionCriteria: ['结果完整'], evidenceIds: ['e1'] },
      { id: '2', title: '读取所有 Location', status: 'active', completionCriteria: ['全部读取'], evidenceIds: ['e2'] },
    ],
    completionCriteria: ['目标搜索结果完整', '所有 Pump 已检查', '异常项均有证据'],
    constraints: [],
    evidence: [
      { id: 'e1', type: 'tool-result', toolCallId: 'call-1', toolName: 'navisworks_find_items', status: 'supporting', summary: '搜索成功；返回 86 个目标；truncated=false', createdAt: now },
      { id: 'e2', type: 'tool-result', toolCallId: 'call-2', toolName: 'navisworks_get_item_properties', status: 'supporting', summary: '已读取 40 个构件的属性', createdAt: now },
    ],
    planVersion: 1,
    replanCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const BASE_REQUEST = {
  task: makeTask(),
  recentToolOutcomes: [{ toolName: 'navisworks_get_item_properties', ok: true, summary: '已读取 40 个构件的属性' }],
  agentAnswer: '检查完成，共 86 个 Pump……',
} as const

describe('TaskVerifier — verdicts', () => {
  it('only offers the internal verification tool', async () => {
    const { provider, requests } = stubProvider([() => verdictResult({ verdict: 'complete', reason: '86/86 已检查' })])
    await new TaskVerifier().verify(provider, 'test-model', { ...BASE_REQUEST })
    expect(requests[0]?.tools).toHaveLength(1)
    expect(requests[0]?.tools?.[0]?.function.name).toBe('curi_emit_task_verification')
  })

  it('all criteria covered → complete', async () => {
    const { provider } = stubProvider([() => verdictResult({
      verdict: 'complete',
      reason: '目标 86，已检查 86，异常 5 项均有名称与证据',
      stepUpdates: [
        { stepId: '1', status: 'completed', evidenceIds: ['e1'] },
        { stepId: '2', status: 'completed', evidenceIds: ['e2'] },
      ],
    })])
    const verification = await new TaskVerifier().verify(provider, 'test-model', { ...BASE_REQUEST })
    expect(verification?.verdict).toBe('complete')
    expect(verification?.stepUpdates).toHaveLength(2)
    expect(verification?.stepUpdates?.[0]?.evidenceIds).toEqual(['e1'])
  })

  it('missing evidence → continue with concrete gaps', async () => {
    const { provider } = stubProvider([() => verdictResult({
      verdict: 'continue',
      reason: '还有 48 个构件没有读取 Location',
      stepUpdates: [{ stepId: '2', status: 'active', evidenceIds: ['e2'] }],
      missingEvidence: ['还有 48 个构件没有读取 Location'],
      nextAction: '继续读取剩余对象',
    })])
    const verification = await new TaskVerifier().verify(provider, 'test-model', { ...BASE_REQUEST })
    expect(verification?.verdict).toBe('continue')
    expect(verification?.missingEvidence).toEqual(['还有 48 个构件没有读取 Location'])
    expect(verification?.nextAction).toBe('继续读取剩余对象')
  })

  it('broken route → replan', async () => {
    const { provider } = stubProvider([() => verdictResult({
      verdict: 'replan',
      reason: '按名称搜索结果明显不完整，路线不可行',
      stepUpdates: [{ stepId: '1', status: 'failed' }],
      nextAction: '改用类别/属性条件搜索',
    })])
    const verification = await new TaskVerifier().verify(provider, 'test-model', { ...BASE_REQUEST })
    expect(verification?.verdict).toBe('replan')
    expect(verification?.stepUpdates?.[0]?.status).toBe('failed')
  })

  it('missing user condition → blocked with reason', async () => {
    const { provider } = stubProvider([() => verdictResult({
      verdict: 'blocked',
      reason: 'Navisworks 已断开，无法继续读取',
      blockedReason: 'NAV_DISCONNECTED',
    })])
    const verification = await new TaskVerifier().verify(provider, 'test-model', { ...BASE_REQUEST })
    expect(verification?.verdict).toBe('blocked')
    expect(verification?.blockedReason).toBe('NAV_DISCONNECTED')
  })

  it('the draft answer is passed as context, flagged as non-evidence', async () => {
    const { provider, requests } = stubProvider([() => verdictResult({ verdict: 'complete', reason: 'ok' })])
    await new TaskVerifier().verify(provider, 'test-model', { ...BASE_REQUEST })
    const userMessage = requests[0]?.messages.at(-1)?.content ?? ''
    expect(userMessage).toContain('不得作为完成依据')
    expect(userMessage).toContain('86')
  })
})

describe('TaskVerifier — failure handling', () => {
  it('returns null (never complete) when the model emits no internal tool call', async () => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const empty: CompletionResult = { content: '', thinking: '', toolCalls: [], contextTokensUsed: 0 }
      const { provider, requests } = stubProvider([() => empty])
      const verification = await new TaskVerifier().verify(provider, 'test-model', { ...BASE_REQUEST })
      expect(verification).toBeNull()
      expect(requests).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('returns null when the verdict is out of the enum', async () => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const { provider } = stubProvider([() => verdictResult({ verdict: 'probably-fine', reason: '看起来没问题' })])
      const verification = await new TaskVerifier().verify(provider, 'test-model', { ...BASE_REQUEST })
      expect(verification).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it('returns null when the provider itself throws — never a default complete', async () => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const verification = await new TaskVerifier().verify(failingProvider, 'test-model', { ...BASE_REQUEST })
      expect(verification).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })
})
