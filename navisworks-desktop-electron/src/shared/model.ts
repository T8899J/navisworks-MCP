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
 * Model Configuration v2 (§18) — input/output MODALITY metadata. These describe
 * what a model CAN accept/produce. They are CAPABILITY METADATA ONLY: Curi's
 * message transport today is text, so an `image` input modality does NOT mean
 * Curi can send an image this round (§25/Invariant L) — it must never be used to
 * fabricate an unimplemented attachment path.
 */
export type ModelInputModality = 'text' | 'image' | 'video' | 'pdf'
export type ModelOutputModality = 'text' | 'image'

/**
 * A PER-MODEL configuration the user sets (Model Configuration v2). It is bound
 * to a structured `ModelRef` (never a `provider/model` string key — §19), so a
 * profile that serves many models can't leak one model's 1M window onto another
 * (§17/§40). Absent numeric fields / `null` = Auto (no override).
 */
export interface ModelConfiguration {
  ref: ModelRef
  contextWindowTokens?: number | null
  maxOutputTokens?: number | null
  /** Absent = text-only (the safe default the resolver applies); §25/§28. */
  inputModalities?: readonly ModelInputModality[]
  outputModalities?: readonly ModelOutputModality[]
}

/** Find the configuration bound to `ref` — the ONLY sanctioned lookup (§19). */
export function findModelConfiguration(
  configurations: readonly ModelConfiguration[] | undefined,
  ref: ModelRef,
): ModelConfiguration | undefined {
  if (configurations === undefined) return undefined
  return configurations.find((configuration) => modelRefEquals(configuration.ref, ref))
}

/**
 * Model capabilities. `undefined` means Curi DOES NOT KNOW — it is never
 * substituted with `false` (which would deny a real capability) nor with
 * `true` (which would fabricate one).
 */
export interface ModelCapabilities {
  tools?: boolean
  reasoning?: boolean
  temperature?: boolean
  /** @deprecated coarse; superseded by `modalities` (§24). Kept for compat. */
  attachments?: boolean
  /**
   * Model Configuration v2 (§24): the fine-grained modality view, derived from
   * the model's `ModelConfiguration` (or provider metadata). `undefined` side =
   * unknown. NOTE: describing a modality ≠ a wired transport (§25).
   */
  modalities?: {
    input?: readonly ModelInputModality[]
    output?: readonly ModelOutputModality[]
  }
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

/**
 * Where this model's context/output limits came from (highest-wins is recorded).
 * - 'model'  : an explicit per-model ModelConfiguration override (§22).
 * - 'profile': the legacy API-profile advanced override (Model Config v2 keeps it).
 * - 'provider': reported by the endpoint.
 * - 'local'  : the local Ollama default budget.
 * - 'unknown': nothing configured or reported.
 */
export type ModelMetadataSourceId = 'local' | 'profile' | 'provider' | 'model' | 'unknown'

/**
 * How Curi should treat `reasoning_effort` on the WIRE for this model — a
 * REQUEST-COMPATIBILITY policy (from the API profile), NOT a capability claim.
 * A model can support reasoning while the endpoint rejects the field
 * ('off'), and vice versa; `capabilities.reasoning` answers the capability
 * question alone and stays `undefined` until something actually proves it.
 */
export type ModelRequestPolicy = 'auto' | 'on' | 'off'

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
  /**
   * The effort steps the UI may offer (Ollama: low/max only), plus the WIRE
   * request policy that governs reasoning_effort (kept separate from
   * `capabilities.reasoning`, which only states what is actually known).
   */
  reasoning: {
    modes: readonly ReasoningEffort[]
    requestPolicy?: ModelRequestPolicy
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

