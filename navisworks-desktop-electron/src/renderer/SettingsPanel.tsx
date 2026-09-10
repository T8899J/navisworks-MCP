import { ModelPicker } from './ModelPicker'
import {
  Bot,
  Database,
  Gauge,
  KeyRound,
  LoaderCircle,
  MonitorCog,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wrench
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState
} from 'react'
import { DEFAULT_API_PROFILE_ADVANCED, type ApiProfileAdvancedSettings, type ThemeMode, type ToolDefinitionSummary, type ToolName, type ToolPermission } from '../shared/ipc'
import type { DesktopSettings, ModelConfiguration, ModelRef } from './chatTypes'
import { ModelConfigurationDialog, type ModelConfigurationDraft } from './ModelConfigurationDialog'
import { ApiProfileDialog, type ApiProfileAction } from './ApiProfileDialog'

export interface RuntimeDiagnostics {
  dataDirectory?: string
  runtime?: string
}

function ModelBadges({ configuration }: { configuration?: ModelConfiguration }) {
  const formatTokens = (value: number) => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(2)}M` : `${+(value / 1000).toFixed(1)}K`
  return <span className="provider-model-badges">
    {configuration?.inputModalities?.includes('image') ? <span>视觉</span> : null}
    {configuration?.inputModalities?.includes('video') ? <span>视频</span> : null}
    {configuration?.inputModalities?.includes('pdf') ? <span>PDF</span> : null}
    {configuration?.outputModalities?.includes('image') ? <span>生图</span> : null}
    {configuration?.contextWindowTokens != null ? <span>{formatTokens(configuration.contextWindowTokens)}</span> : null}
    {configuration?.maxOutputTokens != null ? <span>输出 {formatTokens(configuration.maxOutputTokens)}</span> : null}
  </span>
}

export type SettingsPageId = 'appearance' | 'model' | 'tools' | 'runtime'

export const SETTINGS_PAGES: Array<{
  id: SettingsPageId
  label: string
  icon: typeof Palette
}> = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'model', label: '模型', icon: Bot },
  { id: 'tools', label: '工具与权限', icon: Wrench },
  { id: 'runtime', label: '运行信息', icon: Database }
]

/** Discrete font-size levels; the slider snaps to these so the active
 *  step is always visible. */
const FONT_LEVELS = [
  { value: 0.9, label: '小' },
  { value: 0.95, label: '较小' },
  { value: 1, label: '默认' },
  { value: 1.15, label: '较大' },
  { value: 1.3, label: '大' }
] as const

/**
 * Positions a tick/label directly under the slider thumb's center. The thumb
 * is 14px wide, so its center sweeps [7px, width-7px]; percentage-only
 * centering drifts at the endpoints, which is what left the old labels
 * misaligned with the nodes.
 */
const THUMB_HALF_WIDTH_PX = 7

const thumbAlignedLeft = (index: number, count: number): string =>
  `calc(${THUMB_HALF_WIDTH_PX}px + (100% - ${THUMB_HALF_WIDTH_PX * 2}px) * ${index / (count - 1)})`

interface SettingsPanelProps {
  settings: DesktopSettings
  themeMode: ThemeMode
  serviceAvailable: boolean
  diagnostics?: RuntimeDiagnostics
  /** Category picked in the sidebar's settings list; renders its page. */
  activePage: SettingsPageId
  onThemeModeChange(mode: ThemeMode): void | Promise<void>
  onFontScaleChange(scale: number): void | Promise<void>
  onProviderChange(patch: {
    preferApiModel?: boolean
    activeApiProfileId?: string | null
    ollamaEnabled?: boolean
    apiEnabled?: boolean
  }): void | Promise<void>
  onSaveApiProfile(profile: {
    id?: string
    name: string
    baseUrl: string
    model: string
    models?: string[]
    enabled?: boolean
    apiKey?: string
    clearApiKey?: boolean
    /** Full compatibility/capability set; callers spread the profile's existing value. */
    advanced?: ApiProfileAdvancedSettings
  }): Promise<DesktopSettings>
  onDeleteApiProfile(profileId: string): Promise<DesktopSettings>
  onModelChange(model: string): void | Promise<void>
  /** Model Configuration v2 (§19): persist the full per-model override list. */
  onModelConfigurationsChange(configurations: ModelConfiguration[]): void | Promise<void>
  onDisabledToolsChange(disabledTools: ToolName[]): void | Promise<void>
  /** Registry summaries (resolved permissions included) for the 工具与权限 page. */
  tools: ToolDefinitionSummary[]
  /** Persist one tool permission change; the next run applies it. */
  onToolPermissionChange(name: ToolName, permission: ToolPermission): void | Promise<void>
  /** Persist a whole permission map (只读模式 toggle). */
  onBulkToolPermissions(permissions: Record<string, ToolPermission>): void | Promise<void>
  onRefreshModels(): void | Promise<void>
  /** Lists models from the given OpenAI-compatible endpoint (cloud fetch). */
  onFetchCloudModels(profileId: string): Promise<string[]>
  /** Result of the last connectivity test: round-trip ms; ok=false on failure. */
  cloudLatency?: { ok: boolean; ms: number } | null
  onNotice(message: string): void
  onTestApiProfile(profileId: string): Promise<{ connected: boolean; message: string }>
}


export function SettingsPanel({
  settings,
  themeMode,
  serviceAvailable,
  diagnostics,
  activePage,
  onThemeModeChange,
  onFontScaleChange,
  onProviderChange,
  onSaveApiProfile,
  onDeleteApiProfile,
  onModelChange,
  onModelConfigurationsChange,
  onDisabledToolsChange,
  onToolPermissionChange,
  onBulkToolPermissions,
  tools,
  onRefreshModels,
  onFetchCloudModels,
  cloudLatency,
  onNotice,
  onTestApiProfile
}: SettingsPanelProps) {
  // Separate busy flags: the connectivity test and the local model refresh
  // are unrelated operations and must never disable each other.
  const [testBusy, setTestBusy] = useState(false)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [providerPage, setProviderPage] = useState<'api' | 'ollama'>('api')
  // Provider connection inputs keep local text state (cherry-studio style
  // blur-commit) and re-sync when the saved settings change underneath.
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    settings.activeApiProfileId ?? settings.apiProfiles[0]?.id ?? null
  )
  const selectedProfile = settings.apiProfiles.find((profile) => profile.id === selectedProfileId)
    ?? settings.apiProfiles[0]
  const [profileNameText, setProfileNameText] = useState(selectedProfile?.name ?? '')
  const [providerBaseUrlText, setProviderBaseUrlText] = useState(selectedProfile?.baseUrl ?? '')
  const [cloudModelText, setCloudModelText] = useState(selectedProfile?.model ?? '')
  const [profileAction, setProfileAction] = useState<ApiProfileAction | null>(null)
  const [editingProfileName, setEditingProfileName] = useState(false)
  const profileNameInput = useRef<HTMLInputElement>(null)
  const [providerToggleBusy, setProviderToggleBusy] = useState(false)
  const [profileError, setProfileError] = useState('')
  const apiModels = selectedProfile?.models ?? (selectedProfile?.model ? [selectedProfile.model] : [])
  // Model Configuration v2 (§41/§42): the profile-level 高级配置 上下文窗口 editor
  // is REMOVED — per-model overrides via 编辑模型配置 are the primary entry now.
  // profile.advanced.contextWindowTokens stays in the data (legacy fallback for
  // the resolver) but is no longer edited here, so a save must preserve it.
  // Model Configuration v2 (§26): which model's config dialog is open.
  const [modelConfigTarget, setModelConfigTarget] = useState<{
    providerId: string
    modelId: string
    modelIdEditable: boolean
  } | null>(null)
  const existingModelConfiguration = (ref: ModelRef): ModelConfiguration | undefined =>
    (settings.modelConfigurations ?? []).find(
      (configuration) => configuration.ref.providerId === ref.providerId
        && configuration.ref.modelId === ref.modelId,
    )
  const applyModelConfigDraft = async (draft: ModelConfigurationDraft): Promise<void> => {
    const base = draft.baseRef
    // Replace/insert the entry for THIS model (dropping any prior config bound to
    // the OLD ref, so a rename never leaves an orphan override, §27).
    const others = (settings.modelConfigurations ?? []).filter(
      (configuration) => !(configuration.ref.providerId === base.providerId
        && (configuration.ref.modelId === base.modelId || configuration.ref.modelId === draft.configuration.ref.modelId)),
    )
    const next = draft.cleared ? others : [...others, draft.configuration]
    if (selectedProfile && base.providerId === `api:${selectedProfile.id}` && !draft.cleared) {
      const modelId = draft.configuration.ref.modelId
      if (apiModels.some((id) => id === modelId && id !== base.modelId)) {
        onNotice('该模型已在列表中')
        return
      }
      const models = apiModels.includes(base.modelId)
        ? apiModels.map((id) => id === base.modelId ? modelId : id)
        : [...apiModels, modelId]
      await onSaveApiProfile({
        id: selectedProfile.id,
        name: selectedProfile.name,
        baseUrl: selectedProfile.baseUrl,
        model: !selectedProfile.model || selectedProfile.model === base.modelId ? modelId : selectedProfile.model,
        models,
        ...(selectedProfile.advanced ? { advanced: selectedProfile.advanced } : {}),
      })
    }
    await onModelConfigurationsChange(next)
    setModelConfigTarget(null)
    onNotice('已保存模型配置，正在刷新生效')
  }
  useEffect(() => {
    if (!selectedProfile) {
      setSelectedProfileId(settings.apiProfiles[0]?.id ?? null)
      return
    }
    setSelectedProfileId(selectedProfile.id)
    setProfileNameText(selectedProfile.name)
    setProviderBaseUrlText(selectedProfile.baseUrl)
    setCloudModelText(selectedProfile.model)
    setProfileAction(null)
    setEditingProfileName(false)
  }, [selectedProfile?.id, selectedProfile?.name, selectedProfile?.baseUrl, selectedProfile?.model])

  /**
   * Preserve the profile's existing advanced block verbatim. The context-window
   * editor is gone (superseded by the per-model dialog), so a save of the name /
   * URL / key / model must NOT clobber a legacy contextWindowTokens a previous
   * build stored — it stays the resolver's lowest-priority fallback (§42).
   */
  const resolveProfileAdvanced = (): ApiProfileAdvancedSettings =>
    selectedProfile?.advanced ?? DEFAULT_API_PROFILE_ADVANCED

  const refreshModels = async () => {
    setRefreshBusy(true)
    try {
      await onRefreshModels()
    } finally {
      setRefreshBusy(false)
    }
  }

  const testApiProfile = async () => {
    if (!selectedProfile) {
      onNotice('请先新建 API 配置')
      return
    }
    setTestBusy(true)
    try {
      const result = await onTestApiProfile(selectedProfile.id)
      if (!result.connected) onNotice(result.message)
    } finally {
      setTestBusy(false)
    }
  }

  const saveSelectedProfile = async (extra: { apiKey?: string; clearApiKey?: boolean; enabled?: boolean; models?: string[]; model?: string } = {}) => {
    if (!selectedProfile) return null
    setProfileError('')
    try {
      return await onSaveApiProfile({
        id: selectedProfile.id,
        name: profileNameText.trim() || selectedProfile.name,
        baseUrl: providerBaseUrlText.trim(),
        model: cloudModelText.trim(),
        advanced: resolveProfileAdvanced(),
        ...extra
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存 API 配置失败'
      setProfileError(message)
      onNotice(message)
      return null
    }
  }

  const addApiProfile = async () => {
    try {
      const before = new Set(settings.apiProfiles.map((profile) => profile.id))
      const saved = await onSaveApiProfile({
        name: `API ${settings.apiProfiles.length + 1}`,
        baseUrl: '',
        model: ''
      })
      const created = saved.apiProfiles.find((profile) => !before.has(profile.id))
      if (created) {
        setSelectedProfileId(created.id)
        setProviderPage('api')
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '新建 API 配置失败')
    }
  }

  const deleteSelectedProfile = async () => {
    if (!selectedProfile) return
    try {
      const saved = await onDeleteApiProfile(selectedProfile.id)
      setSelectedProfileId(saved.activeApiProfileId ?? saved.apiProfiles[0]?.id ?? null)
      setProfileAction(null)
      return true
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : '删除 API 配置失败')
      return false
    }
  }

  /**
   * Persist one tool permission. Deny entries are mirrored into the legacy
   * disabledTools list for old readers; ask/allow are removed from it (ask
   * must never read as disabled).
   */
  const changeToolPermission = (name: ToolName, permission: ToolPermission) => {
    const overrides = { ...(settings.toolPermissions ?? {}) }
    overrides[name] = permission
    const legacy = new Set(disabledTools)
    if (permission === 'deny') legacy.add(name)
    else legacy.delete(name)
    void onToolPermissionChange(name, permission)
    void onDisabledToolsChange([...legacy])
  }

  const disabledTools = settings.disabledTools ?? []
  // 只读模式: every view-changing tool resolves to deny.
  const readOnlyMode = tools
    .filter((tool) => tool.impact === 'view-state-change')
    .every((tool) => tool.permission === 'deny')
  // SETTINGS_PAGES is a compile-time constant; index 0 always exists.
  const activePageMeta = SETTINGS_PAGES.find((page) => page.id === activePage) ?? SETTINGS_PAGES[0]!
  // Snap legacy/off-step values to the nearest named level.
  const fontLevelIndex = FONT_LEVELS.reduce(
    (best, level, index) =>
      Math.abs(level.value - settings.fontScale) < Math.abs(FONT_LEVELS[best]!.value - settings.fontScale)
        ? index
        : best,
    0,
  )
  const activeLevel = FONT_LEVELS[fontLevelIndex]!

  // Read-only mode is derived state: checked means every view-state tool is
  // off. Turning it off re-enables exactly those tools and leaves the six
  // read-only switches untouched.
  return (
    <section
      className={`settings-page${activePage === 'model' ? ' settings-page--model' : ''}`}
      role="region"
      aria-label={activePageMeta.label}>
      <header className="settings-page-heading">
        <h3>{activePageMeta.label}</h3>
      </header>
            {activePage === 'appearance' ? (
              <>
                <fieldset className="theme-choice">
                  <legend className="sr-only">应用主题</legend>
                  {([
                    ['system', '跟随系统', '使用 Windows 应用颜色'],
                    ['light', '浅色', '始终使用浅色界面'],
                    ['dark', '深色', '始终使用深色界面']
                  ] as const).map(([value, label, hint]) => (
                    <label className="theme-option" data-selected={themeMode === value} key={value}>
                      <input
                        type="radio"
                        name="appearance-mode"
                        value={value}
                        checked={themeMode === value}
                        onChange={() => void onThemeModeChange(value)}
                      />
                      <MonitorCog aria-hidden="true" size={16} />
                      <span><strong>{label}</strong><small>{hint}</small></span>
                    </label>
                  ))}
                </fieldset>

                <h4 className="settings-group-title">
                  全局字体大小
                  <span className="font-scale-current">{activeLevel.label}</span>
                </h4>
                <div className="font-scale-slider">
                  <input
                    type="range"
                    min={0}
                    max={FONT_LEVELS.length - 1}
                    step={1}
                    value={fontLevelIndex}
                    aria-label="全局字体大小"
                    onChange={(event) => void onFontScaleChange(FONT_LEVELS[Number(event.currentTarget.value)]!.value)}
                  />
                  <div className="thumb-aligned-scale" aria-hidden="true">
                    <div className="font-scale-ticks">
                      {FONT_LEVELS.map((level, index) => (
                        <span
                          key={level.label}
                          data-active={index === fontLevelIndex}
                          style={{ left: thumbAlignedLeft(index, FONT_LEVELS.length) }}
                        />
                      ))}
                    </div>
                    <div className="font-scale-slider-labels">
                      {FONT_LEVELS.map((level, index) => (
                        <span
                          key={level.label}
                          data-active={index === fontLevelIndex}
                          style={{ left: thumbAlignedLeft(index, FONT_LEVELS.length) }}
                        >
                          {level.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {activePage === 'model' ? (
              <>
                <p className="model-settings-description">管理 API 供应商与本地模型，选择供应商以编辑配置。</p>
                <div className="model-settings-workspace">
                  <nav className="provider-navigation" aria-label="模型供应商">
                    <div className="provider-navigation-label">API 供应商</div>
                    {settings.apiProfiles.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        className="provider-navigation-item"
                        aria-current={providerPage === 'api' && profile.id === selectedProfile?.id ? 'page' : undefined}
                        onClick={() => { setSelectedProfileId(profile.id); setProviderPage('api') }}>
                        <Bot aria-hidden="true" size={17} />
                        <span>{profile.name}</span>
                        <span className="provider-state-dot" data-enabled={settings.apiEnabled && profile.enabled !== false} aria-label={settings.apiEnabled && profile.enabled !== false ? '已启用' : '已禁用'} />
                      </button>
                    ))}
                    <button className="provider-navigation-item provider-navigation-add" type="button" disabled={!serviceAvailable} onClick={() => void addApiProfile()}>
                      <Plus aria-hidden="true" size={17} />添加供应商
                    </button>
                    <div className="provider-navigation-label">本地模型</div>
                    <button className="provider-navigation-item" type="button" aria-current={providerPage === 'ollama' ? 'page' : undefined} onClick={() => setProviderPage('ollama')}>
                      <MonitorCog aria-hidden="true" size={17} /><span>Ollama</span>
                    </button>
                  </nav>
                  <div className="provider-detail" key={providerPage === 'api' ? selectedProfile?.id ?? 'empty' : 'ollama'}>
                {providerPage === 'api' && selectedProfile ? <>
                  <header className="provider-detail-heading">
                    <h4 className="provider-name-editor">
                      <span className="provider-name-field"><span className="provider-name-size" aria-hidden="true">{selectedProfile.name}</span><input ref={profileNameInput} className="provider-title-input" aria-label="API 配置名称" value={profileNameText} readOnly={!editingProfileName} maxLength={60}
                        onChange={(event) => setProfileNameText(event.currentTarget.value)}
                        onBlur={() => { if (editingProfileName) { void saveSelectedProfile(); setEditingProfileName(false) } }}
                        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setProfileNameText(selectedProfile.name); setEditingProfileName(false) } }}
                      /></span>
                      <button className="provider-model-action" type="button" aria-label="编辑 API 配置名称" disabled={!serviceAvailable} onClick={() => { setEditingProfileName(true); profileNameInput.current?.focus(); profileNameInput.current?.select() }}><Pencil size={16} aria-hidden="true" /></button>
                    </h4>
                    <button className="secondary-button" type="button" disabled={!serviceAvailable || providerToggleBusy} onClick={async () => {
                      setProviderToggleBusy(true)
                      try { await saveSelectedProfile({ enabled: !(settings.apiEnabled && selectedProfile.enabled !== false) }) }
                      finally { setProviderToggleBusy(false) }
                    }}>
                      {providerToggleBusy ? '保存中…' : settings.apiEnabled && selectedProfile.enabled !== false ? '禁用' : '启用'}
                    </button>
                    <button className="provider-delete-button" type="button" aria-label="删除 API 配置" disabled={!serviceAvailable} onClick={() => { setProfileError(''); setProfileAction('delete') }}><Trash2 size={17} aria-hidden="true" /></button>
                  </header>
                  {profileError ? <p className="model-config-error" role="alert">{profileError}</p> : null}
                  <div className="provider-field">
                    <div className="provider-field-heading">
                      <label htmlFor="provider-base-url">Base URL</label>
                      <div className="provider-field-actions">
                        {cloudLatency ? (
                          <span className={`latency-chip ${cloudLatency.ok
                            ? (cloudLatency.ms < 300 ? 'ok' : cloudLatency.ms < 1000 ? 'warn' : 'bad')
                            : 'bad'}`}>
                            {cloudLatency.ok ? `${cloudLatency.ms}ms` : '连接失败'}
                          </span>
                        ) : null}
                        <button className="secondary-button" type="button" disabled={testBusy || !serviceAvailable} onClick={() => void testApiProfile()}>
                          {testBusy ? <LoaderCircle className="running" aria-hidden="true" size={14} /> : null}
                          测试
                        </button>
                      </div>
                    </div>
                    <input
                      id="provider-base-url"
                      type="text"
                      value={providerBaseUrlText}
                      placeholder="https://..."
                      spellCheck={false}
                      disabled={!serviceAvailable}
                      onChange={(event) => setProviderBaseUrlText(event.currentTarget.value)}
                      onBlur={() => void saveSelectedProfile()}
                    />
                  </div>

                  <div className="provider-field">
                    <label htmlFor="provider-api-format">API 格式</label>
                    <select id="provider-api-format" className="provider-format" value="openai" disabled>
                      <option value="openai">OpenAI Chat Completions (/v1/chat/completions)</option>
                    </select>
                  </div>

                  <div className="provider-field">
                    <div className="provider-field-heading">
                      <span className="provider-field-label">API 密钥</span>
                      <span className="api-key-status"><KeyRound aria-hidden="true" size={13} />{selectedProfile.hasApiKey ? '已安全保存' : '未设置'}</span>
                    </div>
                    <div className="provider-field-actions">
                      <button className="secondary-button" type="button" disabled={!serviceAvailable} onClick={() => { setProfileError(''); setProfileAction('replace-key') }}>{selectedProfile.hasApiKey ? '更换密钥' : '设置密钥'}</button>
                      {selectedProfile.hasApiKey ? <button className="secondary-button" type="button" disabled={!serviceAvailable} onClick={() => { setProfileError(''); setProfileAction('clear-key') }}>清除密钥</button> : null}
                    </div>
                  </div>

                  <div className="provider-field">
                    <div className="provider-field-heading">
                      <span className="provider-field-label">模型列表</span>

                    </div>
                    <div className="provider-model-list">
                      {apiModels.map((model) => {
                        const configuration = existingModelConfiguration({ providerId: 'api:' + selectedProfile.id, modelId: model })
                        return <div className="provider-model-list-row" key={model}>
                          <div className="provider-model-value"><span className="provider-model-name">{model}</span><ModelBadges configuration={configuration} /></div>
                          <button className="provider-model-action" type="button" aria-label={'编辑模型 ' + model} disabled={!serviceAvailable} onClick={() => setModelConfigTarget({providerId: 'api:' + selectedProfile.id, modelId: model, modelIdEditable: true})}><Pencil size={16} aria-hidden="true" /></button>
                          <button className="provider-model-action" type="button" aria-label={'移除模型 ' + model} disabled={!serviceAvailable} onClick={() => {
                            const models = apiModels.filter((id) => id !== model)
                            void saveSelectedProfile({ models, model: selectedProfile.model === model ? models[0] ?? '' : selectedProfile.model })
                          }}><Trash2 size={16} aria-hidden="true" /></button>
                        </div>
                      })}
                      {apiModels.length === 0 ? <p className="provider-model-empty">暂无模型，获取模型或手动添加。</p> : null}
                    </div>
                    <button className="secondary-button provider-add-model" type="button" disabled={!serviceAvailable} onClick={() => setModelConfigTarget({ providerId: 'api:' + selectedProfile.id, modelId: '', modelIdEditable: true })}><Plus size={14} aria-hidden="true" />添加模型</button>
                  </div>
                </> : null}
                {providerPage === 'api' && !selectedProfile ? <div className="provider-empty-state"><Bot size={28} aria-hidden="true" /><h4>添加第一个 API 供应商</h4><p>配置 API 地址、密钥和模型后即可使用。</p><button className="secondary-button" type="button" disabled={!serviceAvailable} onClick={() => void addApiProfile()}><Plus size={14} aria-hidden="true" />添加供应商</button></div> : null}
                {providerPage === 'ollama' ? <>
                <div className="provider-section-heading">
                  <h4 className="settings-group-title">Ollama</h4>
                  <div className="provider-field-actions">
                    <button className="secondary-button" type="button" disabled={refreshBusy || !serviceAvailable} onClick={() => void refreshModels()}>
                      <RefreshCw className={refreshBusy ? 'running' : undefined} aria-hidden="true" size={14} />
                      获取模型
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <label htmlFor="ollama-enabled">
                    启用本地 Ollama
                    <small>关闭后对话不再使用本地模型</small>
                  </label>
                  <input
                    id="ollama-enabled"
                    className="settings-switch"
                    type="checkbox"
                    checked={settings.ollamaEnabled}
                    disabled={!serviceAvailable}
                    onChange={(event) => void onProviderChange({ ollamaEnabled: event.currentTarget.checked })}
                  />
                </div>
                <div className="provider-field">
                  <div className="cloud-model-row">
                    <span className="cloud-model-label">当前模型</span>
                    <ModelPicker
                      value={settings.selectedModel}
                      options={settings.models}
                      placeholder="未设置"
                      emptyHint="先获取模型"
                      disabled={!serviceAvailable}
                      onPick={(model) => void onModelChange(model)}
                    />
                    <button
                      type="button"
                      className="secondary-button model-config-edit"
                      disabled={settings.selectedModel.trim() === ''}
                      onClick={() => setModelConfigTarget({
                        providerId: 'ollama',
                        modelId: settings.selectedModel.trim(),
                        modelIdEditable: false,
                      })}
                    >
                      编辑模型配置
                    </button>
                  </div>
                </div>

                </> : null}
                  </div>
                </div>
                {profileAction && selectedProfile ? <ApiProfileDialog key={selectedProfile.id + profileAction} action={profileAction} name={selectedProfile.name} error={profileError} onCancel={() => setProfileAction(null)} onConfirm={async (apiKey) => {
                  if (profileAction === 'delete') return (await deleteSelectedProfile()) === true
                  return (await saveSelectedProfile(profileAction === 'replace-key' ? { apiKey } : { clearApiKey: true })) !== null
                }} /> : null}
                {modelConfigTarget !== null && (
                  <ModelConfigurationDialog
                    open
                    providerId={modelConfigTarget.providerId}
                    modelId={modelConfigTarget.modelId}
                    modelIdEditable={modelConfigTarget.modelIdEditable}
                    existing={existingModelConfiguration({
                      providerId: modelConfigTarget.providerId,
                      modelId: modelConfigTarget.modelId,
                    })}
                    onFetchModels={modelConfigTarget.providerId.startsWith('api:') ? () => onFetchCloudModels(modelConfigTarget.providerId.slice(4)) : undefined}
                    onCancel={() => setModelConfigTarget(null)}
                    onSubmit={(draft) => { void applyModelConfigDraft(draft).catch((error) => onNotice(error instanceof Error ? error.message : '保存模型配置失败')) }}
                  />
                )}

              </>
            ) : null}

            {activePage === 'tools' ? (
              <>
                <div className="settings-row tool-readonly-row">
                  <label htmlFor="tools-readonly">
                    只读模式
                    <small>停用选中、显隐和视点切换</small>
                  </label>
                  <input
                    id="tools-readonly"
                    className="settings-switch"
                    type="checkbox"
                    checked={readOnlyMode}
                    onChange={(event) => {
                      const next = { ...(settings.toolPermissions ?? {}) }
                      for (const tool of tools) {
                        if (tool.impact !== 'view-state-change') continue
                        if (event.currentTarget.checked) next[tool.name] = 'deny'
                        else delete next[tool.name]
                      }
                      const viewStateNames = tools
                        .filter((tool) => tool.impact === 'view-state-change')
                        .map((tool) => tool.name as ToolName)
                      void onDisabledToolsChange(
                        event.currentTarget.checked
                          ? [...new Set([...disabledTools, ...viewStateNames])]
                          : disabledTools.filter((name) => !viewStateNames.includes(name)),
                      )
                      void onBulkToolPermissions(next)
                    }}
                  />
                </div>
                <div className="tool-list">
                  {tools.map((tool) => {
                    const inputId = `tool-permission-${tool.name}`
                    return (
                      <div className="tool-row" key={tool.name}>
                        <label htmlFor={inputId}>
                          <strong>{tool.label}</strong>
                          <small>{tool.description}{tool.impact === 'view-state-change' ? ' · 会改动画面' : ''}</small>
                        </label>
                        <select
                          id={inputId}
                          className="tool-permission-select"
                          value={tool.permission}
                          disabled={!serviceAvailable}
                          onChange={(event) => changeToolPermission(
                            tool.name as ToolName,
                            event.currentTarget.value as ToolPermission,
                          )}
                        >
                          <option value="allow">允许</option>
                          <option value="ask">每次询问</option>
                          <option value="deny">禁止</option>
                        </select>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : null}


            {activePage === 'runtime' ? (
              <dl className="diagnostic-list">
                <div><dt>桌面服务</dt><dd>{serviceAvailable ? '已连接' : '未连接'}</dd></div>
                {diagnostics?.dataDirectory ? <div><dt>数据目录</dt><dd data-tip={diagnostics.dataDirectory}>{diagnostics.dataDirectory}</dd></div> : null}
                {diagnostics?.runtime ? <div><dt>运行时</dt><dd>{diagnostics.runtime}</dd></div> : null}
              </dl>
            ) : null}
    </section>
  )
}
