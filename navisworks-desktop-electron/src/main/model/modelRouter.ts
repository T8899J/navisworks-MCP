import { OllamaProvider } from './ollamaProvider'
import { OpenAICompatibleProvider } from './openaiProvider'
import type { ModelProvider, ProviderEndpoint } from './types'

/** The always-on local worker endpoint. */
export const LOCAL_OLLAMA_BASE_URL = 'http://localhost:11434'

export interface ModelRouterOptions {
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
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

  forEndpoint(endpoint: ProviderEndpoint): ModelProvider {
    if (endpoint.kind === 'openai') {
      return new OpenAICompatibleProvider({
        baseUrl: endpoint.baseUrl ?? '',
        apiKey: endpoint.apiKey,
        requestTimeoutMs: this.#options.requestTimeoutMs,
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
