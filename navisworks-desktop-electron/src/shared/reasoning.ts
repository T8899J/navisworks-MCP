/**
 * Five-step reasoning effort shared by settings persistence, IPC schemas,
 * the runtime mapping, and the composer slider. API endpoints receive the
 * raw value as `reasoning_effort`; the local Ollama daemon only knows the
 * two extremes (Low → no thinking, Max → thinking).
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export const REASONING_EFFORT_LABEL: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Xhigh',
  max: 'Max',
}

/** Accepts legacy two-step values too: fast→low, deep→max, anything else→low. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (value === 'deep') return 'max'
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? value as ReasoningEffort : 'low'
}

/** Local Ollama `think` flag for an effort step; the middle steps never occur locally. */
export function localThinkForEffort(effort: ReasoningEffort): boolean {
  return effort === 'high' || effort === 'xhigh' || effort === 'max'
}

/** Two-step local equivalent of any step, for UI display while a local model is active. */
export function localDisplayEffort(effort: ReasoningEffort): ReasoningEffort {
  return effort === 'low' || effort === 'medium' ? 'low' : 'max'
}
