import type { ModelUsage } from '../../shared/model'

/** Non-negative finite integer from a wire payload; absent/garbage → undefined (≠ 0). */
function usageInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined
}

/**
 * A usage object with all five fields absent means the provider reported
 * NOTHING — normalizeUsage collapses it to undefined so downstream code never
 * mistakes "silent" for "zero".
 */
export function normalizeUsage(usage: ModelUsage): ModelUsage | undefined {
  const normalized: ModelUsage = {}
  if (usage.inputTokens !== undefined) normalized.inputTokens = usage.inputTokens
  if (usage.outputTokens !== undefined) normalized.outputTokens = usage.outputTokens
  if (usage.reasoningTokens !== undefined) normalized.reasoningTokens = usage.reasoningTokens
  if (usage.cacheReadTokens !== undefined) normalized.cacheReadTokens = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) normalized.cacheWriteTokens = usage.cacheWriteTokens
  return Object.keys(normalized).length === 0 ? undefined : normalized
}

/**
 * Map an OpenAI-compatible stream `usage` object onto ModelUsage. Covers the
 * OpenAI cache detail (`prompt_tokens_details.cached_tokens`) and the DeepSeek
 * split (`prompt_cache_hit_tokens`). A cache MISS is NOT a cache WRITE, so
 * `cacheWriteTokens` stays undefined unless an API explicitly reports one.
 */
export function openAiUsageToModelUsage(usage: {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number } | null
  completion_tokens_details?: { reasoning_tokens?: number } | null
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
} | null | undefined): ModelUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const input = usageInt(usage.prompt_tokens)
  const output = usageInt(usage.completion_tokens)
  const cached = usageInt(usage.prompt_tokens_details?.cached_tokens)
    ?? usageInt(usage.prompt_cache_hit_tokens)
  const reasoning = usageInt(usage.completion_tokens_details?.reasoning_tokens)
  return normalizeUsage({
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
  })
}

/** Map Ollama's eval counts onto ModelUsage. Ollama reports no cache data — those fields stay absent. */
export function ollamaUsageToModelUsage(input: {
  promptEvalCount?: number
  evalCount?: number
}): ModelUsage | undefined {
  const prompt = usageInt(input.promptEvalCount)
  const evalCount = usageInt(input.evalCount)
  return normalizeUsage({
    ...(prompt === undefined ? {} : { inputTokens: prompt }),
    ...(evalCount === undefined ? {} : { outputTokens: evalCount }),
  })
}
