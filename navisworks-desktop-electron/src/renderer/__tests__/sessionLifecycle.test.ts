import { describe, expect, it } from 'vitest'
import type { ChatSession, SessionSummary } from '../chatTypes'
import {
  isSessionReadyForSend,
  mergeSessionReplacement,
  planAfterDurableSessionDeletion,
  planSessionDeletion,
  planSessionReconciliation,
  removeDeletedSessionDraft,
  SessionTransitionLock,
  shouldApplySessionLoad,
  shouldPersistChatCompletion,
  shouldShowHeroComposer
} from '../sessionLifecycle'

const first: SessionSummary = {
  id: 'first',
  title: '第一条',
  preview: '',
  updatedAt: '2026-08-24T00:00:00.000Z',
  pinnedAt: null
}

const second: SessionSummary = {
  id: 'second',
  title: '第二条',
  preview: '',
  updatedAt: '2026-08-23T00:00:00.000Z',
  pinnedAt: null
}

describe('session lifecycle', () => {
  it('blocks new/select mutations for the whole delete transaction', () => {
    const lock = new SessionTransitionLock()

    expect(lock.tryAcquire()).toBe(true) // delete starts
    expect(lock.locked).toBe(true)
    expect(lock.tryAcquire()).toBe(false) // new/select/pin cannot overlap

    lock.release()
    expect(lock.locked).toBe(false)
    expect(lock.tryAcquire()).toBe(true) // next user intent can now run
  })

  it('retains a concurrently observed new summary when merging a replacement', () => {
    const third = { ...second, id: 'third', title: '并发建立的新会话' }
    const refreshedSecond = { ...second, title: '重新加载的第二条' }

    expect(mergeSessionReplacement(
      [first, second, third],
      'first',
      refreshedSecond
    )).toEqual([refreshedSecond, third])
  })

  it('moves text typed during deletion to a replacement without overwriting its draft', () => {
    expect(removeDeletedSessionDraft({ first: '继续输入' }, 'first', 'second')).toEqual({
      second: '继续输入'
    })
    expect(removeDeletedSessionDraft(
      { first: '待删除草稿', second: '原有草稿' },
      'first',
      'second'
    )).toEqual({ second: '原有草稿' })
  })

  it('selects the next remaining session after deleting the active one', () => {
    expect(planSessionDeletion([first, second], 'first', 'first')).toEqual({
      remaining: [second],
      deletedActiveSession: true,
      nextSessionId: 'second'
    })
  })

  it('leaves active state unchanged when deleting an inactive session', () => {
    expect(planSessionDeletion([first, second], 'first', 'second')).toEqual({
      remaining: [first],
      deletedActiveSession: false,
      nextSessionId: 'first'
    })
  })

  it('reports no next id after deleting the only active session', () => {
    expect(planSessionDeletion([first], 'first', 'first')).toEqual({
      remaining: [],
      deletedActiveSession: true,
      nextSessionId: undefined
    })
  })

  it('does not expose a local transition when durable deletion fails', async () => {
    const failure = new Error('disk is read-only')
    await expect(planAfterDurableSessionDeletion(
      async () => { throw failure },
      () => [first, second],
      () => 'first',
      'first'
    )).rejects.toBe(failure)
  })

  it('plans from the latest UI snapshot after durable deletion completes', async () => {
    let finishDelete: (() => void) | undefined
    let currentSessions: SessionSummary[] = [first, second]
    let currentActive = 'first'
    const deleting = planAfterDurableSessionDeletion(
      () => new Promise<void>((resolve) => { finishDelete = resolve }),
      () => currentSessions,
      () => currentActive,
      'first'
    )

    const third = { ...second, id: 'third', title: '新建中的会话' }
    currentSessions = [first, second, third]
    currentActive = 'third'
    finishDelete?.()

    await expect(deleting).resolves.toEqual({
      remaining: [second, third],
      deletedActiveSession: false,
      nextSessionId: 'third'
    })
  })

  it('rejects stale loads after a delete or active-session change', () => {
    expect(shouldApplySessionLoad(2, 3, 'first', 'first')).toBe(false)
    expect(shouldApplySessionLoad(3, 3, 'first', 'second')).toBe(false)
    expect(shouldApplySessionLoad(3, 3, 'second', 'second')).toBe(true)
  })

  it('never sends through a session object that does not match the active id', () => {
    const loaded: ChatSession = { ...first, messages: [], contextTokensUsed: 0 }
    expect(isSessionReadyForSend(loaded, 'second')).toBe(false)
    expect(isSessionReadyForSend(loaded, 'first')).toBe(true)
  })

  it('adopts the durable snapshot verbatim during reconciliation', () => {
    const remote = [second, first]
    const plan = planSessionReconciliation(remote, 'first')

    expect(plan.summaries).toEqual([second, first])
    expect(plan.summaries).not.toBe(remote) // copies; never aliases caller state
    expect(plan.activeSessionStillExists).toBe(true)
  })

  it('keeps the active selection intact even when reconciliation drops its row', () => {
    const plan = planSessionReconciliation([second], 'first')

    expect(plan.summaries).toEqual([second])
    expect(plan.activeSessionStillExists).toBe(false)
  })

  it('reports retention for an undefined active id without inventing one', () => {
    const plan = planSessionReconciliation([], undefined)

    expect(plan.summaries).toEqual([])
    expect(plan.activeSessionStillExists).toBe(true)
  })

  it('allows the post-turn write-back only while the session is still listed', () => {
    expect(shouldPersistChatCompletion([first, second], 'first')).toBe(true)
    expect(shouldPersistChatCompletion([], 'first')).toBe(false)
    expect(shouldPersistChatCompletion([second], 'first')).toBe(false)
    expect(shouldPersistChatCompletion([first], undefined)).toBe(false)
  })
})

describe('hero composer rule', () => {
  it('keeps the docked composer while the initial load is in flight', () => {
    expect(shouldShowHeroComposer({ isLoading: true, isDraftSession: true, messageCount: 0 })).toBe(false)
  })

  it('centers the composer for an unpersisted draft', () => {
    expect(shouldShowHeroComposer({ isLoading: false, isDraftSession: true, messageCount: 0 })).toBe(true)
  })

  it('keeps the hero for a persisted session that still has zero messages', () => {
    expect(shouldShowHeroComposer({ isLoading: false, isDraftSession: false, messageCount: 0 })).toBe(true)
  })

  it('docks the composer once any message exists', () => {
    // A draft never carries messages: sendText clears the marker in the same
    // synchronous pass that appends them, so this input is unreachable.
    expect(shouldShowHeroComposer({ isLoading: false, isDraftSession: false, messageCount: 1 })).toBe(false)
  })
})
