import type { ModelInfo, ModelRef } from '../../../shared/model'

/**
 * Model Catalog v1: a process-local, IN-MEMORY index of known ModelInfo, keyed
 * by the structured ModelRef — never by a bare model name, because modelIds
 * may contain `/` `:` `@` and collide across endpoints.
 *
 * v1 deliberately has NO persistence and NO network source: every entry is
 * derived from settings/profiles this session. `upsert`/`removeProvider` exist
 * so a later metadata source (provider-reported or curated) can feed the same
 * interface without callers changing.
 *
 * Secrets never enter: ModelInfo has no apiKey/header field by construction.
 */
export class ModelCatalog {
  readonly #entries = new Map<string, ModelInfo>()

  static key(ref: ModelRef): string {
    // NUL separator: provider ids ('ollama', 'api:<uuid>') and model ids both
    // avoid it, so the key stays collision-free.
    return `${ref.providerId}\u0000${ref.modelId}`
  }

  resolve(ref: ModelRef): ModelInfo | undefined {
    return this.#entries.get(ModelCatalog.key(ref))
  }

  listKnown(): readonly ModelInfo[] {
    return [...this.#entries.values()]
  }

  upsert(info: ModelInfo): void {
    this.#entries.set(ModelCatalog.key(info.ref), info)
  }

  removeProvider(providerId: string): void {
    for (const [key, info] of [...this.#entries.entries()]) {
      if (info.ref.providerId === providerId) this.#entries.delete(key)
    }
  }

  /**
   * Replace every entry belonging to one provider with its current set — used
   * to keep the catalog in sync with settings on each read (profile deleted →
   * its api:<id> entries drop out too).
   */
  replaceProvider(providerId: string, infos: readonly ModelInfo[]): void {
    this.removeProvider(providerId)
    for (const info of infos) {
      if (info.ref.providerId === providerId) this.upsert(info)
    }
  }
}
