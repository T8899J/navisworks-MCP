/**
 * P14 — the shared compaction seam. Automatic (in-run) and manual /compact
 * compaction render from the SAME summary prompt (re-exported below) and the
 * AgentRuntime routes both paths through one `#completeWith` summarizer call
 * with one empty-summary rule, so there is never a second set of summary rules
 * (§37/§41/§66/§90). ContextManager.tryCompact still owns the in-run
 * frame-removal mechanics; this module owns the prompt + the plain-conversation
 * transcript format the manual /compact route formats identically to.
 */
export { COMPACT_SYSTEM_PROMPT } from './compactPrompt'

/** The conversation transcript format manual /compact feeds the summarizer. */
export function renderConversationTranscript(
  messages: readonly { role: string; content: string }[],
): string {
  return messages
    .map((message) => `[${message.role}] ${message.content}`)
    .join('\n\n')
}
