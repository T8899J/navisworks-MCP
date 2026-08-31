import { AgentRuntimeError } from './types'

/** Bounded snippet of an HTTP error body so failures stay readable. */
export function readErrorSnippet(responseBody: string): string {
  try {
    const value: unknown = JSON.parse(responseBody)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const error = (value as Record<string, unknown>).error
      if (typeof error === 'string') {
        return error
      }
    }
  } catch {
    // Not JSON — fall through to the bounded raw body.
  }
  return responseBody.length <= 500 ? responseBody : responseBody.slice(0, 500)
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentRuntimeError('MODEL_INVALID_RESPONSE', `${label} 格式无效。`)
  }
  return value as Record<string, unknown>
}

export function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer.`)
  }
  return value
}

/**
 * Tool arguments arrive either as an object or as a JSON string (OpenAI
 * streams arguments as string fragments that we join before parsing).
 */
export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === '') {
    return {}
  }
  if (typeof value === 'string') {
    try {
      return parseToolArguments(JSON.parse(value))
    } catch (error) {
      throw new AgentRuntimeError(
        'MODEL_INVALID_RESPONSE',
        `工具 arguments 不是有效 JSON：${errorMessage(error)}`,
        { cause: error },
      )
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentRuntimeError('MODEL_INVALID_RESPONSE', '工具 arguments 必须是对象或 JSON 字符串。')
  }
  return value as Record<string, unknown>
}

export function linkAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abortFromFirst = (): void => controller.abort(first?.reason)
  const abortFromSecond = (): void => controller.abort(second.reason)

  first?.addEventListener('abort', abortFromFirst, { once: true })
  second.addEventListener('abort', abortFromSecond, { once: true })
  if (first?.aborted) {
    abortFromFirst()
  } else if (second.aborted) {
    abortFromSecond()
  }

  return {
    signal: controller.signal,
    dispose: () => {
      first?.removeEventListener('abort', abortFromFirst)
      second.removeEventListener('abort', abortFromSecond)
    },
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason)
  }
}

/** Keeps an abort signal effective while a streaming response is being read. */
export async function readStreamChunk<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  if (!signal) return await reader.read()
  if (signal.aborted) throw createAbortError(signal.reason)

  return await new Promise<ReadableStreamReadResult<T>>((resolve, reject) => {
    const abort = (): void => reject(createAbortError(signal.reason))
    signal.addEventListener('abort', abort, { once: true })
    void reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

export function createAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason
  }
  const error = new Error(
    reason instanceof Error ? reason.message : 'The operation was aborted.',
    reason instanceof Error ? { cause: reason } : undefined,
  )
  error.name = 'AbortError'
  return error
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Stable-ish identity for "the model called the same tool with the same input". */
export function toolCallKey(name: string, args: Record<string, unknown>): string {
  return `${name}|${stableStringify(args)}`
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
