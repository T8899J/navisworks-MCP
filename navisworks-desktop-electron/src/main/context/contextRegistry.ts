import type { ContextSource, ContextSourceMode } from './types'
import { coreSource } from './sources/coreSource'
import { navisworksPolicySource } from './sources/navisworksPolicySource'
import { skillManifestSource } from './sources/skillManifestSource'
import { documentSource } from './sources/documentSource'
import { compactSummarySource } from './sources/compactSummarySource'
import { taskSource } from './sources/taskSource'
import { semanticMemorySource } from './sources/semanticMemorySource'
import { verifiedFactsSource } from './sources/verifiedFactsSource'
import { referenceSetSource } from './sources/referenceSetSource'
import { recallSource } from './sources/recallSource'

/**
 * The ordered list of every registered context source. THE ORDER IS EXPLICIT
 * AND FIXED (§8): baseline prefix first, then durable updates, then volatile
 * working context — never Object.keys order, never Map insertion accidents,
 * never filesystem scan order. The runtime must not re-sort it.
 *
 * Baseline order (§54): core/identity → policy/navisworks → skills/manifest.
 * Volatile order matches the pre-engine runtime's block order so existing
 * behavior is reproduced byte-for-byte where the content is unchanged.
 */
const ORDERED_SOURCES: readonly ContextSource<unknown>[] = [
  coreSource,
  navisworksPolicySource,
  skillManifestSource,
  documentSource,
  compactSummarySource,
  taskSource,
  semanticMemorySource,
  verifiedFactsSource,
  referenceSetSource,
  recallSource,
]

export class ContextRegistry {
  readonly #sources: readonly ContextSource<unknown>[]
  readonly #byKey: Map<string, ContextSource<unknown>>

  constructor(sources: readonly ContextSource<unknown>[] = ORDERED_SOURCES) {
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

/** The process-wide registry singleton (the default source set). */
export const contextRegistry = new ContextRegistry()

/**
 * Factory seam (§54): build a registry from an explicit, ordered source list.
 * Callers compose sources themselves — the runtime never mutates the global
 * array at run time; order is what the constructor was handed.
 */
export function createContextRegistry(
  sources: readonly ContextSource<unknown>[] = ORDERED_SOURCES,
): ContextRegistry {
  return new ContextRegistry(sources)
}
