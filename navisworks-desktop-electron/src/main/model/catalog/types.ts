/**
 * Catalog-local helper types. ModelRef / ModelInfo / ModelUsage themselves are
 * SHARED types (src/shared/model.ts) with Zod twins in src/shared/ipc/schemas.ts
 * (the IPC single source, so main/renderer can never drift).
 */

/**
 * Settings shape the resolver reads (structurally satisfied by both the
 * persisted settings and the AppSettings IPC shape). Old fields stay exactly
 * as they are — the resolver ADAPTS them, nothing new is persisted.
 */
export interface ModelResolverSettings {
  selectedModel: string
  reasoningMode: string
  preferApiModel: boolean
  ollamaEnabled: boolean
  apiEnabled: boolean
  activeApiProfileId: string | null
  /** Safe local fallback budget; used for the local clamp only, never faked into API models. */
  contextWindowTokens: number
  apiProfiles: readonly ModelResolverProfile[]
}

/** One API profile as seen by the resolver — connection config + chosen model. */
export interface ModelResolverProfile {
  id: string
  name: string
  baseUrl: string
  model: string
  advanced: {
    contextWindowTokens: number | null
    sendReasoningEffort: 'auto' | 'on' | 'off'
  }
}
