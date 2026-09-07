import { apiProfileProviderId, OLLAMA_PROVIDER_ID, type ModelInfo } from '../../../shared/model'
import { providerModelInfo } from '../modelRouter'
import type { ModelRouter } from '../modelRouter'
import { ModelCatalog } from './modelCatalog'
import {
  buildApiModelInfo,
  buildOllamaModelInfo,
  resolveActiveModel,
  type ModelResolution,
  type ProviderModelInfoFloor,
  type ResolvedChatEndpoint,
} from './modelResolver'
import type { ModelResolverSettings } from './types'

/**
 * Process-level Model System entry point: answers "what is the active model
 * and what do we know about it" for runtime and renderer through ONE seam.
 *
 * The provider floor (what the wire protocol itself guarantees) is fetched
 * from the real provider instances via ModelRouter; identity, profile window
 * and the reasoning-compatibility policy are applied by ModelResolver.
 * Nothing here persists or reaches the network (Catalog v1).
 */
export class ModelCatalogService {
  readonly #catalog = new ModelCatalog()
  readonly #router: ModelRouter

  constructor(router: ModelRouter) {
    this.#router = router
  }

  get catalog(): ModelCatalog {
    return this.#catalog
  }

  /**
   * Build a provider-floor probe for the given settings: Ollama answers for
   * its own models; each API profile's endpoint answers for the model chosen
   * in it (no baseUrl → no floor; profile values still apply).
   */
  #floorFor(settings: ModelResolverSettings): ProviderModelInfoFloor {
    return (providerId, modelId) => {
      if (providerId === OLLAMA_PROVIDER_ID) {
        return providerModelInfo(this.#router.local(), modelId)
      }
      const profileId = providerId.startsWith('api:') ? providerId.slice('api:'.length) : ''
      const profile = settings.apiProfiles.find((candidate) => candidate.id === profileId)
      if (profile === undefined || !profile.baseUrl.trim()) return undefined
      const provider = this.#router.forEndpoint({
        kind: 'openai',
        baseUrl: profile.baseUrl,
        contextWindow: profile.advanced.contextWindowTokens ?? undefined,
        compatibility: { sendReasoningEffort: profile.advanced.sendReasoningEffort },
      })
      return providerModelInfo(provider, modelId)
    }
  }

  /** The single active-model answer used by runtime (chat.start) and IPC. */
  resolveActive(
    settings: ModelResolverSettings,
    endpoint: ResolvedChatEndpoint | null,
  ): ModelResolution {
    const resolution = resolveActiveModel(settings, endpoint, this.#floorFor(settings))
    if (resolution.status === 'resolved') {
      this.#catalog.upsert(resolution.info)
    }
    return resolution
  }

  /**
   * Known-model list: every configured profile's selected model plus the
   * local selection. Rebuilt per call against the CURRENT settings, so a
   * deleted profile's `api:<id>` entries drop out (replaceProvider semantics)
   * instead of lingering in the catalog.
   */
  syncKnown(settings: ModelResolverSettings): readonly ModelInfo[] {
    const floor = this.#floorFor(settings)
    const infos: ModelInfo[] = []
    for (const profile of settings.apiProfiles) {
      const modelId = profile.model.trim()
      if (!modelId) continue
      infos.push(buildApiModelInfo(profile, { model: modelId, advanced: profile.advanced }, floor(apiProfileProviderId(profile.id), modelId)))
    }
    const selected = settings.selectedModel.trim()
    if (selected) {
      infos.push(buildOllamaModelInfo({ providerId: OLLAMA_PROVIDER_ID, modelId: selected }, floor(OLLAMA_PROVIDER_ID, selected)))
    }
    const providerIds = new Set<string>([OLLAMA_PROVIDER_ID])
    for (const profile of settings.apiProfiles) providerIds.add(apiProfileProviderId(profile.id))
    for (const providerId of providerIds) {
      this.#catalog.replaceProvider(providerId, infos.filter((info) => info.ref.providerId === providerId))
    }
    return infos
  }
}
