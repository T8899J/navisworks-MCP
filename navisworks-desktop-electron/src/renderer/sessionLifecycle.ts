import type { ChatSession, SessionSummary } from './chatTypes'

export interface SessionDeletionPlan {
  remaining: SessionSummary[]
  deletedActiveSession: boolean
  nextSessionId?: string
}

/** A small non-reentrant lock for durable session mutations. */
export class SessionTransitionLock {
  #locked = false

  get locked(): boolean {
    return this.#locked
  }

  tryAcquire(): boolean {
    if (this.#locked) return false
    this.#locked = true
    return true
  }

  release(): void {
    this.#locked = false
  }
}

/**
 * Computes the local state transition only after durable deletion succeeds.
 * Keeping this pure makes it harder for an optimistic UI update to orphan the
 * active session when the persistence request fails.
 */
export function planSessionDeletion(
  sessions: readonly SessionSummary[],
  activeSessionId: string | undefined,
  deletedSessionId: string
): SessionDeletionPlan {
  const remaining = sessions.filter((session) => session.id !== deletedSessionId)
  const deletedActiveSession = activeSessionId === deletedSessionId

  return {
    remaining,
    deletedActiveSession,
    nextSessionId: deletedActiveSession ? remaining[0]?.id : activeSessionId
  }
}

export function mergeSessionReplacement(
  latestSessions: readonly SessionSummary[],
  deletedSessionId: string,
  replacement: SessionSummary
): SessionSummary[] {
  return [
    replacement,
    ...latestSessions.filter((session) =>
      session.id !== deletedSessionId && session.id !== replacement.id)
  ]
}

export function removeDeletedSessionDraft(
  drafts: Readonly<Record<string, string>>,
  deletedSessionId: string,
  replacementSessionId?: string
): Record<string, string> {
  const next = { ...drafts }
  const deletedDraft = next[deletedSessionId]
  delete next[deletedSessionId]
  if (
    replacementSessionId &&
    next[replacementSessionId] === undefined &&
    deletedDraft !== undefined
  ) {
    next[replacementSessionId] = deletedDraft
  }
  return next
}

export async function planAfterDurableSessionDeletion(
  deleteDurably: () => Promise<void>,
  getSessions: () => readonly SessionSummary[],
  getActiveSessionId: () => string | undefined,
  deletedSessionId: string
): Promise<SessionDeletionPlan> {
  await deleteDurably()
  return planSessionDeletion(getSessions(), getActiveSessionId(), deletedSessionId)
}

export function shouldApplySessionLoad(
  requestVersion: number,
  currentVersion: number,
  requestedSessionId: string,
  activeSessionId: string | undefined
): boolean {
  return requestVersion === currentVersion && requestedSessionId === activeSessionId
}

export interface SessionReconciliationPlan {
  summaries: SessionSummary[]
  /**
   * Whether the currently selected session survived reconciliation. Selection
   * itself is never changed here; the flag lets callers observe drift without
   * navigating away from what the user had open.
   */
  activeSessionStillExists: boolean
}

/**
 * Rebuilds the local list from the durable snapshot after a mutation failure.
 * Reconciliation is a cache correction, never navigation: the active selection
 * is preserved even when its row vanished remotely, so a failed delete cannot
 * bounce the user to another conversation (the Cherry Studio lock-up lesson).
 */
export function planSessionReconciliation(
  remoteSummaries: readonly SessionSummary[],
  activeSessionId: string | undefined
): SessionReconciliationPlan {
  return {
    summaries: [...remoteSummaries],
    activeSessionStillExists:
      activeSessionId === undefined ||
      remoteSummaries.some((session) => session.id === activeSessionId)
  }
}

/**
 * Guards the post-turn write-back. Once a session is no longer part of the
 * current list (deleted, or reconciled away after a failed mutation), a late
 * done/error event must only clear run state, never persist that conversation
 * back to disk.
 */
export function shouldPersistChatCompletion(
  sessions: readonly SessionSummary[],
  sessionId: string | undefined
): boolean {
  return sessionId !== undefined && sessions.some((session) => session.id === sessionId)
}

export function isSessionReadyForSend(
  session: ChatSession | undefined,
  activeSessionId: string | undefined
): session is ChatSession {
  return session !== undefined && session.id === activeSessionId
}

export interface HeroComposerPlan {
  isLoading: boolean
  isDraftSession: boolean
  messageCount: number
}

/**
 * Decides whether the composer renders as a centered hero instead of the
 * bottom dock. Loading keeps today's docked appearance so a cold start never
 * flashes the welcome heading before the durable list resolves.
 */
export function shouldShowHeroComposer(plan: HeroComposerPlan): boolean {
  return !plan.isLoading && (plan.isDraftSession || plan.messageCount === 0)
}
