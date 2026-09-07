import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, type AgentBridgeClient } from '../agentRuntime'
import { InternalToolExecutor } from '../agent/internalToolExecutor'
import { QuestionService } from '../question/questionService'
import { SkillRegistry } from '../skill/skillRegistry'
import type { SkillRoots } from '../skill/paths'
import type { QuestionOutcome } from '../question/types'
import type { InternalToolContext } from '../agent/internalToolExecutor'

function ndjson(lines: unknown[]): Response {
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

function toolCallRound(name: string, args: Record<string, unknown>, id: string) {
  return ndjson([{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, function: { index: 0, name, arguments: args } }],
    },
    done: true,
  }])
}

function textRound(content: string) {
  return ndjson([{ message: { role: 'assistant', content }, done: true }])
}

function makeRuntime(replies: Response[]) {
  const bridge: AgentBridgeClient = { async call() { return { connected: true } as never } }
  let index = 0
  const fetchImpl = vi.fn(async () => replies[Math.min(index++, replies.length - 1)]) as unknown as typeof fetch
  const questions = new QuestionService()
  const executor = new InternalToolExecutor(undefined, undefined)
  const runtime = new AgentRuntime({ bridgeClient: bridge, fetchImpl, internalToolExecutor: executor })
  return { runtime, questions, executor, bridge }
}

describe('question tool through the runtime loop (§84)', () => {
  it('Case 1: ask suspends (awaiting phase), answer resumes generating and the run continues', async () => {
    const { runtime, questions } = makeRuntime([
      toolCallRound('question', {
        questions: [{
          question: '你希望在哪个范围查找？',
          kind: 'single',
          options: [{ label: '整个模型' }, { label: '当前选择' }],
        }],
      }, 'q1'),
      textRound('好的，在当前选择中查找。'),
    ])
    const events: string[] = []
    let asked = 0

    const runPromise = runtime.run(
      { sessionId: 's1', text: '帮我查支架', reasoningMode: 'low' },
      {
        onEvent: (event) => events.push(event.phase === 'started' || event.phase === 'completed'
          ? `${event.phase}:${(event as { tool?: string }).tool ?? ''}`
          : event.phase),
        requestQuestion: async (request) => {
          asked += 1
          const outcome = await questions.ask(
            { runId: 'r1', sessionId: 's1', source: request.source, questions: request.questions },
            () => undefined,
          )
          return outcome
        },
      },
    )
    // The question is now pending: answer it.
    await vi.waitFor(() => expect(questions.listPending('s1')).toHaveLength(1))
    const pending = questions.listPending('s1')[0]!
    questions.answer(pending.requestId, [{ questionIndex: 0, values: ['当前选择'] }])
    const result = await runPromise

    expect(result.isSuccess).toBe(true)
    expect(result.message).toContain('在当前选择中查找')
    expect(asked).toBe(1)
    expect(events).toEqual([
      'started:question',
      'awaiting-user-input',
      'generating',
      'completed:question',
      'text',
    ])
  })

  it('Case 2: rejection yields question_rejected and the run completes normally', async () => {
    const { runtime, questions } = makeRuntime([
      toolCallRound('question', {
        questions: [{ question: '要哪种？', kind: 'single', options: [{ label: 'A' }, { label: 'B' }] }],
      }, 'q2'),
      textRound('了解，我按默认处理。'),
    ])
    const runPromise = runtime.run(
      { sessionId: 's1', text: 'x' },
      {
        requestQuestion: (request) => questions.ask(
          { runId: 'r', sessionId: 's1', source: request.source, questions: request.questions },
          () => undefined,
        ),
      },
    )
    await vi.waitFor(() => expect(questions.listPending('s1')).toHaveLength(1))
    questions.reject(questions.listPending('s1')[0]!.requestId)
    const result = await runPromise
    expect(result.isSuccess).toBe(true)
    expect(result.message).toContain('默认')
  })

  it('Case 3: an invalid question schema becomes an INVALID_QUESTION tool result, not a crash', async () => {
    const { runtime } = makeRuntime([
      toolCallRound('question', { questions: [{ question: 'q', kind: 'single' }] }, 'bad1'),
      textRound('抱歉，我重新问。'),
    ])
    const asked: string[] = []
    const result = await runtime.run(
      { sessionId: 's1', text: 'x' },
      {
        requestQuestion: async () => {
          asked.push('should-not-be-called')
          return { kind: 'rejected' } satisfies QuestionOutcome
        },
      },
    )
    // The bad call never reached QuestionService (validation failed first) —
    // the model got an INVALID_QUESTION observation and could recover.
    expect(asked).toEqual([])
    expect(result.isSuccess).toBe(true)
  })
})

describe('doom loop through the runtime loop (§87 Case 2)', () => {
  it('identical bridge calls with identical results: exactly 2 real executions, then synthetic recovery', async () => {
    let bridgeCalls = 0
    const bridge: AgentBridgeClient = {
      async call() {
        bridgeCalls += 1
        return { items: [{ id: 'i1' }], total: 1 } as never
      },
    }
    // The provider ALWAYS asks for the same find_items call; only the final
    // round breaks out with text.
    const replies = [
      toolCallRound('navisworks_find_items', { query: '支架' }, 'c1'),
      toolCallRound('navisworks_find_items', { query: '支架' }, 'c2'),
      toolCallRound('navisworks_find_items', { query: '支架' }, 'c3'),
      toolCallRound('navisworks_find_items', { query: '支架' }, 'c4'),
      textRound('结束。'),
    ]
    let index = 0
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
      // Once the model-visible history contains the recovery marker, break the loop.
      if (body.messages.some((message) => message.content.includes('doom_loop_detected'))) {
        return textRound('结束。')
      }
      return replies[Math.min(index++, 4)]
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      bridgeClient: bridge,
      fetchImpl,
      internalToolExecutor: new InternalToolExecutor(undefined, undefined),
    })
    const result = await runtime.run({ sessionId: 's1', text: '查支架' }, {
      requestQuestion: async () => ({ kind: 'rejected' }),
    })
    expect(result.isSuccess).toBe(true)
    // §87 Case 2: the THIRD attempt must not hit the bridge — max 2 real calls.
    expect(bridgeCalls).toBe(2)
  })
})

describe('skill tool through the executor (§92)', () => {
  it('known skill loads full content; unknown returns skill_not_found without crashing', async () => {
    const dir = await makeTempSkillDir()
    const registry = new SkillRegistry(dir)
    await registry.discover()
    const executor = new InternalToolExecutor(undefined, registry)
    const ok = await executor.execute('skill', { name: 'model-inspection' }, SKILL_CTX)
    expect(ok.ok).toBe(true)
    expect(JSON.stringify((ok as { result: unknown }).result)).toContain('navisworks_get_selection')
    const missing = await executor.execute('skill', { name: 'nope' }, SKILL_CTX)
    expect(missing.ok).toBe(true) // skill_not_found is a RESULT, not an error
    const missingJson = JSON.stringify((missing as { result: unknown }).result)
    expect(missingJson).toContain('skill_not_found')
    expect(missingJson).toContain('model-inspection')
  })
})

const SKILL_CTX: InternalToolContext = {
  runId: 'r1',
  sessionId: 's1',
  toolCallId: 'tc1',
  askQuestion: async () => ({ kind: 'rejected' } as const),
}

async function makeTempSkillDir(): Promise<SkillRoots> {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'curi-skills-'))
  const builtin = join(root, 'builtin')
  const user = join(root, 'user')
  await mkdir(join(builtin, 'model-inspection'), { recursive: true })
  await writeFile(join(builtin, 'model-inspection', 'SKILL.md'), [
    '---',
    'name: model-inspection',
    'description: 检查当前文档、选择与视点。',
    '---',
    '',
    '# Model Inspection',
    '当前选择必须 navisworks_get_selection 重新读取。',
  ].join('\n'), 'utf8')
  void rm
  return { builtinDirectory: builtin, userDirectory: user }
}
