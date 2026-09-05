import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isResumableTaskStatus, type CuriTask, type TaskEvidence, type TaskStatus, type TaskStep } from './taskTypes'

/**
 * Atomic JSON persistence for Curi tasks — same strategy as
 * ExecutionLedgerRepository: write a temp file and rename over the primary,
 * keep a backup of the previous good state, and fall back to the backup when
 * the primary file is corrupt. Plain JSON by design: no SQLite, no ORM.
 */
export class TaskRepository {
  readonly #filePath: string
  readonly #backupPath: string

  constructor(filePath: string, backupPath = `${filePath}.backup`) {
    this.#filePath = filePath
    this.#backupPath = backupPath
  }

  async load(): Promise<CuriTask[]> {
    const primary = await readTasks(this.#filePath)
    if (primary !== null) return primary
    return await readTasks(this.#backupPath) ?? []
  }

  async save(tasks: readonly CuriTask[]): Promise<void> {
    const directory = path.dirname(this.#filePath)
    await mkdir(directory, { recursive: true })
    await copyFile(this.#filePath, this.#backupPath).catch((error: unknown) => {
      if (!hasErrorCode(error, 'ENOENT')) throw error
    })
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID().replaceAll('-', '')}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.#filePath)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

async function readTasks(filePath: string): Promise<CuriTask[] | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    if (!Array.isArray(parsed)) return null
    return parsed.filter(isCuriTask)
  } catch (error) {
    if (error instanceof SyntaxError || hasErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

function isCuriTask(value: unknown): value is CuriTask {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string'
    && typeof task.sessionId === 'string'
    && typeof task.objective === 'string'
    && typeof task.status === 'string'
    && TASK_STATUSES.has(task.status as TaskStatus)
    && Array.isArray(task.steps)
    && task.steps.every(isTaskStep)
    && isStringArray(task.completionCriteria)
    && isStringArray(task.constraints)
    && Array.isArray(task.evidence)
    && task.evidence.every(isTaskEvidence)
    && (task.currentStepId === undefined || typeof task.currentStepId === 'string')
    && typeof task.planVersion === 'number'
    && typeof task.replanCount === 'number'
    && (task.blockedReason === undefined || typeof task.blockedReason === 'string')
    && (task.pauseReason === undefined || typeof task.pauseReason === 'string')
    && typeof task.createdAt === 'number'
    && typeof task.updatedAt === 'number'
    && (task.completedAt === undefined || typeof task.completedAt === 'number')
}

function isTaskStep(value: unknown): value is TaskStep {
  if (typeof value !== 'object' || value === null) return false
  const step = value as Record<string, unknown>
  return typeof step.id === 'string'
    && typeof step.title === 'string'
    && (step.description === undefined || typeof step.description === 'string')
    && typeof step.status === 'string'
    && STEP_STATUSES.has(step.status as TaskStep['status'])
    && isStringArray(step.completionCriteria)
    && isStringArray(step.evidenceIds)
    && (step.error === undefined || typeof step.error === 'string')
}

function isTaskEvidence(value: unknown): value is TaskEvidence {
  if (typeof value !== 'object' || value === null) return false
  const evidence = value as Record<string, unknown>
  return typeof evidence.id === 'string'
    && typeof evidence.type === 'string'
    && EVIDENCE_TYPES.has(evidence.type as TaskEvidence['type'])
    && (evidence.toolCallId === undefined || typeof evidence.toolCallId === 'string')
    && (evidence.toolName === undefined || typeof evidence.toolName === 'string')
    && typeof evidence.status === 'string'
    && EVIDENCE_STATUSES.has(evidence.status as TaskEvidence['status'])
    && typeof evidence.summary === 'string'
    && typeof evidence.createdAt === 'number'
}

/** The latest planning/running/paused/blocked task of a session, if any. */
export function findResumableTask(tasks: readonly CuriTask[], sessionId: string): CuriTask | undefined {
  return tasks
    .filter((task) => task.sessionId === sessionId && isResumableTaskStatus(task.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

const TASK_STATUSES = new Set<string>([
  'planning', 'running', 'paused', 'blocked', 'completed', 'cancelled',
])

const STEP_STATUSES = new Set<string>([
  'pending', 'active', 'completed', 'failed', 'skipped',
])

const EVIDENCE_TYPES = new Set<string>(['tool-result', 'verification', 'user'])

const EVIDENCE_STATUSES = new Set<string>(['supporting', 'contradicting', 'unknown'])

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
