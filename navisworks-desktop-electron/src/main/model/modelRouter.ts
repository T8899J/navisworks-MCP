import { OllamaProvider } from './ollamaProvider'
import { OpenAICompatibleProvider, type ProviderCompatibilityOptions } from './openaiProvider'
import type { ModelProvider, ProviderEndpoint } from './types'

/** The always-on local worker endpoint. */
export const LOCAL_OLLAMA_BASE_URL = 'http://localhost:11434'

export interface ModelRouterOptions {
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
}

/** API endpoint options that ride the API profile's advanced settings. */
export interface ApiEndpointRoutingOptions extends ProviderEndpoint {
  requestTimeoutMs?: number
  contextWindow?: number
  compatibility?: ProviderCompatibilityOptions
}

/**
 * Explicit routing between the local Ollama daemon and a configured
 * OpenAI-compatible API endpoint.
 */
export class ModelRouter {
  readonly #options: ModelRouterOptions

  constructor(options: ModelRouterOptions = {}) {
    this.#options = options
  }

  /** The local Ollama provider used for all normal completions. */
  local(): OllamaProvider {
    return new OllamaProvider({
      baseUrl: LOCAL_OLLAMA_BASE_URL,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      fetchImpl: this.#options.fetchImpl,
    })
  }

  forEndpoint(endpoint: ProviderEndpoint | ApiEndpointRoutingOptions): ModelProvider {
    if (endpoint.kind === 'openai') {
      const options = endpoint as ApiEndpointRoutingOptions
      return new OpenAICompatibleProvider({
        baseUrl: options.baseUrl ?? '',
        apiKey: options.apiKey,
        requestTimeoutMs: options.requestTimeoutMs ?? this.#options.requestTimeoutMs,
        contextWindow: options.contextWindow,
        compatibility: options.compatibility,
        fetchImpl: this.#options.fetchImpl,
      })
    }
    return new OllamaProvider({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      fetchImpl: this.#options.fetchImpl,
    })
  }
}
