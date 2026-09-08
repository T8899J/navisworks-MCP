import type { ContextSource, ContextSourceMode } from './types'
import { coreSource } from './sources/coreSource'
import { skillManifestSource } from './sources/skillManifestSource'
import { compactSummarySource } from './sources/compactSummarySource'
import { taskSource } from './sources/taskSource'
import { semanticMemorySource } from './sources/semanticMemorySource'
import type { CapabilityRegistry } from '../capability/capabilityRegistry'

/**
 * The ordered list of every registered context source. THE ORDER IS EXPLICIT
 * AND FIXED (§8): baseline prefix first, then durable updates, then volatile
 * working context — never Object.keys order, never Map insertion accidents,
 * never filesystem scan order. The runtime must not re-sort it.
 *
 * Capability Architecture v1 (§30/§100): the CORE list holds only
 * provider-neutral sources. Navisworks' policy/document/facts/reference-set/
 * recall sources are CONTRIBUTED by the Navisworks capability and interleaved
 * by composeContextRegistry() into the SAME fixed global order they had when
 * statically listed here — so migrated sessions see an unchanged baseline.
 *
 * Fixed global order (§33): core baseline → capability baselines → skill
 * manifest → capability durable → core volatile → capability volatile.
 */
export const CORE_BASELINE_SOURCES: readonly ContextSource<unknown>[] = [coreSource]
export const CORE_MANIFEST_SOURCES: readonly ContextSource<unknown>[] = [skillManifestSource]
export const CORE_VOLATILE_SOURCES: readonly ContextSource<unknown>[] = [
  compactSummarySource,
  taskSource,
  semanticMemorySource,
]

/** Core-only default (no capabilities registered) — §37 acceptance. */
const CORE_ONLY_ORDERED: readonly ContextSource<unknown>[] = [
  ...CORE_BASELINE_SOURCES,
  ...CORE_MANIFEST_SOURCES,
  ...CORE_VOLATILE_SOURCES,
]

export class ContextRegistry {
  readonly #sources: readonly ContextSource<unknown>[]
  readonly #byKey: Map<string, ContextSource<unknown>>

  constructor(sources: readonly ContextSource<unknown>[] = CORE_ONLY_ORDERED) {
    const seen = new Set<string>()
    for (const source of sources) {
      if (seen.has(source.key)) {
        throw new Error(`重复的 Context Source key: ${source.key}`)
      }
      seen.add(source.key)
    }
    this.#sources = [...sources]
    this.#byKey = new Map(sources.map((source) => [source.key, source]))
  }

  list(): readonly ContextSource<unknown>[] {
    return this.#sources
  }

  /** Sources of one mode, in the registry's fixed order. */
  listByMode(mode: ContextSourceMode): readonly ContextSource<unknown>[] {
    return this.#sources.filter((source) => source.mode === mode)
  }

  get(key: string): ContextSource<unknown> | undefined {
    return this.#byKey.get(key)
  }
}

/**
 * Build the production registry: CORE sources + every registered capability's
 * contributions, interleaved into the exact fixed order Navisworks had when
 * its sources were statically listed here (baseline → capability baselines →
 * skill manifest → capability durable → core volatile → capability volatile).
 * Passing no capability registry yields the core-only baseline (§37): no
 * Navisworks policy, document, facts, reference set, or recall anywhere.
 */
export function createContextRegistry(
  capabilityRegistry?: CapabilityRegistry,
): ContextRegistry {
  const capability = capabilityRegistry
  const ordered: ContextSource<unknown>[] = [
    ...CORE_BASELINE_SOURCES,
    ...(capability?.contextSourcesByMode('baseline') ?? []),
    ...CORE_MANIFEST_SOURCES,
    ...(capability?.contextSourcesByMode('durable') ?? []),
    ...CORE_VOLATILE_SOURCES,
    ...(capability?.contextSourcesByMode('volatile') ?? []),
  ]
  return new ContextRegistry(ordered)
}
