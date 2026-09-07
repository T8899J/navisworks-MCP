import { describe, expect, it } from 'vitest'
import {
  resolveActiveModel,
  resolveActiveModelRef,
  type ResolvedChatEndpoint,
} from '../model/catalog/modelResolver'
import { ModelCatalogService } from '../model/catalog/modelCatalogService'
import { ModelCatalog } from '../model/catalog/modelCatalog'
import { ModelRouter } from '../model/modelRouter'
import { DEFAULT_API_PROFILE_ADVANCED, type AppSettings } from '../../shared/ipc'
import type { ModelResolverSettings } from '../model/catalog/types'

function profileSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    selectedModel: 'qwen3.5:9b',
    models: ['qwen3.5:9b'],
    reasoningMode: 'low',
    themeMode: 'system',
    disabledTools: [],
    fontScale: 1,
    contextWindowTokens: 32768,
    preferApiModel: false,
    ollamaEnabled: true,
    apiEnabled: true,
    apiProfiles: [],
    activeApiProfileId: null,
    toolPermissions: {},
    execution: { maxToolRounds: 8, compactionEnabled: true, compactionTriggerRatio: 0.85, compactKeepRecentFrames: 1, compactMaxTranscriptChars: 30_000, historyMode: 'auto', historyMessageLimit: null, toolResultMode: 'auto', toolResultMaxChars: null, plannerMaxAttempts: 2, plannerMaxSteps: 10, plannerMaxTokens: 2048, verifierMaxAttempts: 2, verifierMaxEvidence: 12, maxTaskReplans: 2 },
    storage: { maxSessions: 30, maxMessagesPerSession: 100 },
    ...overrides,
  }
}

function profileOf(id: string, model: string, advancedOverrides: Partial<typeof DEFAULT_API_PROFILE_ADVANCED> = {}) {
  return {
    id,
    name: `Profile ${id}`,
    baseUrl: `https://p${id}.example.com/v1`,
    model,
    hasApiKey: false,
    advanced: { ...DEFAULT_API_PROFILE_ADVANCED, ...advancedOverrides },
  }
}

describe('Model Identity — resolveActiveModelRef (§52)', () => {
  it('Case 1: local settings resolve to the ollama provider with the selected model', () => {
    const settings = profileSettings({ selectedModel: 'qwen3.5:9b' })
    expect(resolveActiveModelRef(settings, null)).toEqual({
      providerId: 'ollama',
      modelId: 'qwen3.5:9b',
    })
  })

  it('Case 2: an active API profile becomes providerId api:<profileId>', () => {
    const settings = profileSettings({
      preferApiModel: true,
      apiProfiles: [profileOf('profile-123', 'glm-5.3-flash')],
      activeApiProfileId: 'profile-123',
    })
    const endpoint: ResolvedChatEndpoint = { baseUrl: settings.apiProfiles[0]!.baseUrl, model: 'glm-5.3-flash' }
    expect(resolveActiveModelRef(settings, endpoint)).toEqual({
      providerId: 'api:profile-123',
      modelId: 'glm-5.3-flash',
    })
  })

  it('Case 3: two profiles with the same model name stay DISTINCT refs', () => {
    const settings = profileSettings({
      preferApiModel: true,
      apiProfiles: [profileOf('A', 'model-x'), profileOf('B', 'model-x')],
      activeApiProfileId: 'A',
    })
    const a = resolveActiveModelRef(settings, { model: 'model-x' })
    const b = resolveActiveModelRef({ ...settings, activeApiProfileId: 'B' } as ModelResolverSettings, { model: 'model-x' })
    expect(a).toEqual({ providerId: 'api:A', modelId: 'model-x' })
    expect(b).toEqual({ providerId: 'api:B', modelId: 'model-x' })
    expect(a.providerId).not.toBe(b.providerId)
  })

  it('ollama disabled + usable active API profile routes to api even without preferApiModel', () => {
    const settings = profileSettings({
      ollamaEnabled: false,
      preferApiModel: false,
      apiProfiles: [profileOf('only', 'glm-x')],
      activeApiProfileId: 'only',
    })
    expect(resolveActiveModelRef(settings, { model: 'glm-x' }).providerId).toBe('api:only')
  })
})

describe('ModelInfo metadata (§15–§17, §53)', () => {
  it('Ollama info: 32K local window, tools+reasoning true, two modes, metadataSource local', () => {
    const settings = profileSettings()
    const result = resolveActiveModel(settings, null)
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') return
    expect(result.info.ref).toEqual({ providerId: 'ollama', modelId: 'qwen3.5:9b' })
    expect(result.info.limits.context).toBe(32_768)
    expect(result.info.capabilities.tools).toBe(true)
    expect(result.info.capabilities.reasoning).toBe(true)
    expect(result.info.capabilities.temperature).toBe(true)
    expect(result.info.reasoning.modes).toEqual(['low', 'max'])
    expect(result.info.metadataSource).toBe('local')
    expect(result.info.provider.kind).toBe('ollama')
  })

  it('Case A: profile-pinned 128000 → limits.context = 128000, metadataSource profile', () => {
    const settings = profileSettings({
      preferApiModel: true,
      apiProfiles: [profileOf('p1', 'glm-x', { contextWindowTokens: 128_000 })],
      activeApiProfileId: 'p1',
    })
    const result = resolveActiveModel(settings, { baseUrl: 'https://x/v1', model: 'glm-x' })
    if (result.status !== 'resolved') throw new Error('expected resolved')
    expect(result.info.limits.context).toBe(128_000)
    expect(result.info.metadataSource).toBe('profile')
  })

  it('Case B: Auto + provider-unknown → limits.context UNDEFINED (never 32768)', () => {
    const settings = profileSettings({
      preferApiModel: true,
      apiProfiles: [profileOf('p1', 'glm-x', { contextWindowTokens: null })],
      activeApiProfileId: 'p1',
    })
    const result = resolveActiveModel(settings, { baseUrl: 'https://x/v1', model: 'glm-x' })
    if (result.status !== 'resolved') throw new Error('expected resolved')
    expect(result.info.limits.context).toBeUndefined()
    expect(result.info.metadataSource).toBe('unknown')
    // And the reasoning capability under 'auto' is unknown, NOT true:
    expect(result.info.capabilities.reasoning).toBeUndefined()
  })

  it('Case C: the runtime fallback (resolveApiContextWindow) keeps source=fallback — ModelInfo stays unknown', async () => {
    const { resolveApiContextWindow } = await import('../agentRuntime')
    const resolution = resolveApiContextWindow(null, {}, 32_768)
    expect(resolution.window).toBe(32_768)
    expect(resolution.source).toBe('fallback')
    // Same settings that give Case B: ModelInfo says nothing, runtime says budget.
    const settings = profileSettings({
      preferApiModel: true,
      apiProfiles: [profileOf('p1', 'glm-x')],
      activeApiProfileId: 'p1',
    })
    const result = resolveActiveModel(settings, { baseUrl: 'https://x/v1', model: 'glm-x' })
    if (result.status !== 'resolved') throw new Error('expected resolved')
    expect(result.info.limits.context).toBeUndefined()
    expect(resolution.source).not.toBe('profile')
  })
})

describe('Reasoning modes by provider policy (§60)', () => {
  it('API sendReasoningEffort=off → modes [] and reasoning capability false', () => {
    const settings = profileSettings({
      preferApiModel: true,
      apiProfiles: [profileOf('p1', 'glm-x', { sendReasoningEffort: 'off' })],
      activeApiProfileId: 'p1',
    })
    const result = resolveActiveModel(settings, { baseUrl: 'https://x/v1', model: 'glm-x' })
    if (result.status !== 'resolved') throw new Error('expected resolved')
    expect(result.info.reasoning.modes).toEqual([])
    expect(result.info.capabilities.reasoning).toBe(false)
  })

  it('API sendReasoningEffort=on → five modes and capability true', () => {
    const settings = profileSettings({
      preferApiModel: true,
      apiProfiles: [profileOf('p1', 'glm-x', { sendReasoningEffort: 'on' })],
      activeApiProfileId: 'p1',
    })
    const result = resolveActiveModel(settings, { baseUrl: 'https://x/v1', model: 'glm-x' })
    if (result.status !== 'resolved') throw new Error('expected resolved')
    expect(result.info.reasoning.modes).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(result.info.capabilities.reasoning).toBe(true)
  })

  it('empty active profile (model="") → MODEL_NOT_CONFIGURED signal, never a crash', () => {
    const settings = profileSettings({ selectedModel: '', models: [] })
    const result = resolveActiveModel(settings, null)
    expect(result).toEqual({
      status: 'not-configured',
      reason: 'no-active-model',
      ref: { providerId: 'ollama', modelId: '' },
    })
  })
})

describe('ModelCatalog (§11)', () => {
  it('upsert / resolve by full ref; removeProvider drops all its entries', async () => {
    const { buildOllamaModelInfo } = await import('../model/catalog/modelResolver')
    const catalog = new ModelCatalog()
    const a = buildOllamaModelInfo({ providerId: 'ollama', modelId: 'qwen3.5:9b' })
    catalog.upsert(a)
    expect(catalog.resolve({ providerId: 'ollama', modelId: 'qwen3.5:9b' })).toBe(a)
    expect(catalog.resolve({ providerId: 'ollama', modelId: 'other' })).toBeUndefined()
    expect(catalog.resolve({ providerId: 'api:ollama', modelId: 'qwen3.5:9b' })).toBeUndefined()
    catalog.removeProvider('ollama')
    expect(catalog.listKnown()).toHaveLength(0)
  })
})

describe('ModelCatalogService — provider floors (§18)', () => {
  it('Ollama active model is enriched from the REAL local provider instance', () => {
    const service = new ModelCatalogService(new ModelRouter())
    const result = service.resolveActive(profileSettings(), null)
    if (result.status !== 'resolved') throw new Error('expected resolved')
    expect(result.info.ref).toEqual({ providerId: 'ollama', modelId: 'qwen3.5:9b' })
    expect(result.info.provider.displayName).toBe('Ollama')
    // The catalog now knows it.
    expect(service.catalog.resolve({ providerId: 'ollama', modelId: 'qwen3.5:9b' })).toBeDefined()
  })

  it('API active model merges the endpoint floor + profile window without touching secrets', () => {
    const settings = profileSettings({
      preferApiModel: true,
      apiProfiles: [profileOf('sec', 'glm-x', { contextWindowTokens: 64_000 })],
      activeApiProfileId: 'sec',
    })
    const service = new ModelCatalogService(new ModelRouter())
    const result = service.resolveActive(settings, {
      baseUrl: 'https://psec.example.com/v1',
      apiKey: 'sk-secret-123',
      model: 'glm-x',
    })
    if (result.status !== 'resolved') throw new Error('expected resolved')
    expect(result.info.ref).toEqual({ providerId: 'api:sec', modelId: 'glm-x' })
    expect(result.info.limits.context).toBe(64_000)
    expect(result.info.metadataSource).toBe('profile')
    // Nothing key-like may leak into ModelInfo.
    expect(JSON.stringify(result.info)).not.toContain('sk-secret-123')
    expect(JSON.stringify(result.info)).not.toMatch(/apiKey|secret/i)
  })
})
