import type {
  QuestionAnswer,
  QuestionKind,
  QuestionOption,
  QuestionPrompt,
  QuestionRequest,
  QuestionSource,
} from '../../shared/ipc/schemas'

/**
 * P16 Question System — main-process runtime types. The wire shapes are the
 * shared zod schemas (single source, §16); these are the service-local views.
 */
export type {
  QuestionAnswer,
  QuestionKind,
  QuestionOption,
  QuestionPrompt,
  QuestionRequest,
  QuestionSource,
}

/** The input a caller supplies to ask() — requestId + createdAt are minted by the service. */
export type QuestionRequestInput = Omit<QuestionRequest, 'requestId' | 'createdAt'>

/** Outcome of a question: answered with per-index values, or declined. */
export type QuestionOutcome =
  | { kind: 'answered'; answers: readonly QuestionAnswer[] }
  | { kind: 'rejected' }

/** A request the renderer/user must be told about (transport payload). */
export type QuestionDispatch = (request: QuestionRequest) => void
