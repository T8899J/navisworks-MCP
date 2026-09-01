import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Large-result externalization (P3). Results are still persisted in `sessions.json` by the
 * existing session store; this only moves payloads above a byte threshold to
 * `userData/tool-results/` and replaces the inline value with a small {@link ToolResultRef}.
 * Below the threshold the original value is stored untouched — no new Session Store.
 */
export const EXTERNALIZED_TOOL_RESULT_MARKER = '__externalizedToolResult'
export const DEFAULT_EXTERNALIZE_THRESHOLD_BYTES = 256 * 1024
export const TOOL_RESULTS_DIRECTORY_NAME = 'tool-results'

export interface ToolResultRef {
  [EXTERNALIZED_TOOL_RESULT_MARKER]: true
  refId: string
  preview: string
  byteLength: number
}

export function toolResultsDirectory(rootDirectory: string): string {
  return path.join(rootDirectory, TOOL_RESULTS_DIRECTORY_NAME)
}

export function isExternalizedResult(value: unknown): value is ToolResultRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>)[EXTERNALIZED_TOOL_RESULT_MARKER] === true
}

/** Turn any tool call id into a filesystem-safe file name (collision-resistant enough). */
function refFileName(refId: string): string {
  return `${refId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`
}

function makePreview(serialized: string): string {
  return serialized.length > 400 ? `${serialized.slice(0, 400)}…` : serialized
}

/**
 * Write `raw` to disk only if it exceeds `thresholdBytes`; return the ref that should
 * replace the inline value. Returns null when the value should stay inline.
 */
export async function externalizeResult(
  directory: string,
  refId: string,
  raw: unknown,
  thresholdBytes: number = DEFAULT_EXTERNALIZE_THRESHOLD_BYTES,
): Promise<ToolResultRef | null> {
  const serialized = JSON.stringify(raw) ?? ''
  const byteLength = Buffer.byteLength(serialized, 'utf8')
  if (byteLength <= thresholdBytes) return null
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, refFileName(refId)), serialized, 'utf8')
  return {
    [EXTERNALIZED_TOOL_RESULT_MARKER]: true,
    refId,
    preview: makePreview(serialized),
    byteLength,
  }
}

/**
 * Read the full payload back if the value is an externalized ref; otherwise return it
 * unchanged. This is what runtime recall calls so the agent can see more than the
 * truncated summary without re-inventing a database.
 */
export async function resolveResult(
  directory: string,
  value: unknown,
): Promise<unknown> {
  if (!isExternalizedResult(value)) return value
  try {
    const text = await readFile(path.join(directory, refFileName(value.refId)), 'utf8')
    return JSON.parse(text) as unknown
  } catch {
    // Corrupt / missing payload: fall back to the preview so callers still get a string.
    return value.preview
  }
}

/**
 * Delete externalized payloads not referenced by any current session. Returns the number
 * of files removed. `keepRefIds` is the set of refIds still present in persisted sessions.
 */
export async function pruneExternalizedResults(
  directory: string,
  keepRefIds: ReadonlySet<string>,
): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return 0 // directory absent → nothing to prune
  }
  // Compare by FILE NAME: refIds may contain characters that refFileName sanitizes away,
  // so a raw refId never equals its on-disk stem. Map the keep set the same way we write.
  const keepFiles = new Set([...keepRefIds].map(refFileName))
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.json') || keepFiles.has(entry)) continue
    try {
      await rm(path.join(directory, entry), { force: true })
      removed += 1
    } catch {
      // Best-effort cleanup; a locked file is retried on the next prune.
    }
  }
  return removed
}

/** Scan sessions and collect every refId still referenced (used to build `keepRefIds`). */
export function collectLiveRefIds(sessions: readonly {
  messages?: readonly { tools?: readonly { result?: unknown }[] }[] | null
}[]): Set<string> {
  const refs = new Set<string>()
  for (const session of sessions) {
    for (const message of session.messages ?? []) {
      for (const tool of message.tools ?? []) {
        if (isExternalizedResult(tool.result)) refs.add(tool.result.refId)
      }
    }
  }
  return refs
}
