import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type ToolExecutionStatus =
  | 'requested'
  | 'awaiting-approval'
  | 'approved'
  | 'executing'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'ambiguous'
  | 'resolved'

export interface ToolExecutionRecord {
  runId: string
  toolCallId: string
  toolName: string
  argumentsHash: string
  instanceId?: string
  bridgeSessionId?: string
  documentInstanceId: string | undefined
  status: ToolExecutionStatus
  startedAt?: number
  finishedAt?: number
  errorCode?: string
}

const TERMINAL = new Set<ToolExecutionStatus>([
  'success', 'failed', 'cancelled', 'ambiguous', 'resolved',
])

const TRANSITIONS: Record<ToolExecutionStatus, readonly ToolExecutionStatus[]> = {
  requested: ['awaiting-approval'],
  'awaiting-approval': ['approved', 'cancelled'],
  approved: ['executing', 'cancelled'],
  executing: ['success', 'failed', 'ambiguous'],
  success: [],
  failed: [],
  cancelled: [],
  ambiguous: ['resolved'],
  resolved: [],
}

/** Atomic JSON persistence for modifying-operation history. */
export class ExecutionLedgerRepository {
  readonly #filePath: string
  readonly #backupPath: string

  constructor(filePath: string, backupPath = `${filePath}.backup`) {
    this.#filePath = filePath
    this.#backupPath = backupPath
  }

  async load(): Promise<ToolExecutionRecord[]> {
    const primary = await readRecords(this.#filePath)
    if (primary !== null) return primary
    return await readRecords(this.#backupPath) ?? []
  }

  async save(records: readonly ToolExecutionRecord[]): Promise<void> {
    const directory = path.dirname(this.#filePath)
    await mkdir(directory, { recursive: true })
    await copyFile(this.#filePath, this.#backupPath).catch((error: unknown) => {
      if (!hasErrorCode(error, 'ENOENT')) throw error
    })
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID().replaceAll('-', '')}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.#filePath)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

/** Durable lifecycle ledger for view-state-changing calls. */
export class ToolExecutionLedger {
  readonly #records = new Map<string, ToolExecutionRecord>()
  readonly #repository: ExecutionLedgerRepository | undefined
  #writeTail: Promise<void> = Promise.resolve()

  constructor(repository?: ExecutionLedgerRepository) {
    this.#repository = repository
  }

  async initialize(): Promise<void> {
    if (this.#repository === undefined) return
    const persisted = await this.#repository.load()
    const hadExecuting = persisted.some((record) => record.status === 'executing')
    this.recoverFrom(persisted)
    if (hadExecuting) await this.#persist()
  }

  get(runId: string, toolCallId: string): ToolExecutionRecord | undefined {
    return this.#records.get(recordKey(runId, toolCallId))
  }

  all(): ToolExecutionRecord[] {
    return [...this.#records.values()].map((record) => ({ ...record }))
  }

  async begin(input: Omit<ToolExecutionRecord, 'status' | 'startedAt'>): Promise<ToolExecutionRecord> {
    const key = recordKey(input.runId, input.toolCallId)
    if (this.#records.has(key)) {
      throw new Error(`Execution record already exists: ${key}`)
    }
    const record: ToolExecutionRecord = { ...input, status: 'requested', startedAt: Date.now() }
    this.#records.set(key, record)
    await this.#persist()
    return { ...record }
  }

  async mark(
    runId: string,
    toolCallId: string,
    status: ToolExecutionStatus,
    errorCode?: string,
  ): Promise<void> {
    const record = this.#records.get(recordKey(runId, toolCallId))
    if (record === undefined) throw new Error(`Execution record not found: ${runId}:${toolCallId}`)
    if (!TRANSITIONS[record.status].includes(status)) {
      throw new Error(`Invalid execution transition: ${record.status} -> ${status}`)
    }
    record.status = status
    if (errorCode !== undefined) record.errorCode = errorCode
    if (TERMINAL.has(status)) record.finishedAt = Date.now()
    await this.#persist()
  }

  findAmbiguous(input: {
    instanceId: string | undefined
    documentInstanceId: string | undefined
    toolName: string
    argumentsHash: string
  }): ToolExecutionRecord | undefined {
    return [...this.#records.values()].find((record) =>
      record.status === 'ambiguous'
      && record.instanceId === input.instanceId
      && record.documentInstanceId === input.documentInstanceId
      && record.toolName === input.toolName
      && record.argumentsHash === input.argumentsHash
    )
  }

  async resolveAmbiguous(record: ToolExecutionRecord, reason: string): Promise<void> {
    await this.mark(record.runId, record.toolCallId, 'resolved', reason)
  }

  recoverFrom(persisted: readonly ToolExecutionRecord[]): ToolExecutionRecord[] {
    this.#records.clear()
    const recovered: ToolExecutionRecord[] = []
    for (const record of persisted) {
      const safe: ToolExecutionRecord = record.status === 'executing'
        ? {
            ...record,
            status: 'ambiguous',
            finishedAt: record.finishedAt ?? Date.now(),
            errorCode: record.errorCode ?? 'PROCESS_INTERRUPTED',
          }
        : { ...record }
      this.#records.set(recordKey(safe.runId, safe.toolCallId), safe)
      recovered.push({ ...safe })
    }
    return recovered
  }

  ambiguous(): ToolExecutionRecord[] {
    return this.all().filter((record) => record.status === 'ambiguous')
  }

  async #persist(): Promise<void> {
    if (this.#repository === undefined) return
    const save = async (): Promise<void> => this.#repository?.save(this.all())
    const pending = this.#writeTail.then(save, save)
    this.#writeTail = pending.then(() => undefined, () => undefined)
    await pending
  }
}

export class DocumentOperationCoordinator {
  readonly #tails = new Map<string, Promise<void>>()

  hasPending(documentInstanceId: string | undefined): boolean {
    return this.#tails.has(documentInstanceId ?? '__no_document__')
  }

  async runExclusive<T>(documentInstanceId: string | undefined, task: () => Promise<T>): Promise<T> {
    const key = documentInstanceId ?? '__no_document__'
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const chained = previous.then(() => gate)
    this.#tails.set(key, chained)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.#tails.get(key) === chained) this.#tails.delete(key)
    }
  }
}

export function hashArguments(args: Record<string, unknown>): string {
  const serialized = JSON.stringify(args, (_key, value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
        .map((key) => [key, (value as Record<string, unknown>)[key]]))
      : value,
  )
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

async function readRecords(filePath: string): Promise<ToolExecutionRecord[] | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    if (!Array.isArray(parsed)) return null
    return parsed.filter(isToolExecutionRecord)
  } catch (error) {
    if (error instanceof SyntaxError || hasErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

function isToolExecutionRecord(value: unknown): value is ToolExecutionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.runId === 'string'
    && typeof record.toolCallId === 'string'
    && typeof record.toolName === 'string'
    && typeof record.argumentsHash === 'string'
    && typeof record.status === 'string'
    && Object.hasOwn(TRANSITIONS, record.status)
    && (record.instanceId === undefined || typeof record.instanceId === 'string')
    && (record.bridgeSessionId === undefined || typeof record.bridgeSessionId === 'string')
    && (record.documentInstanceId === undefined || typeof record.documentInstanceId === 'string')
}

function recordKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
