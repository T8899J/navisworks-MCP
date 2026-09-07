import { randomUUID } from 'node:crypto'
import {
  createAbortError,
} from '../model/providerUtils'
import type {
  QuestionAnswer,
  QuestionDispatch,
  QuestionOutcome,
  QuestionRequest,
  QuestionRequestInput,
} from './types'

/**
 * Second pending question for a run that already has one — the caller turns
 * this into an INVALID tool result, never a crash (§8/§13).
 */
export class QuestionAlreadyPendingError extends Error {
  constructor(readonly runId: string) {
    super(`该 Run 已有一个等待回答的问题：${runId}`)
    this.name = 'QuestionAlreadyPendingError'
  }
}

interface PendingQuestion {
  request: QuestionRequest
  resolve: (outcome: QuestionOutcome) => void
  reject: (error: unknown) => void
}

/**
 * P16 QuestionService — the main-process pending-question registry. The Run
 * SUSPENDS by awaiting ask()'s promise; the original run resumes the moment
 * answer()/reject() resolves it. Process-memory only (§19): a pending
 * question is never a durable run state, and app exit ends the run anyway.
 *
 * No polling, no timers: deferred promises only (§7). The `dispatch` callback
 * (per ask, closing over the run's WebContents sender — exactly how tool
 * approvals route) pushes the `question.requested` event to the renderer.
 */
export class QuestionService {
  readonly #pending = new Map<string, PendingQuestion>()

  /**
   * Register the question, push the `question.requested` event through the
   * dispatch callback, and await the user's answer. The optional AbortSignal
   * (§79) rejects the pending promise immediately on abort so no run — and no
   * promise — can hang forever (Invariant D).
   */
  async ask(
    input: QuestionRequestInput,
    dispatch: QuestionDispatch,
    signal?: AbortSignal,
  ): Promise<QuestionOutcome> {
    for (const pending of this.#pending.values()) {
      if (pending.request.runId === input.runId) {
        throw new QuestionAlreadyPendingError(input.runId)
      }
    }
    const request: QuestionRequest = {
      ...input,
      requestId: randomUUID(),
      createdAt: Date.now(),
    }
    if (signal?.aborted) {
      throw createAbortError(signal.reason)
    }
    try {
      return await new Promise<QuestionOutcome>((resolve, reject) => {
        const entry: PendingQuestion = {
          request,
          resolve: (outcome) => {
            cleanup()
            this.#pending.delete(request.requestId)
            resolve(outcome)
          },
          reject: (error) => {
            cleanup()
            this.#pending.delete(request.requestId)
            reject(error)
          },
        }
        const onAbort = (): void => entry.reject(createAbortError(signal?.reason))
        const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
        this.#pending.set(request.requestId, entry)
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
          dispatch(request)
        } catch (dispatchError) {
          entry.reject(dispatchError)
        }
      })
    } finally {
      // Belt-and-braces: whatever the settle path, the entry is gone.
      this.#pending.delete(request.requestId)
    }
  }

  /** The pending request for a renderer that just re-attached to a session (§18). */
  getRequest(requestId: string): QuestionRequest | undefined {
    return this.#pending.get(requestId)?.request
  }

  /**
   * Resolve with the user's answers. Returns false for an unknown/stale
   * requestId (the run already ended) — never throws across a session switch.
   */
  answer(requestId: string, answers: readonly QuestionAnswer[]): boolean {
    const entry = this.#pending.get(requestId)
    if (entry === undefined) return false
    entry.resolve({ kind: 'answered', answers })
    return true
  }

  /** Decline: the tool result becomes question_rejected (§11). */
  reject(requestId: string): boolean {
    const entry = this.#pending.get(requestId)
    if (entry === undefined) return false
    entry.resolve({ kind: 'rejected' })
    return true
  }

  /** Run abort: every pending promise for the run rejects (no leak, §20). */
  abortRun(runId: string): number {
    return this.#abortWhere((request) => request.runId === runId, 'run')
  }

  /** Session delete/abort: reject its pending questions (§20). */
  abortSession(sessionId: string): number {
    return this.#abortWhere((request) => request.sessionId === sessionId, 'session')
  }

  /** App shutdown: reject every pending (§20). */
  abortAll(): void {
    this.#abortWhere(() => true, 'all')
  }

  listPending(sessionId?: string): readonly QuestionRequest[] {
    return [...this.#pending.values()]
      .map((entry) => entry.request)
      .filter((request) => sessionId === undefined || request.sessionId === sessionId)
  }

  get pendingCount(): number {
    return this.#pending.size
  }

  #abortWhere(
    predicate: (request: QuestionRequest) => boolean,
    reason: 'run' | 'session' | 'all',
  ): number {
    let aborted = 0
    for (const [requestId, entry] of [...this.#pending.entries()]) {
      if (!predicate(entry.request)) continue
      this.#pending.delete(requestId)
      entry.reject(createAbortError(new Error(`问题已取消（${reason}）。`)))
      aborted += 1
    }
    return aborted
  }
}
