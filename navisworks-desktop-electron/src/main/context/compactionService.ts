import { COMPACT_MAX_TRANSCRIPT_CHARS } from '../agent/contextManager'
import type { ChatMessage, CompletionResult, ModelProvider } from '../model/types'

/**
 * P14 — the ONE compaction seam. Automatic (in-run) and manual /compact
 * compaction share this service: one summary prompt (re-exported below), one
 * transcript builder, one empty-summary failure rule. §37/§90 forbid a second
 * set of summary rules; ContextManager.tryCompact still owns the frame-removal
 * mechanics, this service owns WHAT the summarization IS.
 */
export { COMPACT_SYSTEM_PROMPT } from './compactPrompt'

/** The runtime-facing completion seam (window-stripping lives in the caller). */
export type CompactionComplete = (
  provider: ModelProvider,
  model: string,
  transcriptMessages: readonly ChatMessage[],
  signal?: AbortSignal,
) => Promise<CompletionResult>

export interface CompactTranscriptOutcome {
  summary: string
  ok: boolean
  error?: string
}

/**
 * Compact one transcript (pair of [system, transcript] messages) into a
 * summary. An empty summarizer answer is an ERROR outcome — never a silently
 * accepted '' that would erase history when persisted (§65).
 */
export async function compactTranscript(
  complete: CompactionComplete,
  provider: ModelProvider,
  model: string,
  transcriptMessages: readonly ChatMessage[],
  signal?: AbortSignal,
): Promise<CompactTranscriptOutcome> {
  try {
    const response = await complete(provider, model, transcriptMessages, signal)
    const summary = response.content.trim()
    if (!summary) {
      return {
        summary: '',
        ok: false,
        error: '压缩未产生摘要，请重试。',
      }
    }
    return { summary, ok: true }
  } catch (error) {
    return {
      summary: '',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** The transcript user-message shape shared by both entry points. */
export function buildTranscriptUserMessage(
  transcript: string,
  maxChars: number = COMPACT_MAX_TRANSCRIPT_CHARS,
): ChatMessage {
  return { role: 'user', content: clipTranscript(transcript, maxChars) }
}

/**
 * Join conversation messages into the summarizer transcript. Manual /compact
 * and the auto path format identically here.
 */
export function renderConversationTranscript(
  messages: readonly { role: string; content: string }[],
): string {
  return messages
    .map((message) => `[${message.role}] ${message.content}`)
    .join('\n\n')
}

function clipTranscript(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…[已截断]`
}
