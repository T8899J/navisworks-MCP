import type { ModelProvider } from '../model/types'
import { emitInternalToolCall, extractInternalToolCall } from './taskPlanner'
import type { TaskVerification } from './taskManager'
import type { CuriTask } from './taskTypes'

/**
 * TaskVerifier — the Completion Gate. Its ONLY job: given the task's
 * completion criteria, the collected evidence and the agent's draft answer,
 * decide whether the task is actually done. It executes no tools and never
 * trusts "the model sounds finished": every criterion must be answerable
 * yes/no/unknown from evidence.
 *
 * Structure comes from the INTERNAL curi_emit_task_verification tool call —
 * never prose JSON, never part of the user-facing tool catalog.
 */
export const TASK_VERIFICATION_TOOL_NAME = 'curi_emit_task_verification'

const TASK_VERIFICATION_TOOL = {
  type: 'function',
  function: {
    name: TASK_VERIFICATION_TOOL_NAME,
    description: '提交任务完成度裁决。必须基于证据逐条对照完成条件后给出 verdict。',
    parameters: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['complete', 'continue', 'replan', 'blocked'],
          description: 'complete=全部完成条件有证据支持；continue=还缺证据/步骤；replan=当前路线不可行；blocked=缺少用户条件或环境不具备。',
        },
        reason: { type: 'string', description: '裁决依据，逐条对照完成条件。' },
        stepUpdates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepId: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'active', 'completed', 'failed', 'skipped'] },
              evidenceIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['stepId', 'status'],
          },
        },
        missingEvidence: { type: 'array', items: { type: 'string' }, description: 'continue 时列出还缺什么。' },
        nextAction: { type: 'string', description: 'continue/replan 时给出下一步。' },
        blockedReason: { type: 'string', description: 'blocked 时说明卡点。' },
      },
      required: ['verdict', 'reason'],
    },
  },
} as const

const VERIFIER_SYSTEM_PROMPT = [
  '你是 Curi 运行时的任务完成度验证器。你的唯一职责：判断任务是否真的完成，并通过唯一的内部工具提交裁决。你不执行任何工具。',
  '',
  '裁决规则：',
  '- complete：任务级完成条件逐条都有证据支持，且数量/覆盖关系对得上。任何一条无法确认就不允许 complete。',
  '- continue：路线可行但还有步骤未完成或证据缺失。在 missingEvidence 中具体列出缺什么（含数量），在 nextAction 给出下一步。',
  '- replan：当前路线已失败或被证明不可行（搜索方式不完整、属性读取方式不可用等），需要换路线。',
  '- blocked：缺少用户输入、环境不具备（Navisworks 断开、文档已变）或目标不明确，无法继续。',
  '- 逐条引用证据编号作为依据；不要因为某次工具调用成功就认定整个任务完成。',
].join('\n')

export interface VerificationRequest {
  task: CuriTask
  /** The agent's draft answer for this round — what the user would see. */
  agentAnswer?: string
  /** Outcomes of the most recent tool executions, newest last. */
  recentToolOutcomes?: ReadonlyArray<{ toolName: string; ok: boolean; summary: string }>
}

const MAX_ATTEMPTS = 2
const MAX_TEXT_CHARS = 400
const MAX_RENDERED_EVIDENCE = 12

export class TaskVerifier {
  async verify(
    provider: ModelProvider,
    model: string,
    request: VerificationRequest,
    signal?: AbortSignal,
  ): Promise<TaskVerification | null> {
    const { task } = request
    const user = [
      `任务目标：${task.objective}`,
      `完成条件：\n${task.completionCriteria.map((entry) => `- ${entry}`).join('\n') || '（未定义）'}`,
      `步骤状态：\n${task.steps.map((step) => `${step.id}. [${step.status}] ${step.title}`).join('\n') || '（无步骤）'}`,
      `证据摘要（编号即证据 id）：\n${task.evidence
        .slice(-MAX_RENDERED_EVIDENCE)
        .map((entry) => `- ${entry.id} ${entry.toolName ?? entry.type}：${clip(entry.summary, 200)}`)
        .join('\n') || '（无）'}`,
      request.recentToolOutcomes?.length
        ? `最近工具结果：\n${request.recentToolOutcomes
            .slice(-6)
            .map((outcome) => `- ${outcome.toolName}：${outcome.ok ? '成功' : '失败'}；${clip(outcome.summary, 200)}`)
            .join('\n')}`
        : undefined,
      request.agentAnswer?.trim()
        ? `Agent 准备给用户的回答（仅供参考，不得作为完成依据）：\n${clip(request.agentAnswer.trim(), 1000)}`
        : undefined,
    ].filter((entry) => entry !== undefined).join('\n\n')

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const call = await emitInternalToolCall(
        provider,
        model,
        VERIFIER_SYSTEM_PROMPT,
        user,
        TASK_VERIFICATION_TOOL,
        signal,
      )
      const verification = call === undefined ? undefined : parseVerificationArguments(call.arguments)
      if (verification !== undefined) return verification
      console.debug(`[task] verifier response invalid (attempt ${attempt + 1})`)
    }
    return null
  }
}

function parseVerificationArguments(arguments_: Record<string, unknown>): TaskVerification | undefined {
  const verdict = arguments_.verdict
  if (verdict !== 'complete' && verdict !== 'continue' && verdict !== 'replan' && verdict !== 'blocked') {
    return undefined
  }
  const reason = typeof arguments_.reason === 'string' ? arguments_.reason.trim() : ''
  if (!reason) return undefined
  const stepUpdates = parseStepUpdates(arguments_.stepUpdates)
  return {
    verdict,
    reason: clip(reason, MAX_TEXT_CHARS),
    ...(stepUpdates.length > 0 ? { stepUpdates } : {}),
    ...(parseStringList(arguments_.missingEvidence).length > 0
      ? { missingEvidence: parseStringList(arguments_.missingEvidence) }
      : {}),
    ...(typeof arguments_.nextAction === 'string' && arguments_.nextAction.trim()
      ? { nextAction: clip(arguments_.nextAction.trim(), MAX_TEXT_CHARS) }
      : {}),
    ...(typeof arguments_.blockedReason === 'string' && arguments_.blockedReason.trim()
      ? { blockedReason: arguments_.blockedReason.trim() }
      : {}),
  }
}

function parseStepUpdates(value: unknown): NonNullable<TaskVerification['stepUpdates']> {
  if (!Array.isArray(value)) return []
  const updates: NonNullable<TaskVerification['stepUpdates']> = []
  for (const entry of value.slice(0, 20)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const stepId = typeof record.stepId === 'string' ? record.stepId : ''
    const status = record.status
    if (!stepId) continue
    if (status !== 'pending' && status !== 'active' && status !== 'completed' && status !== 'failed' && status !== 'skipped') {
      continue
    }
    updates.push({
      stepId,
      status,
      ...(parseStringList(record.evidenceIds).length > 0
        ? { evidenceIds: parseStringList(record.evidenceIds) }
        : {}),
    })
  }
  return updates
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}
