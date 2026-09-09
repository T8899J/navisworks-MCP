import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Composer } from '../Composer'
import { DEFAULT_API_PROFILE_ADVANCED, DEFAULT_EXECUTION_SETTINGS, DEFAULT_STORAGE_SETTINGS } from '../../shared/ipc'
import type { DesktopSettings, ModelInfo } from '../chatTypes'

function settingsOf(overrides: Partial<DesktopSettings> = {}): DesktopSettings {
  return {
    selectedModel: 'qwen3.5:9b',
    models: ['qwen3.5:9b'],
    reasoningMode: 'medium',
    themeMode: 'system',
    disabledTools: [],
    fontScale: 1,
    contextWindowTokens: 32_768,
    preferApiModel: true,
    ollamaEnabled: true,
    apiEnabled: true,
    apiProfiles: [{
      id: 'p1', name: 'P1', baseUrl: 'https://x/v1', model: 'glm-x', hasApiKey: false,
      advanced: { ...DEFAULT_API_PROFILE_ADVANCED },
    }],
    activeApiProfileId: 'p1',
    toolPermissions: {},
    execution: { ...DEFAULT_EXECUTION_SETTINGS },
    storage: { ...DEFAULT_STORAGE_SETTINGS },
    modelConfigurations: [],
    ...overrides,
  }
}

const ollamaModel: ModelInfo = {
  ref: { providerId: 'ollama', modelId: 'qwen3.5:9b' },
  displayName: 'qwen3.5:9b',
  provider: { id: 'ollama', displayName: 'Ollama', kind: 'ollama' },
  capabilities: { tools: true, reasoning: true, temperature: true, attachments: false },
  limits: { context: 32_768 },
  reasoning: { modes: ['low', 'max'] },
  metadataSource: 'local',
}

const apiModel: ModelInfo = {
  ref: { providerId: 'api:p1', modelId: 'glm-x' },
  displayName: 'glm-x',
  provider: { id: 'api:p1', displayName: 'P1', kind: 'openai-compatible' },
  capabilities: { tools: true, temperature: true },
  limits: {},
  reasoning: { modes: ['low', 'medium', 'high', 'xhigh', 'max'], requestPolicy: 'auto' },
  metadataSource: 'unknown',
}

const apiModelNoReasoning: ModelInfo = {
  ...apiModel,
  reasoning: { modes: [], requestPolicy: 'off' },
}

function render(props: Partial<Parameters<typeof Composer>[0]> = {}): string {
  return renderToStaticMarkup(
    <Composer
      dockRef={{ current: null }}
      draft=""
      busy={false}
      settings={settingsOf()}
      serviceAvailable
      onDraftChange={() => undefined}
      onSend={() => undefined}
      onStop={() => undefined}
      onResolveApproval={() => undefined}
      onModelChange={() => undefined}
      onApiModelPick={() => undefined}
      onSlashCommand={() => undefined}
      onReasoningChange={() => undefined}
      {...props}
    />,
  )
}

beforeAll(() => {
  (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) }
})
afterAll(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('Composer model identity (P8.5 §56)', () => {
  it('Case A: an openai-compatible ModelInfo switches the ring to API mode', () => {
    const markup = render({ activeModel: apiModel })
    expect(markup).toContain('context-ring api')
    expect(markup).toContain('glm-x')
  })

  it('Case B: settings routing may disagree mid-switch — the OLLAMA ModelInfo wins', () => {
    // settings.preferApiModel is true (stale), but main resolved the local
    // model: the composer must NOT show api mode and must snap medium→low.
    const markup = render({ activeModel: ollamaModel })
    expect(markup).not.toContain('context-ring api')
    expect(markup).toContain('qwen3.5:9b')
    expect(markup).toContain('data-effort="low"')
  })

  it('modes [] (requestPolicy off): no effort chip, hidden selector, notice instead', () => {
    const markup = render({ activeModel: apiModelNoReasoning })
    // Token-exact: 'composer-menu-trigger-mode' is a prefix of '...-model',
    // so the closing quote is required to distinguish the effort label span.
    expect(markup).not.toContain('composer-menu-trigger-mode"')
    expect(markup).not.toContain('composer-picker-chip-mode"')
    expect(markup).toContain('当前模型不支持推理强度选择')
  })

  it('no active model yet: neutral 未确定 state — never re-derive routing from settings', () => {
    const markup = render({})
    expect(markup).toContain('未确定')
    // preferApiModel is TRUE in settings — the composer must not paint the API
    // ring class from that alone.
    expect(markup).not.toContain('context-ring api')
  })
})
