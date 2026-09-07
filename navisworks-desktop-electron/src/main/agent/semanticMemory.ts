/**
 * P20 Session Memory — the deterministic, per-session working set.
 *
 * Boundary discipline (§63): Session Memory is ONLY goals/constraints/
 * decisions/notes. Conversation → SessionRepository; compaction digest →
 * Context Epoch seed; task state → TaskManager; facts & reference sets →
 * ContextState; large tool results → ToolOutputStore. Those are NOT memory.
 *
 * No model call, no embedding, no cross-session store (§65/§106): a strict
 * pattern classifier over the user's own words. Question answers and
 * doom-loop decisions NEVER enter this path (§72/§73 — only chat-turn text
 * reaches updateSessionMemory).
 *
 * The persisted disk shape (semanticMemory on sessions.json) is UNCHANGED —
 * old sessions load and continue to grow under the new rules (§70).
 */
export interface SemanticMemory {
  goals: string[]
  constraints: string[]
  decisions: string[]
  notes: string[]
  updatedAt: number
}

/** P20 naming seam: Session Memory is what this always was. */
export type SessionMemory = SemanticMemory

/** Size policy (§68): bounded buckets, capped single entries. */
const MAX_GOALS = 6
const MAX_CONSTRAINTS = 8
const MAX_DECISIONS = 8
const MAX_NOTES = 6
const MAX_ENTRY_CHARS = 400

// Explicit long-term GOAL phrasings only — "帮我…" is NOT a goal (§66).
const GOAL_PATTERNS = /(?:目标是|我要完成|我想要|我希望|最终需要|这次要完成)/
// Binding CONSTRAINTS.
const CONSTRAINT_PATTERNS = /(?:必须|不要|不得|只能|只做|不需要)/
// Deliberate DECISIONS for the rest of the session.
const DECISION_PATTERNS = /(?:决定|接下来都|以后都|统一用|就按|范围定为|以.+(?:为准|为范围))/
// Only explicit memory requests become NOTES.
const NOTE_PATTERNS = /(?:记住|备注|需要记住的是)/
// Bare acknowledgements/instructions are never memory at all (§66).
const FILLER_PATTERNS = /^(?:继续|好的?|可以|确认|执行|开始|嗯|ok|okay|yes)[。！!.?？]?$/i
// Short deictic follow-ups ("第三个呢", "为什么") never enter memory (§66/K).
const FOLLOW_UP_PATTERNS = /^(?:.{0,6}呢|[为是]什么|为什么|再看|然后呢?|现在呢?|它呢|这个呢|那个呢)$/

export function updateSemanticMemory(
  previous: SemanticMemory | undefined,
  userInput: string,
): SemanticMemory {
  const safeInput = redactExactIdentifiers(userInput.trim())
  const memory: SemanticMemory = {
    goals: [...(previous?.goals ?? [])],
    constraints: [...(previous?.constraints ?? [])],
    decisions: [...(previous?.decisions ?? [])],
    notes: [...(previous?.notes ?? [])],
    updatedAt: Date.now(),
  }
  if (!safeInput) return memory
  // Sentence-level classification: each sentence lands in AT MOST one bucket.
  for (const sentence of splitSentences(safeInput)) {
    if (FILLER_PATTERNS.test(sentence) || FOLLOW_UP_PATTERNS.test(sentence)) continue
    if (NOTE_PATTERNS.test(sentence)) {
      pushBounded(memory.notes, normalizeEntry(sentence), MAX_NOTES)
    } else if (DECISION_PATTERNS.test(sentence)) {
      pushBounded(memory.decisions, normalizeEntry(sentence), MAX_DECISIONS)
    } else if (CONSTRAINT_PATTERNS.test(sentence)) {
      pushBounded(memory.constraints, normalizeEntry(sentence), MAX_CONSTRAINTS)
    } else if (GOAL_PATTERNS.test(sentence)) {
      pushBounded(memory.goals, normalizeEntry(sentence), MAX_GOALS)
    }
    // Anything else is plain conversation — remembered nowhere (§64).
  }
  return memory
}

/** Preferred P20 name. */
export const updateSessionMemory = updateSemanticMemory

function splitSentences(value: string): string[] {
  return value
    .split(/[。！？\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

function pushBounded(bucket: string[], entry: string, cap: number): void {
  const key = dedupeKey(entry)
  if (bucket.some((existing) => dedupeKey(existing) === key)) return
  bucket.push(entry)
  if (bucket.length > cap) bucket.splice(0, bucket.length - cap)
}

/** Normalized dedupe (§67): whitespace collapsed, trailing punctuation gone. */
function dedupeKey(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/[。.!！?？;；,，]+$/, '')
    .toLowerCase()
}

function normalizeEntry(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_CHARS)
}

function redactExactIdentifiers(value: string): string {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[精确ID]')
    .replace(/\b(?:item|viewpoint|document)?id\s*[:=]\s*[^\s,;，；]+/gi, 'id=[精确ID]')
}

export function renderSemanticMemory(memory: SemanticMemory | undefined): string {
  if (memory === undefined) return ''
  const lines: string[] = []
  if (memory.goals.length > 0) lines.push(`- 当前目标：${memory.goals.join('；')}`)
  if (memory.constraints.length > 0) lines.push(`- 已确认约束：${memory.constraints.join('；')}`)
  if (memory.decisions.length > 0) lines.push(`- 已确认决策：${memory.decisions.join('；')}`)
  if (memory.notes.length > 0) lines.push(`- 备注：${memory.notes.join('；')}`)
  if (lines.length === 0) return ''
  return `【会话语义记忆（不包含构件或视点精确 ID）】\n${lines.join('\n')}`
}
