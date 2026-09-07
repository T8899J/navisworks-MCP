import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QuestionCard } from '../QuestionCard'
import type { QuestionRequest } from '../../shared/ipc'

function request(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    requestId: 'r-1',
    runId: 'run-1',
    sessionId: 's-1',
    source: 'tool',
    createdAt: 1,
    questions: [{
      question: '你希望在哪个范围查找？',
      kind: 'single',
      options: [{ label: '整个模型' }, { label: '当前选择' }],
    }],
    ...overrides,
  }
}

function render(props: Partial<Parameters<typeof QuestionCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <QuestionCard
      request={request()}
      resolving={false}
      onSubmit={() => undefined}
      onReject={() => undefined}
      {...props}
    />,
  )
}

describe('QuestionCard (§86)', () => {
  it('single renders a radiogroup', () => {
    const markup = render()
    expect(markup).toContain('radiogroup')
    expect(markup).toContain('type="radio"')
    expect(markup).toContain('整个模型')
    expect(markup).toContain('当前选择')
  })

  it('multiple renders checkboxes; text renders a textarea', () => {
    const multi = render({
      request: request({
        questions: [{
          question: '选几个？', kind: 'multiple',
          options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
        }],
      }),
    })
    expect(multi).toContain('type="checkbox"')
    expect(multi).not.toContain('type="radio"')
    const text = render({
      request: request({ questions: [{ question: '叫什么名字？', kind: 'text' }] }),
    })
    expect(text).toContain('<textarea')
    expect(text).not.toContain('type="radio"')
    expect(text).not.toContain('type="checkbox"')
  })

  it('required question starts with 确认 disabled (empty answers cannot submit)', () => {
    const markup = render()
    expect(markup).toContain('disabled=""')
    // the confirm button is disabled while nothing is selected
    const confirm = markup.match(/<button[^>]*class="primary-button"[^>]*>/)
    expect(confirm?.[0]).toContain('disabled')
  })

  it('optional question may be submitted without an answer', () => {
    const markup = render({
      request: request({ questions: [{ question: '可选补充', kind: 'text', required: false }] }),
    })
    const confirm = markup.match(/<button[^>]*class="primary-button"[^>]*>/)
    expect(confirm?.[0]).not.toContain('disabled')
  })

  it('doom-loop source gets its own heading copy', () => {
    const markup = render({ request: request({ source: 'doom-loop' }) })
    expect(markup).toContain('Curi 卡住了')
  })

  it('resolving disables the actions (submit once, no double answer)', () => {
    const markup = render({ resolving: true })
    const buttons = markup.match(/<button[^>]*class="(?:primary|secondary)-button"[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    expect(buttons.every((button) => button.includes('disabled'))).toBe(true)
  })
})
