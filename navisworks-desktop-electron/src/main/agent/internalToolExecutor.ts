import type { ToolOutputStore } from '../toolOutputStore'
import type { SkillRegistry } from '../skill/skillRegistry'
import { validateQuestionPrompts } from '../question/questionSchema'
import { SKILL_MAX_BYTES } from '../skill/limits'
import type { QuestionOutcome, QuestionSource, QuestionPrompt } from '../question/types'

/**
 * P17/§75 — the single seam that RUNS internal (non-Bridge) tools:
 * `read_tool_result`, `question`, `skill`. Tool metadata (schema/impact/
 * permission) still comes ONLY from the ToolRegistry (§76): this executor
 * never re-declares a schema, it only executes. Navisworks Bridge tool
 * execution stays entirely outside this class.
 */
export interface InternalToolContext {
  runId: string
  sessionId: string
  toolCallId: string
  /**
   * The run-scoped question channel (ChatRunRegistry wires it to the
   * QuestionService + the run's sender, binding run/session/turn identity).
   * The executor itself owns no IPC and no question ids (§5: index-based).
   */
  askQuestion: (input: {
    source: QuestionSource
    questions: QuestionPrompt[]
  }) => Promise<QuestionOutcome>
  signal?: AbortSignal
}

export type InternalToolResult =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string }

const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_tool_result',
  'question',
  'skill',
])

export class InternalToolExecutor {
  constructor(
    private readonly toolOutputStore: ToolOutputStore | undefined,
    private readonly skillRegistry: SkillRegistry | undefined,
  ) {}

  canExecute(name: string): boolean {
    return INTERNAL_TOOL_NAMES.has(name)
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: InternalToolContext,
  ): Promise<InternalToolResult> {
    switch (name) {
      case 'read_tool_result':
        return this.#readToolResult(args)
      case 'question':
        return this.#question(args, context)
      case 'skill':
        return this.#skill(args)
      default:
        return { ok: false, code: 'TOOL_NOT_ALLOWED', message: `未知内部工具：${name}` }
    }
  }

  async #readToolResult(args: Record<string, unknown>): Promise<InternalToolResult> {
    const store = this.toolOutputStore
    if (store === undefined) {
      return { ok: false, code: 'TOOL_OUTPUT_UNAVAILABLE', message: '工具结果存储在当前运行中不可用。' }
    }
    const resultRef = typeof args.resultRef === 'string' ? args.resultRef : ''
    const offset = typeof args.offset === 'number' ? args.offset : 0
    const limit = typeof args.limit === 'number' ? args.limit : 50
    const page = await store.read(resultRef, offset, limit)
    if (page.error !== undefined) {
      return { ok: false, code: 'TOOL_OUTPUT_UNAVAILABLE', message: page.error }
    }
    return { ok: true, result: page }
  }

  async #question(
    args: Record<string, unknown>,
    context: InternalToolContext,
  ): Promise<InternalToolResult> {
    const validated = validateQuestionPrompts(args.questions ?? args)
    if (!validated.ok) {
      return { ok: false, code: 'INVALID_QUESTION', message: validated.message }
    }
    let outcome: QuestionOutcome
    try {
      outcome = await context.askQuestion({
        source: 'tool',
        questions: validated.questions,
      })
    } catch {
      // Abort (run/session cancelled) — a structured error, never a hang (§11/§79).
      return { ok: false, code: 'QUESTION_CANCELLED', message: '问题已随运行取消。' }
    }
    if (outcome.kind === 'rejected') {
      return {
        ok: true,
        result: { type: 'question_rejected', message: '用户选择不回答这个问题。' },
      }
    }
    // question_answered carries the per-question text + values so the model gets
    // real structure, not just "用户回答了" (§10).
    return {
      ok: true,
      result: {
        type: 'question_answered',
        answers: validated.questions.map((prompt, index) => ({
          question: prompt.question,
          answer: outcome.answers.find((a) => a.questionIndex === index)?.values ?? [],
        })),
      },
    }
  }

  async #skill(args: Record<string, unknown>): Promise<InternalToolResult> {
    const registry = this.skillRegistry
    if (registry === undefined) {
      return { ok: false, code: 'SKILL_UNAVAILABLE', message: '当前运行未启用 Skill。' }
    }
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    const skill = registry.get(name)
    if (skill === undefined) {
      return {
        ok: true,
        result: {
          type: 'skill_not_found',
          name,
          available: registry.list().map((entry) => entry.name),
        },
      }
    }
    // SKILL_MAX_BYTES bounds content at parse time (§45/§59); the body is a
    // tool observation, never copied into Session Memory or an Epoch snapshot (§60).
    const content = skill.content.length > SKILL_MAX_BYTES
      ? `${skill.content.slice(0, SKILL_MAX_BYTES)}\n[已截断]`
      : skill.content
    return {
      ok: true,
      result: { name: skill.name, content: `<skill_content name="${skill.name}">\n${content}\n</skill_content>` },
    }
  }
}
