import { z } from 'zod'
import {
  questionPromptSchema,
  type QuestionAnswer,
  type QuestionPrompt,
  type QuestionRequest,
} from '../../shared/ipc/schemas'

export { questionPromptSchema }

const questionsPayloadSchema = z.strictObject({
  questions: z.array(questionPromptSchema).min(1).max(4),
})

export type QuestionValidation =
  | { ok: true; questions: QuestionPrompt[] }
  | { ok: false; message: string }

/**
 * Validate a model-produced `question` tool payload against the SHARED IPC
 * schema (§6/§84): 1–4 questions, single/multiple need 2–8 options, text has
 * none. An invalid schema returns INVALID_QUESTION detail, never a crash.
 */
export function validateQuestionPrompts(raw: unknown): QuestionValidation {
  // The tool wrapper nests under { questions } sometimes and is bare other
  // times; accept the array or the object uniformly.
  const candidate = Array.isArray(raw) ? { questions: raw } : raw
  const parsed = questionsPayloadSchema.safeParse(candidate)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      message: `问题参数不合法：${first ? `${first.path.join('.')} ${first.message}` : parsed.error.issues.length} 项错误。`,
    }
  }
  return { ok: true, questions: parsed.data.questions }
}

/**
 * Verify a renderer-submitted answer set against the registered request
 * (§101/§5): indexes inside range, single ≤1 value, option labels must be
 * ones the Agent offered, required questions answered (empty = answered
 * when optional). Pure — shared by the IPC handler and its tests.
 */
export function validateAnswersForRequest(
  request: QuestionRequest,
  answers: readonly QuestionAnswer[],
): boolean {
  if (request.questions.length < answers.length) return false
  for (const answer of answers) {
    const prompt = request.questions[answer.questionIndex]
    if (prompt === undefined) return false
    if (prompt.required !== false && answer.values.length === 0) return false
    if (prompt.kind === 'single' && answer.values.length > 1) return false
    if (prompt.kind === 'text') {
      if (answer.values.length > 1) return false
      continue
    }
    const labels = new Set((prompt.options ?? []).map((option) => option.label))
    if (answer.values.some((value) => !labels.has(value))) return false
  }
  return true
}
