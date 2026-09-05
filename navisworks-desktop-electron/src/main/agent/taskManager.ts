import { randomUUID } from 'node:crypto'
import { findResumableTask, TaskRepository } from './taskRepository'
import {
  assertTaskTransition,
  type CuriTask,
  type TaskEvidence,
  type TaskPauseReason,
  type TaskStep,
} from './taskTypes'

export interface TaskStepInput {
  title: string
  description?: string
  completionCriteria: string[]
}

export interface CreateTaskInput {
  sessionId: string
  objective: string
  constraints?: string[]
  completionCriteria?: string[]
  steps: TaskStepInput[]
}

/** A verifier's structured answer, applied to steps and recorded as evidence. */
export interface TaskVerification {
  verdict: 'complete' | 'continue' | 'replan' | 'blocked'
  reason: string
  stepUpdates?: Array<{
    stepId: string
    status: TaskStep['status']
    evidenceIds?: string[]
  }>
  missingEvidence?: string[]
  nextAction?: string
  blockedReason?: string
}

export interface EvidenceInput {
  toolCallId: string
  toolName: string
  status: TaskEvidence['status']
  summary: string
}

/**
 * Owns task lifecycle: create → plan → run → (verify → continue/replan/block) →
 * complete, plus evidence bookkeeping. Every mutation stamps `updatedAt` and
 * persists immediately (serialized writes). Illegal status transitions throw.
 */
export class TaskManager {
  readonly #tasks = new Map<string, CuriTask>()
  readonly #repository: TaskRepository | undefined
  #writeTail: Promise<void> = Promise.resolve()

  constructor(repository?: TaskRepository) {
    this.#repository = repository
  }

  async initialize(): Promise<void> {
    if (this.#repository === undefined) return
    const persisted = await this.#repository.load()
    const recovered = this.recoverFrom(persisted)
    if (recovered) await this.#persist()
  }

  /**
   * Crash recovery: a task found planning/running on disk means the process
   * died mid-execution. Like ExecutionLedger's executing → ambiguous rule,
   * recovery is conservative — pause, never auto-continue tool calls.
   */
  recoverFrom(persisted: readonly CuriTask[]): boolean {
    this.#tasks.clear()
    let changed = false
    for (const task of persisted) {
      const safe: CuriTask = task.status === 'planning' || task.status === 'running'
        ? { ...task, status: 'paused', pauseReason: 'PROCESS_INTERRUPTED' }
        : { ...task }
      if (safe !== task) changed = true
      this.#tasks.set(safe.id, safe)
    }
    return changed
  }

  all(): CuriTask[] {
    return [...this.#tasks.values()].map((task) => ({ ...task }))
  }

  getTask(taskId: string): CuriTask | undefined {
    const task = this.#tasks.get(taskId)
    return task ? { ...task } : undefined
  }

  getResumableTaskForSession(sessionId: string): CuriTask | undefined {
    const task = findResumableTask(this.all(), sessionId)
    return task ? { ...task } : undefined
  }

  async createTask(input: CreateTaskInput): Promise<CuriTask> {
    const now = Date.now()
    const task: CuriTask = {
      id: randomUUID(),
      sessionId: input.sessionId,
      objective: input.objective,
      status: 'planning',
      steps: input.steps.map((step, index) => ({
        id: String(index + 1),
        title: step.title,
        ...(step.description === undefined ? {} : { description: step.description }),
        status: 'pending' as const,
        completionCriteria: [...step.completionCriteria],
        evidenceIds: [],
      })),
      completionCriteria: [...(input.completionCriteria ?? [])],
      constraints: [...(input.constraints ?? [])],
      evidence: [],
      planVersion: 1,
      replanCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.#tasks.set(task.id, task)
    await this.#persist()
    return { ...task }
  }

  async markRunning(taskId: string): Promise<CuriTask> {
    return this.#mutate(taskId, (task) => {
      assertTaskTransition(task.status, 'running')
      task.status = 'running'
      task.pauseReason = undefined
      task.blockedReason = undefined
      task.currentStepId = nextActiveStepId(task)
    })
  }

  async recordToolEvidence(taskId: string, input: EvidenceInput): Promise<CuriTask> {
    return this.#mutate(taskId, (task) => {
      task.evidence.push({
        id: nextEvidenceId(task),
        type: 'tool-result',
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        status: input.status,
        summary: input.summary,
        createdAt: Date.now(),
      })
    })
  }

  async recordVerificationEvidence(taskId: string, verification: TaskVerification): Promise<CuriTask> {
    return this.#mutate(taskId, (task) => {
      const missing = verification.missingEvidence?.length
        ? `；缺失：${verification.missingEvidence.join('；')}`
        : ''
      task.evidence.push({
        id: nextEvidenceId(task),
        type: 'verification',
        status: verification.verdict === 'complete'
          ? 'supporting'
          : verification.verdict === 'continue'
            ? 'unknown'
            : 'contradicting',
        summary: `验证结论 ${verification.verdict}：${verification.reason}${missing}`,
        createdAt: Date.now(),
      })
    })
  }

  /** Apply a verifier's step updates, then record the verdict itself as evidence. */
  async applyVerification(taskId: string, verification: TaskVerification): Promise<CuriTask> {
    const knownEvidence = new Set(this.#tasks.get(taskId)?.evidence.map((entry) => entry.id) ?? [])
    await this.recordVerificationEvidence(taskId, verification)
    return this.#mutate(taskId, (task) => {
      for (const update of verification.stepUpdates ?? []) {
        const step = task.steps.find((candidate) => candidate.id === update.stepId)
        if (step === undefined) continue
        step.status = update.status
        for (const evidenceId of update.evidenceIds ?? []) {
          if (knownEvidence.has(evidenceId) && !step.evidenceIds.includes(evidenceId)) {
            step.evidenceIds.push(evidenceId)
          }
        }
      }
      if (verification.verdict === 'blocked' && verification.blockedReason !== undefined) {
        task.blockedReason = verification.blockedReason
      }
      task.currentStepId = nextActiveStepId(task)
    })
  }

  /**
   * Replan: replace the plan in place, keeping every piece of already-collected
   * evidence — a new route must not erase verified facts from the old one.
   */
  async replacePlan(
    taskId: string,
    plan: { objective?: string; completionCriteria?: string[]; steps: TaskStepInput[] },
  ): Promise<CuriTask> {
    return this.#mutate(taskId, (task) => {
      if (plan.objective !== undefined && plan.objective.trim() !== '' && plan.objective !== task.objective) {
        task.objective = plan.objective
      }
      if (plan.completionCriteria !== undefined && plan.completionCriteria.length > 0) {
        task.completionCriteria = [...plan.completionCriteria]
      }
      task.planVersion += 1
      task.replanCount += 1
      task.steps = plan.steps.map((step, index) => ({
        id: String(index + 1),
        title: step.title,
        ...(step.description === undefined ? {} : { description: step.description }),
        status: 'pending' as const,
        completionCriteria: [...step.completionCriteria],
        evidenceIds: [],
      }))
      task.currentStepId = nextActiveStepId(task)
    })
  }

  async pause(taskId: string, reason: TaskPauseReason): Promise<CuriTask> {
    return this.#mutate(taskId, (task) => {
      assertTaskTransition(task.status, 'paused')
      task.status = 'paused'
      task.pauseReason = reason
    })
  }

  async block(taskId: string, reason: string): Promise<CuriTask> {
    return this.#mutate(taskId, (task) => {
      assertTaskTransition(task.status, 'blocked')
      task.status = 'blocked'
      task.blockedReason = reason
    })
  }

  async complete(taskId: string): Promise<CuriTask> {
    return this.#mutate(taskId, (task) => {
      assertTaskTransition(task.status, 'completed')
      task.status = 'completed'
      task.completedAt = Date.now()
      task.blockedReason = undefined
      task.pauseReason = undefined
    })
  }

  async cancel(taskId: string): Promise<CuriTask> {
    return this.#mutate(taskId, (task) => {
      assertTaskTransition(task.status, 'cancelled')
      task.status = 'cancelled'
    })
  }

  async deleteBySession(sessionId: string): Promise<void> {
    let removed = false
    for (const task of this.#tasks.values()) {
      if (task.sessionId === sessionId) {
        this.#tasks.delete(task.id)
        removed = true
      }
    }
    if (removed) await this.#persist()
  }

  async #mutate(taskId: string, mutate: (task: CuriTask) => void): Promise<CuriTask> {
    const task = this.#tasks.get(taskId)
    if (task === undefined) throw new Error(`Task not found: ${taskId}`)
    mutate(task)
    task.updatedAt = Date.now()
    await this.#persist()
    return { ...task }
  }

  async #persist(): Promise<void> {
    if (this.#repository === undefined) return
    const save = async (): Promise<void> => this.#repository?.save(this.all())
    const pending = this.#writeTail.then(save, save)
    this.#writeTail = pending.then(() => undefined, () => undefined)
    await pending
  }
}

function nextActiveStepId(task: CuriTask): string | undefined {
  const step = task.steps.find((candidate) => candidate.status === 'active' || candidate.status === 'pending')
  return step?.id
}

function nextEvidenceId(task: CuriTask): string {
  const used = new Set(task.evidence.map((entry) => entry.id))
  let index = task.evidence.length + 1
  while (used.has(`e${index}`)) index += 1
  return `e${index}`
}
