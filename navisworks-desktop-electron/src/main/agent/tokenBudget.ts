import type { ContextBudgetConfig } from './contextTypes'

/**
 * Conservative, provider-neutral token estimate. There is no local tokenizer yet, so
 * this over-counts rather than under-counts: CJK text is ~1 token per character, other
 * scripts ~4 characters per token. Round up so a real tokenizer never finds MORE tokens
 * than we budgeted. A provider may later replace this via TokenBudgetConfig-style
 * injection (docs/context-runtime.md §四).
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x3000 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * Tokens actually available for context after reserves. Never negative.
 * contextBudget = effectiveContextWindow - outputReserve - providerOverhead - safetyMargin.
 */
export function computeContextBudget(config: ContextBudgetConfig): number {
  const used =
    config.outputReserve + config.providerOverhead + config.safetyMargin
  return Math.max(0, config.effectiveContextWindow - used)
}
