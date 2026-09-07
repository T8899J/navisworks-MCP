import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ContextDurableUpdate,
  ContextEpoch,
  ContextEpochSeed,
  ContextSourceSnapshot,
} from './types'

/**
 * Durable per-session Context Epoch store: `context-epochs/<sessionId>.json`.
 * One small file per session (never one giant growing JSON), atomic writes via
 * temp+rename — the same persistence style as the session/settings stores.
 *
 * Corruption is FAIL-OPEN (§9): a damaged epoch file is replaced by a fresh
 * epoch, never a crash. The conversation transcript lives in the Session
 * Repository — the epoch stores context lifecycle metadata ONLY (§43).
 */
const EPOCH_FILE_VERSION = 1 as const

export interface ContextEpochLoadResult {
  epoch: ContextEpoch | null
  /** True when a file existed but could not be read as a valid epoch (§69). */
  corrupt: boolean
}

export class ContextEpochStore {
  readonly #directory: string
  readonly #writes: Map<string, Promise<void>> = new Map()

  constructor(directory: string) {
    this.#directory = directory
  }

  get directory(): string {
    return this.#directory
  }

  filePath(sessionId: string): string {
    return path.join(this.#directory, `${sanitizeSessionId(sessionId)}.json`)
  }

  async load(sessionId: string): Promise<ContextEpochLoadResult> {
    let raw: string
    try {
      raw = await readFile(this.filePath(sessionId), 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return { epoch: null, corrupt: false }
      return { epoch: null, corrupt: true }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      const epoch = parseEpoch(parsed, sessionId)
      return epoch === null ? { epoch: null, corrupt: true } : { epoch, corrupt: false }
    } catch {
      return { epoch: null, corrupt: true }
    }
  }

  /**
   * Serialized atomic write per session. Failure never throws into the chat
   * run — an unwritable epoch degrades to "next run starts a fresh epoch",
   * it must not cost the user their reply.
   */
  async save(epoch: ContextEpoch): Promise<boolean> {
    const key = epoch.sessionId
    const previous = this.#writes.get(key) ?? Promise.resolve()
    const operation = previous.then(async () => {
      try {
        await mkdir(this.#directory, { recursive: true })
        const target = this.filePath(key)
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, `${JSON.stringify(epoch, null, 2)}\n`, 'utf8')
          await rename(temporary, target)
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
        return true
      } catch (error) {
        console.debug(`[context] epoch persist failed: ${errorMessageOf(error)}`)
        return false
      }
    })
    const settled = operation.then(() => undefined, () => undefined)
    this.#writes.set(key, settled)
    void settled.then(() => {
      if (this.#writes.get(key) === settled) this.#writes.delete(key)
    })
    return operation
  }

  /** Create a fresh epoch (generation + 1 over the old one when rolling over). */
  initialize(input: {
    sessionId: string
    baseline: string
    baselineHash: string
    baselineVersions: Record<string, number>
    seed?: ContextEpochSeed
    /** Rollover input: the previous epoch (undefined ⇒ first epoch, generation 1). */
    previous?: ContextEpoch
  }): ContextEpoch {
    const now = Date.now()
    const seed = input.seed ?? input.previous?.seed
    return {
      version: EPOCH_FILE_VERSION,
      sessionId: input.sessionId,
      epochId: randomUUID(),
      generation: (input.previous?.generation ?? 0) + 1,
      baseline: input.baseline,
      baselineHash: input.baselineHash,
      baselineVersions: input.baselineVersions,
      ...(seed === undefined ? {} : { seed }),
      snapshot: {},
      updates: [],
      createdAt: now,
      updatedAt: now,
    }
  }

  /** Best-effort cleanup when a session is deleted (§15/§70). Never throws. */
  async forget(sessionId: string): Promise<void> {
    try {
      await rm(this.filePath(sessionId), { force: true })
    } catch (error) {
      console.debug(`[context] epoch delete failed: ${errorMessageOf(error)}`)
    }
  }

  /** Wait for all pending epoch writes (tests / shutdown cleanliness). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.#writes.values()])
  }
}

function parseEpoch(value: unknown, sessionId: string): ContextEpoch | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== EPOCH_FILE_VERSION) return null
  if (typeof record.sessionId !== 'string' || record.sessionId !== sessionId) return null
  if (typeof record.epochId !== 'string' || !record.epochId.trim()) return null
  if (typeof record.baseline !== 'string' || typeof record.baselineHash !== 'string') return null
  if (typeof record.generation !== 'number' || !Number.isInteger(record.generation) || record.generation < 1) {
    return null
  }
  const seed = parseSeed(record.seed)
  const snapshot = parseSnapshot(record.snapshot)
  const updates = parseUpdates(record.updates)
  if (snapshot === null || updates === null) return null
  return {
    version: EPOCH_FILE_VERSION,
    sessionId,
    epochId: record.epochId,
    generation: record.generation,
    baseline: record.baseline,
    baselineHash: record.baselineHash,
    baselineVersions: parseVersions(record.baselineVersions),
    ...(seed === undefined ? {} : { seed }),
    snapshot,
    updates,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  }
}

function parseVersions(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 1) out[key] = entry
  }
  return out
}

function parseSeed(value: unknown): ContextEpochSeed | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== 'compact-summary' || typeof record.text !== 'string') return undefined
  return { kind: 'compact-summary', text: record.text }
}

function parseSnapshot(value: unknown): Record<string, ContextSourceSnapshot> | null {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, ContextSourceSnapshot> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const record = entry as Record<string, unknown>
    if (record.key !== key) return null
    if (typeof record.fingerprint !== 'string' || !record.fingerprint) return null
    if (typeof record.sourceVersion !== 'number' || !Number.isInteger(record.sourceVersion)) return null
    out[key] = {
      key,
      sourceVersion: record.sourceVersion,
      fingerprint: record.fingerprint,
      ...(record.value === undefined ? {} : { value: record.value }),
    }
  }
  return out
}

function parseUpdates(value: unknown): ContextDurableUpdate[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const updates: ContextDurableUpdate[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const record = entry as Record<string, unknown>
    if (typeof record.sequence !== 'number' || !Number.isInteger(record.sequence) || record.sequence < 1) {
      return null
    }
    if (typeof record.sourceKey !== 'string' || !record.sourceKey.trim()) return null
    if (typeof record.fingerprint !== 'string' || !record.fingerprint) return null
    if (typeof record.text !== 'string') return null
    if (typeof record.rendered !== 'string') return null
    if (typeof record.sourceVersion !== 'number' || !Number.isInteger(record.sourceVersion)) return null
    updates.push({
      sequence: record.sequence,
      sourceKey: record.sourceKey,
      sourceVersion: record.sourceVersion,
      fingerprint: record.fingerprint,
      text: record.text,
      rendered: record.rendered,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    })
  }
  return updates.sort((left, right) => left.sequence - right.sequence)
}

/** Session ids are UUIDs; reject any path-active characters regardless. */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || '_'
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
