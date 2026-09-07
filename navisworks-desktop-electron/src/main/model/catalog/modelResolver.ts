import { REASONING_EFFORTS, type ReasoningEffort } from '../../../shared/reasoning'
import {
  apiProfileProviderId,
  OLLAMA_PROVIDER_ID,
  type ModelInfo,
  type ModelRef,
} from '../../../shared/model'
import { LOCAL_MAX_CONTEXT_TOKENS } from '../../agent/contextManager'
import type { ModelResolverProfile, ModelResolverSettings } from './types'

/**
 * Endpoint resolved by the SAME provider-switch rules chat runs use
 * (ipc.ts resolveChatEndpoint is the runtime producer of this shape):
 * `null` means the local Ollama daemon serves the next run.
 */
export interface ResolvedChatEndpoint {
  baseUrl?: string
  apiKey?: string
  model: string
  advanced?: {
    contextWindowTokens: number | null
    sendReasoningEffort: 'auto' | 'on' | 'off'
  } & Record<string, unknown>
}

export type ModelResolution =
  | { status: 'resolved'; info: ModelInfo }
  | { status: 'not-configured'; reason: 'no-active-model'; ref: ModelRef }

/**
 * The active model's IDENTITY: `api:<profileId>` for an API profile (so two
 * endpoints with the same model id stay distinct), `ollama` for the local
 * daemon. When both switches block every provider — or the active profile has
 * no model yet — `ollamaEnabled` alone decides whether local is even possible.
 */
export function resolveActiveModelRef(
  settings: ModelResolverSettings,
  endpoint: ResolvedChatEndpoint | null,
): ModelRef {
  const activeProfile = settings.apiProfiles.find(
    (profile) => profile.id === settings.activeApiProfileId,
  )
  const apiChosen = settings.apiEnabled
    && (settings.preferApiModel || !settings.ollamaEnabled)
    && activeProfile !== undefined
    && endpoint !== null
  if (apiChosen && activeProfile) {
    return { providerId: apiProfileProviderId(activeProfile.id), modelId: endpoint.model.trim() }
  }
  return { providerId: OLLAMA_PROVIDER_ID, modelId: settings.selectedModel.trim() }
}

/**
 * Provider metadata seam: given a connection identity, ask the provider
 * instance for what the WIRE PROTOCOL itself guarantees (the ModelCatalog
 * wires this to `providerModelInfo(router, …)`). Absent → the resolver's
 * built-in floors apply.
 */
export type ProviderModelInfoFloor = (providerId: string, modelId: string) => ModelInfo | undefined

/** The local daemon reports its own truth: 32K clamp, two-step reasoning. */
export function buildOllamaModelInfo(ref: ModelRef, floor?: ModelInfo): ModelInfo {
  return {
    ref,
    displayName: ref.modelId,
    provider: floor?.provider ?? { id: OLLAMA_PROVIDER_ID, displayName: 'Ollama', kind: 'ollama' },
    capabilities: floor?.capabilities
      ?? { tools: true, reasoning: true, temperature: true, attachments: false },
    limits: floor?.limits ?? { context: LOCAL_MAX_CONTEXT_TOKENS },
    reasoning: floor?.reasoning ?? { modes: ['low', 'max'] },
    metadataSource: floor?.metadataSource ?? 'local',
  }
}

/**
 * ModelInfo for an API profile. An endpoint's /models list proves the model
 * EXISTS — not that it has a window, reasoning, or any capability — so
 * everything unknown stays `undefined`, and the runtime's 32K fallback is
 * deliberately NOT written into limits.context here.
 */
export function buildApiModelInfo(
  profile: ModelResolverProfile,
  endpoint: ResolvedChatEndpoint,
  floor?: ModelInfo,
): ModelInfo {
  const providerId = apiProfileProviderId(profile.id)
  const modelId = profile.model.trim()
  const configuredWindow = profile.advanced.contextWindowTokens
  // sendReasoningEffort is a REQUEST-COMPATIBILITY policy — it decides what
  // rides on the WIRE (requestPolicy) and which steps the UI may offer (modes:
  // 'off' → none). It is NEVER a capability statement: capabilities.reasoning
  // stays whatever the floor proves (nothing for OpenAI-compatible endpoints),
  // so it remains undefined no matter how the user configures the profile.
  const sendEffort = endpoint.advanced?.sendReasoningEffort ?? profile.advanced.sendReasoningEffort
  const modes: readonly ReasoningEffort[] = sendEffort === 'off' ? [] : REASONING_EFFORTS
  return {
    ref: { providerId, modelId },
    displayName: modelId,
    provider: { id: providerId, displayName: profile.name, kind: 'openai-compatible' },
    capabilities: { ...(floor?.capabilities ?? { tools: true, temperature: true }) },
    limits: configuredWindow != null && configuredWindow > 0 ? { context: configuredWindow } : {},
    reasoning: { modes, requestPolicy: sendEffort },
    metadataSource: configuredWindow != null && configuredWindow > 0 ? 'profile' : 'unknown',
  }
}

/**
 * The ONE place that answers "which model is active and what do we know about
 * it". App / Composer / SettingsPanel / AgentRuntime must never re-derive
 * preferApiModel / activeApiProfileId / ollamaEnabled themselves.
 */
export function resolveActiveModel(
  settings: ModelResolverSettings,
  endpoint: ResolvedChatEndpoint | null,
  floor?: ProviderModelInfoFloor,
): ModelResolution {
  const ref = resolveActiveModelRef(settings, endpoint)
  if (!ref.modelId) {
    return { status: 'not-configured', reason: 'no-active-model', ref }
  }
  const activeProfile = ref.providerId.startsWith('api:')
    ? settings.apiProfiles.find((profile) => apiProfileProviderId(profile.id) === ref.providerId)
    : undefined
  if (activeProfile) {
    const providerEndpoint = endpoint ?? { model: activeProfile.model }
    return {
      status: 'resolved',
      info: buildApiModelInfo(activeProfile, providerEndpoint, floor?.(ref.providerId, ref.modelId)),
    }
  }
  return {
    status: 'resolved',
    info: buildOllamaModelInfo(ref, floor?.(OLLAMA_PROVIDER_ID, ref.modelId)),
  }
}
