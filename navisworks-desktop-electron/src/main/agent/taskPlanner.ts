import type { AgentToolContract } from '../toolCatalog'
import type { ChatMessage, ModelProvider } from '../model/types'
import { errorMessage } from '../model/providerUtils'
import type { CuriTask } from './taskTypes'
import type { TaskStepInput } from './taskManager'

/**
 * TaskPlanner — decides whether the user's request deserves a durable task,
 * and (on replan) rebuilds the plan from current evidence.
 *
 * Structure comes from an INTERNAL tool call (curi_emit_task_plan), never from
 * parsing prose JSON. This tool is runtime-internal: it is NOT registered in
 * the tool catalog, never shown in the tool UI, and only ever offered to the
 * model inside these dedicated planner requests.
 */
export const TASK_PLAN_TOOL_NAME = 'curi_emit_task_plan'

const TASK_PLAN_TOOL = {
  type: 'function',
  function: {
    name: TASK_PLAN_TOOL_NAME,
    description: '提交任务规划结论。对真实的工具型任务输出结构化计划；简单查询用 needsTask=false 拒绝建任务。',
    parameters: {
      type: 'object',
      properties: {
        needsTask: { type: 'boolean', description: '是否值得建立持久任务。' },
        objective: { type: 'string', description: '任务目标（needsTask=true 时必填）。' },
        constraints: { type: 'array', items: { type: 'string' } },
        completionCriteria: {
          type: 'array',
          items: { type: 'string' },
          description: '任务级完成条件，每条必须可被证据回答 是/否/未知。',
        },
        steps: {
          type: 'array',
          description: '有序步骤（needsTask=true 时必须提供）。',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              completionCriteria: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'completionCriteria'],
          },
        },
      },
      required: ['needsTask'],
    },
  },
} as const

const PLANNER_SYSTEM_PROMPT = [
  '你是 Curi 运行时的任务规划器。你的唯一职责：判断当前用户请求是否值得建立持久任务，并通过唯一的内部工具提交结论。',
  '',
  '判为 needsTask=true：检查所有…、逐个…、批量…、整理…、多步骤任务、执行后需要验证、失败后可能要换方案的真实工具任务。',
  '判为 needsTask=false：查一下当前选择、读一个属性、开关一个视点等一次或少量工具调用就能完成的事。不要为简单查询建任务。',
  '',
  '硬性要求：',
  '- objective 一句话说清要交付什么。',
  '- completionCriteria 与每个步骤的 completionCriteria 必须可验证：最终能依据证据回答 是/否/未知。禁止“完成检查”“确认没问题”“分析模型”这类无法验证的表述。',
  '- 步骤是有序最小行动，每步说明产出什么证据。',
  '- 必须通过内部工具提交，不要输出普通文本回答。',
].join('\n')

const REPLAN_SYSTEM_PROMPT = [
  '你是 Curi 运行时的任务重规划器。当前路线已失败或被验证不可行，你的唯一职责：基于已有证据设计新的执行路线，并通过唯一的内部工具提交。',
  '',
  '要求：',
  '- 不要保留导致失败的旧路线步骤。',
  '- 保留仍然有效的后续步骤；已完成步骤的结论作为已知事实复用。',
  '- completionCriteria 必须可验证（能依据证据回答 是/否/未知）。',
  '- objective 只在目标本身需要修正时才修改。',
  '- 必须通过内部工具提交，不要输出普通文本回答。',
].join('\n')

export interface TaskPlanRequest {
  userGoal: string
  constraints: readonly string[]
  documentSummary?: string
  proposedToolCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>
}

export interface TaskPlanDecision {
  needsTask: boolean
  /** Present only when needsTask=true; ready for TaskManager.createTask. */
  task?: {
    objective: string
    constraints: string[]
    completionCriteria: string[]
    steps: TaskStepInput[]
  }
}

export interface ReplanRequest {
  task: CuriTask
  failureReason: string
  missingEvidence?: string[]
}

export interface ReplanDecision {
  objective?: string
  completionCriteria?: string[]
  steps: TaskStepInput[]
}

const MAX_PLANNER_ATTEMPTS = 2
const MAX_STEPS = 10
const MAX_CRITERIA = 10
const MAX_OBJECTIVE_CHARS = 300
const MAX_TEXT_CHARS = 200

/**
 * One planner round-trip. Returns null when the model never emitted a valid
 * internal tool call (after one retry) — the caller then degrades to the
 * plain agent flow instead of blocking the user's task.
 */
export class TaskPlanner {
  async plan(
    provider: ModelProvider,
    model: string,
    request: TaskPlanRequest,
    signal?: AbortSignal,
  ): Promise<TaskPlanDecision | null> {
    const user = [
      `用户目标：${clip(request.userGoal, 1000)}`,
      request.constraints.length > 0
        ? `用户长期约束（来自记忆）：\n${request.constraints.map((entry) => `- ${clip(entry, MAX_TEXT_CHARS)}`).join('\n')}`
        : '用户长期约束：无',
      request.documentSummary ? `当前文档：${clip(request.documentSummary, 300)}` : undefined,
      `模型准备执行的工具调用：\n${request.proposedToolCalls
        .map((call) => `- ${call.name} ${clip(JSON.stringify(call.arguments), 300)}`)
        .join('\n')}`,
    ].filter((entry) => entry !== undefined).join('\n\n')

    for (let attempt = 0; attempt < MAX_PLANNER_ATTEMPTS; attempt += 1) {
      const call = await emitInternalToolCall(provider, model, PLANNER_SYSTEM_PROMPT, user, TASK_PLAN_TOOL, signal)
      const decision = call === undefined ? undefined : parsePlanArguments(call.arguments)
      if (decision !== undefined) return decision
      logPlannerRetry(attempt)
    }
    return null
  }

  async replan(
    provider: ModelProvider,
    model: string,
    request: ReplanRequest,
    signal?: AbortSignal,
  ): Promise<ReplanDecision | null> {
    const { task } = request
    const user = [
      `任务目标：${task.objective}`,
      `失败原因：${clip(request.failureReason, 600)}`,
      request.missingEvidence?.length
        ? `缺失的证据：\n${request.missingEvidence.map((entry) => `- ${clip(entry, MAX_TEXT_CHARS)}`).join('\n')}`
        : undefined,
      `当前计划（v${task.planVersion}）：\n${task.steps
        .map((step) => `${step.id}. [${step.status}] ${step.title}`)
        .join('\n')}`,
      `已有证据摘要（必须保留其结论，不要重复劳动）：\n${task.evidence
        .slice(-10)
        .map((entry) => `- ${entry.toolName ?? entry.type}：${clip(entry.summary, MAX_EVIDENCE_CHARS)}`)
        .join('\n') || '（无）'}`,
    ].filter((entry) => entry !== undefined).join('\n\n')

    for (let attempt = 0; attempt < MAX_PLANNER_ATTEMPTS; attempt += 1) {
      const call = await emitInternalToolCall(provider, model, REPLAN_SYSTEM_PROMPT, user, TASK_PLAN_TOOL, signal)
      const decision = call === undefined ? undefined : parseReplanArguments(call.arguments)
      if (decision !== undefined) return decision
      logPlannerRetry(attempt)
    }
    return null
  }
}

const MAX_EVIDENCE_CHARS = 200

/** Shared internal-call mechanics: windowless request offering exactly one
 * internal tool, whose emitted arguments carry the structured decision. A
 * provider failure counts as an invalid attempt (retry once, then degrade). */
export async function emitInternalToolCall(
  provider: ModelProvider,
  model: string,
  systemPrompt: string,
  userContent: string,
  tool: { type: 'function'; function: { name: string; description: string; parameters: unknown } },
  signal?: AbortSignal,
): Promise<{ name: string; arguments: Record<string, unknown> } | undefined> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ]
  let response
  try {
    response = await provider.complete({
      model,
      messages,
      tools: [tool as unknown as AgentToolContract],
      think: false,
      sampling: { temperature: 0, maxTokens: 2048 },
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    console.debug(`[task] internal call failed: ${errorMessage(error)}`)
    return undefined
  }
  return extractInternalToolCall(response.toolCalls, tool.function.name)
}

export function extractInternalToolCall(
  toolCalls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>,
  name: string,
): { name: string; arguments: Record<string, unknown> } | undefined {
  return toolCalls.find((call) => call.name === name)
}

function logPlannerRetry(attempt: number): void {
  // Diagnostic only: event + attempt, never user content.
  console.debug(`[task] planner response invalid (attempt ${attempt + 1})`)
}

function parsePlanArguments(arguments_: Record<string, unknown>): TaskPlanDecision | undefined {
  if (typeof arguments_.needsTask !== 'boolean') return undefined
  if (!arguments_.needsTask) return { needsTask: false }
  const objective = typeof arguments_.objective === 'string' ? arguments_.objective.trim() : ''
  if (!objective) return undefined
  const steps = parseSteps(arguments_.steps)
  if (steps === undefined || steps.length === 0) return undefined
  const criteria = parseStringList(arguments_.completionCriteria)
  return {
    needsTask: true,
    task: {
      objective: clip(objective, MAX_OBJECTIVE_CHARS),
      constraints: parseStringList(arguments_.constraints),
      // Fall back to the union of verifiable step criteria; never invent vague ones.
      completionCriteria: criteria.length > 0 ? criteria : uniqueList(steps.flatMap((step) => step.completionCriteria)),
      steps,
    },
  }
}

function parseReplanArguments(arguments_: Record<string, unknown>): ReplanDecision | undefined {
  if (arguments_.needsTask === false) return undefined
  const steps = parseSteps(arguments_.steps)
  if (steps === undefined || steps.length === 0) return undefined
  const objective = typeof arguments_.objective === 'string' && arguments_.objective.trim()
    ? clip(arguments_.objective.trim(), MAX_OBJECTIVE_CHARS)
    : undefined
  const criteria = parseStringList(arguments_.completionCriteria)
  return {
    ...(objective === undefined ? {} : { objective }),
    ...(criteria.length > 0 ? { completionCriteria: criteria } : {}),
    steps,
  }
}

function parseSteps(value: unknown): TaskStepInput[] | undefined {
  if (!Array.isArray(value)) return undefined
  const steps: TaskStepInput[] = []
  for (const entry of value.slice(0, MAX_STEPS)) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const record = entry as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    if (!title) return undefined
    const criteria = parseStringList(record.completionCriteria)
    steps.push({
      title: clip(title, MAX_TEXT_CHARS),
      ...(typeof record.description === 'string' && record.description.trim()
        ? { description: clip(record.description.trim(), MAX_TEXT_CHARS) }
        : {}),
      // A step without its own criteria inherits a verifiable placeholder so the
      // verifier always has something evidence-checkable to grade.
      completionCriteria: criteria.length > 0
        ? criteria
        : [`步骤“${clip(title, 40)}”的产出已由工具结果证实`],
    })
  }
  return steps
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => clip(entry.trim(), MAX_TEXT_CHARS))
    .slice(0, MAX_CRITERIA)
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values)]
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}
