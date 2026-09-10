import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'
import { DEFAULT_API_PROFILE_ADVANCED, DEFAULT_EXECUTION_SETTINGS, DEFAULT_STORAGE_SETTINGS } from '../../shared/ipc'
import type { DesktopSettings } from '../chatTypes'

const settings: DesktopSettings = {
  selectedModel: 'local', models: ['local'], reasoningMode: 'medium', themeMode: 'dark',
  disabledTools: [], fontScale: 1, contextWindowTokens: 32768, preferApiModel: true,
  ollamaEnabled: true, apiEnabled: true, activeApiProfileId: 'a', toolPermissions: {},
  execution: DEFAULT_EXECUTION_SETTINGS, storage: DEFAULT_STORAGE_SETTINGS,
  apiProfiles: [{ id: 'a', name: 'Cloud API', baseUrl: 'https://example.com/v1', model: 'm1', models: ['m1', 'm2'], hasApiKey: false, advanced: DEFAULT_API_PROFILE_ADVANCED }],
  modelConfigurations: [{ ref: { providerId: 'api:a', modelId: 'm1' }, contextWindowTokens: 1_000_000, inputModalities: ['text', 'image'] }],
}
const noop = () => undefined
function render(value = settings) {
  return renderToStaticMarkup(<SettingsPanel settings={value} themeMode="dark" serviceAvailable activePage="model" tools={[]}
    onThemeModeChange={noop} onFontScaleChange={noop} onProviderChange={noop}
    onSaveApiProfile={async () => value} onDeleteApiProfile={async () => value}
    onModelChange={noop} onModelConfigurationsChange={noop} onDisabledToolsChange={noop}
    onToolPermissionChange={noop} onBulkToolPermissions={noop} onRefreshModels={noop}
    onFetchCloudModels={async () => []} onNotice={noop} onTestApiProfile={async () => ({connected: true, message: ''})} />)
}
describe('API provider detail', () => {
  it('shows model rows with scoped metadata and title actions instead of a model selector', () => {
    const html = render()
    expect(html).toContain('Base URL')
    expect(html).toContain('API 格式')
    expect(html).toContain('模型列表')
    expect(html).toContain('编辑模型 m2')
    expect(html).toContain('视觉')
    expect(html).toContain('1M')
    expect(html).toContain('删除 API 配置')
    expect(html).toContain('>禁用</button>')
    expect(html).not.toContain('当前模型')
    expect(html).not.toContain('设为当前')
    expect(html).not.toContain('model-picker')
    expect(html).not.toContain('id="provider-name"')
    expect(html).not.toContain('id="api-enabled"')
  })
  it('offers enable for a disabled provider and does not borrow other provider metadata', () => {
    const html = render({ ...settings, apiProfiles: [{ ...settings.apiProfiles[0]!, enabled: false }], modelConfigurations: [{ ref: { providerId: 'api:b', modelId: 'm1' }, contextWindowTokens: 1_000_000 }] })
    expect(html).toContain('>启用</button>')
    expect(html).not.toContain('>1M<')
  })
})
