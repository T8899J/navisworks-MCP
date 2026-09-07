import { z } from 'zod'
import { questionPromptSchema, type QuestionPrompt } from '../../shared/ipc/schemas'

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
