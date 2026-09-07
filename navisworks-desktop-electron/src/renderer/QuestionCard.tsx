import { useState } from 'react'
import { HelpCircle } from 'lucide-react'
import type { QuestionAnswer, QuestionRequest } from '../shared/ipc'

interface QuestionCardProps {
  request: QuestionRequest
  resolving: boolean
  onSubmit(answers: readonly QuestionAnswer[]): void
  onReject(): void
}

/**
 * P16 question card — part of the conversation flow (never a modal, §21).
 * `single` = one choice, `multiple` = checkbox set, `text` = free input
 * (§22). Answers are positioned by ARRAY INDEX (§5). Submit latches until
 * the answer lands (§86: submit once); a required question cannot be
 * confirmed empty.
 */
export function QuestionCard({ request, resolving, onSubmit, onReject }: QuestionCardProps) {
  const [selections, setSelections] = useState<Record<number, string[]>>({})
  const [texts, setTexts] = useState<Record<number, string>>({})
  const [submitted, setSubmitted] = useState(false)

  const answersFor = (index: number): QuestionAnswer => {
    const prompt = request.questions[index]!
    if (prompt.kind === 'text') {
      const value = (texts[index] ?? '').trim()
      return { questionIndex: index, values: value ? [value] : [] }
    }
    return { questionIndex: index, values: selections[index] ?? [] }
  }

  const allAnswered = request.questions.every((prompt, index) => {
    const optional = prompt.required === false
    const values = answersFor(index).values
    return optional || values.length > 0
  })

  const locked = resolving || submitted

  const toggle = (index: number, label: string, multiple: boolean) => {
    setSelections((current) => {
      const existing = current[index] ?? []
      if (!multiple) return { ...current, [index]: [label] }
      return {
        ...current,
        [index]: existing.includes(label)
          ? existing.filter((value) => value !== label)
          : [...existing, label],
      }
    })
  }

  const submit = () => {
    if (locked || !allAnswered) return
    setSubmitted(true)
    onSubmit(request.questions.map((_, index) => answersFor(index)))
  }

  return (
    <section className="question-card" aria-label="Curi 需要你的补充">
      <header className="question-card-head">
        <HelpCircle aria-hidden="true" size={16} />
        <span>{request.source === 'doom-loop' ? 'Curi 卡住了，需要你决定' : 'Curi 需要你补充信息'}</span>
      </header>
      {request.questions.map((prompt, index) => {
        const answered = answersFor(index).values
        return (
          <fieldset className="question-item" key={`${request.requestId}-${index}`}>
            <legend>
              {prompt.question}
              {prompt.required === false ? <small className="question-optional">（可跳过）</small> : null}
            </legend>
            {prompt.kind === 'text' ? (
              <textarea
                className="question-text-input"
                rows={2}
                value={texts[index] ?? ''}
                disabled={locked}
                placeholder="输入你的回答"
                onChange={(event) => setTexts((current) => ({ ...current, [index]: event.currentTarget.value }))}
              />
            ) : (
              <div className="question-options" role={prompt.kind === 'single' ? 'radiogroup' : 'group'}>
                {(prompt.options ?? []).map((option) => {
                  const selected = answered.includes(option.label)
                  return (
                    <label
                      className={`question-option${selected ? ' selected' : ''}`}
                      key={option.label}>
                      <input
                        type={prompt.kind === 'single' ? 'radio' : 'checkbox'}
                        name={`question-${index}`}
                        checked={selected}
                        disabled={locked}
                        onChange={() => toggle(index, option.label, prompt.kind === 'multiple')}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        {option.description ? <small>{option.description}</small> : null}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </fieldset>
        )
      })}
      <footer className="question-card-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={locked}
          onClick={() => {
            if (locked) return
            setSubmitted(true)
            onReject()
          }}>
          取消
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={locked || !allAnswered}
          onClick={submit}>
          确认
        </button>
      </footer>
    </section>
  )
}
