import type { CuriTask } from './taskTypes'

/** The latest verifier feedback folded into the task block, so the model sees
 * WHY the task is not done yet and what to do next — never a bare loop. */
export interface TaskVerificationFeedback {
  verdict: 'complete' | 'continue' | 'replan' | 'blocked'
  reason: string
  missingEvidence?: string[]
  nextAction?: string
}

/** Short execution policy appended to every task block. Deliberately minimal:
 * the runtime verifier's verdict outranks the model's own completion guess. */
const TASK_EXECUTION_POLICY = [
  '执行策略：',
  '- 围绕当前任务和完成条件行动；不要因为完成一个 Tool Call 就假设整个任务已经完成。',
  '- runtime 验证器的完成状态高于你自己的完成猜测；验证未通过时不得向用户宣称任务完成。',
].join('\n')

/** Evidence summaries shown to the model: recent only, tasks.json keeps all. */
const MAX_RENDERED_EVIDENCE = 8
const MAX_EVIDENCE_SUMMARY_CHARS = 200

/**
 * Render the active task as a compact system block (never full JSON). Kept
 * small by design: recent evidence only, clipped summaries — the whole block
 * should stay roughly within 1000–2000 tokens even on long tasks.
 */
export function renderTaskContext(task: CuriTask, verification?: TaskVerificationFeedback): string {
  const lines: string[] = [
    '【当前任务】',
    `目标：${task.objective}`,
    `状态：${task.status}`,
  ]

  if (task.steps.length > 0) {
    lines.push('计划：')
    for (const step of task.steps) {
      const marker = step.id === task.currentStepId && step.status === 'pending' ? 'active' : step.status
      lines.push(`${step.id}. [${marker}] ${step.title}`)
    }
  }

  if (task.completionCriteria.length > 0) {
    lines.push('完成条件：')
    for (const criterion of task.completionCriteria) {
      lines.push(`- ${criterion}`)
    }
  }

  if (task.evidence.length > 0) {
    lines.push('当前证据：')
    for (const entry of task.evidence.slice(-MAX_RENDERED_EVIDENCE)) {
      const source = entry.toolName ?? entry.type
      lines.push(`- ${entry.id} ${source}：${clip(entry.summary, MAX_EVIDENCE_SUMMARY_CHARS)}`)
    }
  }

  if (verification !== undefined && verification.verdict !== 'complete') {
    lines.push('当前验证：任务尚未完成。')
    lines.push(`原因：${verification.reason}`)
    if (verification.missingEvidence?.length) {
      lines.push(`缺失：${verification.missingEvidence.join('；')}`)
    }
    if (verification.nextAction) {
      lines.push(`下一步：${verification.nextAction}`)
    }
  }
  if (verification?.verdict === 'replan') {
    lines.push('计划已更新：不要重复导致失败的旧路线，按新计划执行。')
  }

  lines.push(TASK_EXECUTION_POLICY)
  return lines.join('\n')
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}
