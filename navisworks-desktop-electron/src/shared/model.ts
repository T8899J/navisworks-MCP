import type { ReasoningEffort } from './reasoning'

/**
 * Shared Model System primitives (P4–P7).
 *
 * Provider ≠ Model: a model is only identified as a PAIR
 * `{ providerId, modelId }` — two API endpoints serving the same model id are
 * different models. Plain strings (`provider/model`) are display-only; core
 * logic never parses them back (modelId itself may contain `/` `:` `@`).
 */
export interface ModelRef {
  providerId: string
  modelId: string
}

/** Display helper ONLY. Never parse a formatted ref back into a ModelRef. */
export function formatModelRef(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`
}

/** The always-on local daemon's provider identity. */
export const OLLAMA_PROVIDER_ID = 'ollama'

/**
 * An API profile is its OWN provider connection: two endpoints serving the
 * same model id must not share one ModelRef.
 */
export function apiProfileProviderId(profileId: string): string {
  return `api:${profileId}`
}

/** Structural equality — the ONLY sanctioned way to compare two identities. */
export function modelRefEquals(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId
}

/** The provider connection family a model runs on. */
export type ModelProviderKind = 'ollama' | 'openai-compatible'

/**
 * Model capabilities. `undefined` means Curi DOES NOT KNOW — it is never
 * substituted with `false` (which would deny a real capability) nor with
 * `true` (which would fabricate one).
 */
export interface ModelCapabilities {
  tools?: boolean
  reasoning?: boolean
  temperature?: boolean
  attachments?: boolean
}

export interface ModelLimits {
  /**
   * The KNOWN/configured model window only. The runtime's 32K safety budget
   * is NOT a model limit and is never written here — that lives in
   * contextWindowSource='fallback' accounting.
   */
  context?: number
  input?: number
  output?: number
}

/** Where this model's metadata came from. 'unknown' = nothing was configured or reported. */
export type ModelMetadataSourceId = 'local' | 'profile' | 'provider' | 'unknown'

/**
 * The unified model identity + metadata consumed by runtime and renderer, so
 * neither guesses "who is this model / what does it support / what is its
 * window / which reasoning steps does it have".
 */
export interface ModelInfo {
  ref: ModelRef
  displayName: string
  provider: {
    id: string
    displayName: string
    kind: ModelProviderKind
  }
  capabilities: ModelCapabilities
  limits: ModelLimits
  /** The effort steps this model actually supports (Ollama: low/max only). */
  reasoning: {
    modes: readonly ReasoningEffort[]
  }
  metadataSource: ModelMetadataSourceId
}

/**
 * Raw usage as reported by a provider. Absent fields stay ABSENT: `undefined`
 * means "not reported", which is strictly different from a reported `0`.
 */
export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

function usageNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Tokens a run consumed from the context: input + output. reasoningTokens is
 * NOT added — most providers already fold it into output tokens, and adding it
 * blindly double-counts.
 */
export function totalUsedTokens(usage: ModelUsage | undefined): number {
  if (!usage) return 0
  return usageNumber(usage.inputTokens) + usageNumber(usage.outputTokens)
}

/**
 * Cache reuse rate = cacheRead / input. Returns `undefined` (≠ 0) when the
 * provider did not report cache info or the input side is unusable — the UI
 * then says "未报告", never "0%".
 */
export function calculateCacheHitRate(usage: ModelUsage | undefined): number | undefined {
  if (!usage) return undefined
  const { cacheReadTokens, inputTokens } = usage
  if (cacheReadTokens === undefined || inputTokens === undefined || inputTokens <= 0) {
    return undefined
  }
  return Math.max(0, Math.min(1, cacheReadTokens / inputTokens))
}

