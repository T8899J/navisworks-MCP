import { describe, expect, it } from 'vitest'
import { QuestionService, QuestionAlreadyPendingError } from '../question/questionService'
import { validateQuestionPrompts } from '../question/questionSchema'
import type { QuestionPrompt, QuestionRequest } from '../../shared/ipc'

const noopDispatch = () => undefined

function prompts(): QuestionPrompt[] {
  return [{
    question: '你希望在哪个范围查找？',
    kind: 'single',
    options: [{ label: '整个模型' }, { label: '当前选择' }],
  }]
}

function requestInput(runId = 'r1', sessionId = 's1', questions = prompts()) {
  return { runId, sessionId, source: 'tool' as const, questions }
}

const singleAnswer = [{ questionIndex: 0, values: ['当前选择'] }]

describe('QuestionService lifecycle (§83)', () => {
  it('Case 1: ask() registers pending + dispatches; answer() resolves and clears', async () => {
    const service = new QuestionService()
    const dispatched: QuestionRequest[] = []
    const outcome = service.ask(requestInput(), (request) => {
      dispatched.push(request)
    })
    expect(service.listPending()).toHaveLength(1)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(dispatched[0]!.sessionId).toBe('s1')
    expect(service.answer(dispatched[0]!.requestId, singleAnswer)).toBe(true)
    await expect(outcome).resolves.toEqual({ kind: 'answered', answers: singleAnswer })
    expect(service.listPending()).toHaveLength(0)
  })

  it('Case 2: reject() resolves with the rejected outcome and clears pending', async () => {
    const service = new QuestionService()
    let requestId = ''
    const outcome = service.ask(requestInput(), (request) => {
      requestId = request.requestId
    })
    expect(service.reject(requestId)).toBe(true)
    await expect(outcome).resolves.toEqual({ kind: 'rejected' })
    expect(service.listPending()).toHaveLength(0)
  })

  it('Case 3: abortRun rejects the pending promise — nothing hangs, nothing leaks', async () => {
    const service = new QuestionService()
    let requestId = ''
    const outcome = service.ask(requestInput('run-x'), (request) => {
      requestId = request.requestId
    })
    expect(service.abortRun('run-x')).toBe(1)
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' })
    // The entry was removed synchronously — no dangling promise (§20/Invariant D).
    expect(service.listPending()).toHaveLength(0)
    expect(service.pendingCount).toBe(0)
    // Late answers to an aborted request are harmless.
    expect(service.answer(requestId, singleAnswer)).toBe(false)
  })

  it('Case 3b: an AbortSignal passed to ask() rejects immediately on abort', async () => {
    const service = new QuestionService()
    const controller = new AbortController()
    const outcome = service.ask(requestInput('r-signal'), noopDispatch, controller.signal)
    controller.abort(new Error('stop'))
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.listPending()).toHaveLength(0)
  })

  it('Case 4/5: session scoping — listPending(B) never sees A, and A restores on return', async () => {
    const service = new QuestionService()
    const outcomeA = service.ask(requestInput('rA', 'session-A'), noopDispatch)
    expect(service.listPending('session-B')).toHaveLength(0)
    expect(service.listPending('session-A')).toHaveLength(1)
    const restored = service.listPending('session-A')[0]!
    expect(service.answer(restored.requestId, singleAnswer)).toBe(true)
    await expect(outcomeA).resolves.toEqual({ kind: 'answered', answers: singleAnswer })
  })

  it('§8: a second question for the SAME run is refused while the first is pending', async () => {
    const service = new QuestionService()
    const first = service.ask(requestInput('r-dup'), () => undefined)
    await expect(service.ask(requestInput('r-dup'), () => undefined)).rejects
      .toBeInstanceOf(QuestionAlreadyPendingError)
    const pending = service.listPending()
    expect(pending).toHaveLength(1)
    service.reject(pending[0]!.requestId)
    await expect(first).resolves.toEqual({ kind: 'rejected' })
  })

  it('abortSession rejects only that session; abortAll clears everything', async () => {
    const service = new QuestionService()
    const a = service.ask(requestInput('rA', 'sA'), noopDispatch)
    const b = service.ask(requestInput('rB', 'sB'), noopDispatch)
    expect(service.abortSession('sA')).toBe(1)
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.listPending('sB')).toHaveLength(1)
    service.abortAll()
    await expect(b).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.pendingCount).toBe(0)
  })
})

describe('question tool schema (§84 Case 3, §6)', () => {
  it('accepts a valid single question with options', () => {
    const result = validateQuestionPrompts([{
      question: '在哪里查找？',
      kind: 'single',
      options: [{ label: 'A' }, { label: 'B' }],
    }])
    expect(result.ok).toBe(true)
  })

  it('rejects more than 4 questions', () => {
    const five = Array.from({ length: 5 }, () => ({
      question: 'q', kind: 'text' as const,
    }))
    expect(validateQuestionPrompts(five).ok).toBe(false)
  })

  it('rejects single without options and text WITH options', () => {
    expect(validateQuestionPrompts([{ question: 'q', kind: 'single' }]).ok).toBe(false)
    expect(validateQuestionPrompts([{
      question: 'q', kind: 'text', options: [{ label: 'A' }, { label: 'B' }],
    }]).ok).toBe(false)
  })

  it('rejects unknown kinds / empty questions', () => {
    expect(validateQuestionPrompts([]).ok).toBe(false)
    expect(validateQuestionPrompts([{ question: 'q', kind: 'boolean' }]).ok).toBe(false)
  })
})
