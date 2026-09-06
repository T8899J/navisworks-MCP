import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Bounded tool-output store: the FULL result of a large tool call is kept on
 * disk, while the model only receives a small preview plus a `resultRef` it
 * can page through via the internal `read_tool_result` tool.
 *
 * - Small results stay fully inline (no file, no ref).
 * - Large results are written ONCE per tool execution (never per token).
 * - `resultRef` is a random internal id; the model can never express a path.
 * - Cleanup is best-effort; failures never break a run or a session load.
 */

/** Results above this size are externalized to the store (Runtime Policy — not user-configurable). */
export const TOOL_OUTPUT_MAX_INLINE_BYTES = 50_000
/** Preview item count for large array-shaped results. */
export const TOOL_OUTPUT_PREVIEW_ITEMS = 50
/** Hard cap for one read_tool_result page. */
export const TOOL_OUTPUT_READ_LIMIT_MAX = 100
/** Best-effort retention for stored outputs. */
export const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** `tor_<uuid>` — random, unguessable, and the ONLY thing the model may pass. */
const REF_PATTERN = /^tor_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface BoundedToolOutput {
  /** What the model receives: the full small result, or a preview + resultRef. */
  content: unknown
  resultRef?: string
  truncated: boolean
}

export interface StoredToolOutput {
  resultRef: string
  sessionId: string
  toolCallId: string
  toolName: string
  createdAt: number
  data: unknown
}

export interface StoredToolOutputPage {
  resultRef: string
  offset: number
  returned: number
  total: number
  hasMore: boolean
  items?: readonly unknown[]
  data?: unknown
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ToolOutputStore {
  readonly #directory: string

  constructor(directory: string) {
    this.#directory = directory
  }

  get directory(): string {
    return this.#directory
  }

  /**
   * Bound a raw tool result for the model: small results pass through
   * untouched; large ones are stored in full and reduced to a preview that
   * keeps the original pagination metadata (total/truncated) intact.
   */
  async bound(input: {
    sessionId: string
    toolCallId: string
    toolName: string
    data: unknown
  }): Promise<BoundedToolOutput> {
    const serialized = JSON.stringify(input.data) ?? 'null'
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes <= TOOL_OUTPUT_MAX_INLINE_BYTES) {
      return { content: input.data, truncated: false }
    }

    const resultRef = `tor_${randomUUID()}`
    try {
      await mkdir(this.#directory, { recursive: true })
      const stored: StoredToolOutput = {
        resultRef,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        createdAt: Date.now(),
        data: input.data,
      }
      await writeFile(
        path.join(this.#directory, `${resultRef}.json`),
        JSON.stringify(stored),
        'utf8',
      )
    } catch (error) {
      // Write failed: degrade to a short preview with an explicit note — the
      // chat run must never pend on tool-output durability.
      console.debug(`[tool-output] store failed: ${errorMessageOf(error)}`)
      return { content: this.buildPreview(input.data, undefined, true), truncated: true }
    }
    return { content: this.buildPreview(input.data, resultRef, true), resultRef, truncated: true }
  }

  /**
   * Page through a stored result. `resultRef` is the ONLY accepted handle —
   * it maps to a file inside the store directory, so no traversal or
   * arbitrary-file read is possible.
   */
  async read(resultRef: string, offset = 0, limit = 50): Promise<StoredToolOutputPage> {
    if (!REF_PATTERN.test(resultRef)) {
      return { resultRef, offset: 0, returned: 0, total: 0, hasMore: false, error: 'invalid resultRef' }
    }
    const safeOffset = Math.max(0, Math.trunc(offset))
    const safeLimit = Math.min(TOOL_OUTPUT_READ_LIMIT_MAX, Math.max(1, Math.trunc(limit)))
    let stored: StoredToolOutput
    try {
      const raw = await readFile(path.join(this.#directory, `${resultRef}.json`), 'utf8')
      stored = JSON.parse(raw) as StoredToolOutput
    } catch (error) {
      const missing = isErrnoException(error) && error.code === 'ENOENT'
      return {
        resultRef,
        offset: safeOffset,
        returned: 0,
        total: 0,
        hasMore: false,
        error: missing
          ? 'tool result expired or unavailable'
          : `tool result unreadable: ${errorMessageOf(error)}`,
      }
    }

    const data = stored.data
    if (isRecord(data) && Array.isArray(data.items)) {
      const items = data.items as unknown[]
      const page = items.slice(safeOffset, safeOffset + safeLimit)
      return {
        resultRef,
        offset: safeOffset,
        returned: page.length,
        total: items.length,
        hasMore: safeOffset + page.length < items.length,
        items: page,
        ...(typeof data.total === 'number' ? { data: { total: data.total } } : {}),
      }
    }
    if (Array.isArray(data)) {
      const page = data.slice(safeOffset, safeLimit)
      return {
        resultRef,
        offset: safeOffset,
        returned: page.length,
        total: data.length,
        hasMore: safeOffset + page.length < data.length,
        items: page,
      }
    }
    return {
      resultRef,
      offset: 0,
      returned: 1,
      total: 1,
      hasMore: false,
      data,
    }
  }

  /** Best-effort cleanup of outputs older than maxAgeMs; never throws. */
  async cleanup(maxAgeMs = TOOL_OUTPUT_RETENTION_MS): Promise<number> {
    try {
      const entries = await readdir(this.#directory)
      const now = Date.now()
      let removed = 0
      for (const entry of entries) {
        if (!entry.startsWith('tor_') || !entry.endsWith('.json')) continue
        try {
          const full = path.join(this.#directory, entry)
          const info = await stat(full)
          if (now - info.mtimeMs > maxAgeMs) {
            await rm(full, { force: true })
            removed += 1
          }
        } catch {
          // Skip the individual file; cleanup stays best-effort.
        }
      }
      return removed
    } catch {
      return 0
    }
  }

  /**
   * Preview for an oversized result. Array-shaped payloads keep their
   * pagination metadata (total/truncated) plus the first preview items;
   * anything else degrades to a short serialized excerpt.
   */
  buildPreview(data: unknown, resultRef: string | undefined, truncated: boolean): unknown {
    if (isRecord(data) && Array.isArray(data.items)) {
      const items = data.items as unknown[]
      return {
        ...data,
        items: items.slice(0, TOOL_OUTPUT_PREVIEW_ITEMS),
        returned: Math.min(TOOL_OUTPUT_PREVIEW_ITEMS, items.length),
        total: typeof data.total === 'number' ? data.total : items.length,
        truncated: true,
        ...(resultRef === undefined ? {} : { resultRef }),
      }
    }
    if (Array.isArray(data)) {
      return {
        items: data.slice(0, TOOL_OUTPUT_PREVIEW_ITEMS),
        returned: Math.min(TOOL_OUTPUT_PREVIEW_ITEMS, data.length),
        total: data.length,
        truncated: true,
        ...(resultRef === undefined ? {} : { resultRef }),
      }
    }
    const serialized = JSON.stringify(data) ?? 'null'
    return {
      preview: serialized.length > 2_000 ? `${serialized.slice(0, 2_000)}…` : serialized,
      truncated: true,
      ...(resultRef === undefined ? {} : { resultRef }),
    }
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
