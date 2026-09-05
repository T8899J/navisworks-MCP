/**
 * Curi Task System v1 — data types and lifecycle rules.
 *
 * A task answers exactly one question: "is the current real task done, and
 * what is the next step?" It is deliberately NOT a second memory: Semantic
 * Memory keeps user goals/constraints/decisions across sessions; a CuriTask
 * is the run state of the one job in flight (plan, progress, evidence,
 * verification). Tool success is never conflated with task success — only
 * completion criteria backed by evidence may mark a task completed.
 */

export type TaskStatus =
  | 'planning'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'cancelled'

export type TaskStepStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface TaskStep {
  id: string
  title: string
  description?: string
  status: TaskStepStatus
  completionCriteria: string[]
  evidenceIds: string[]
  error?: string
}

export interface TaskEvidence {
  id: string
  type: 'tool-result' | 'verification' | 'user'
  toolCallId?: string
  toolName?: string
  status: 'supporting' | 'contradicting' | 'unknown'
  summary: string
  createdAt: number
}

export interface CuriTask {
  id: string
  sessionId: string
  objective: string
  status: TaskStatus
  steps: TaskStep[]
  completionCriteria: string[]
  constraints: string[]
  evidence: TaskEvidence[]
  currentStepId?: string
  planVersion: number
  replanCount: number
  blockedReason?: string
  pauseReason?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
}

/**
 * Why a task ended up paused. PROCESS_INTERRUPTED is the conservative crash
 * recovery state (running/planning on disk → paused, never auto-resumed),
 * mirroring ExecutionLedger's executing → ambiguous rule.
 */
export type TaskPauseReason =
  | 'PROCESS_INTERRUPTED'
  | 'TOOL_ROUND_LIMIT'
  | 'MODEL_ERROR'
  | 'USER_ABORTED'
  | 'VERIFIER_ERROR'
  | 'REPLAN_FAILED'

/** A verifier verdict may not replan forever — past this the task blocks. */
export const MAX_TASK_REPLANS = 2

/** blockedReason set when the replan budget is exhausted. */
export const REPLAN_LIMIT_REASON = 'REPLAN_LIMIT'

/** Legal status transitions. Terminal states accept nothing; paused and
 * blocked may only re-enter running when the runtime actually acts again. */
const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  planning: ['running', 'paused', 'cancelled'],
  running: ['completed', 'paused', 'blocked', 'cancelled'],
  paused: ['running', 'cancelled'],
  blocked: ['running', 'cancelled'],
  completed: [],
  cancelled: [],
}

export class TaskStateTransitionError extends Error {
  constructor(readonly from: TaskStatus, readonly to: TaskStatus) {
    super(`Invalid task transition: ${from} -> ${to}`)
    this.name = 'TaskStateTransitionError'
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new TaskStateTransitionError(from, to)
  }
}

/** States a session can resume from; completed/cancelled never resume. */
export function isResumableTaskStatus(status: TaskStatus): boolean {
  return status === 'planning' || status === 'running' || status === 'paused' || status === 'blocked'
}
