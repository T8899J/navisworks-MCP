import {
  Bot,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  LoaderCircle,
  MonitorCog,
  Palette,
  RefreshCw,
  Settings2,
  Wrench,
  X,
  Zap
} from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState
} from 'react'
import type { ThemeMode, ToolName } from '../shared/ipc'
import type { DesktopSettings, NavisworksStatus } from './chatTypes'

export interface RuntimeDiagnostics {
  dataDirectory?: string
  runtime?: string
}

/** Renderer-local mirror of the main-process catalog, for the settings UI. */
const TOOL_CATALOG_UI = [
  { name: 'navisworks_status', description: '检查插件连接与当前文档', viewState: false },
  { name: 'navisworks_get_document', description: '读取文档、单位和选择数量', viewState: false },
  { name: 'navisworks_get_selection', description: '读取当前选中的构件', viewState: false },
  { name: 'navisworks_find_items', description: '按名称或属性搜索构件', viewState: false },
  { name: 'navisworks_get_item_properties', description: '读取构件属性', viewState: false },
  { name: 'navisworks_select_items', description: '选中或取消选中构件', viewState: true },
  { name: 'navisworks_set_visibility', description: '隐藏、显示或隔离构件', viewState: true },
  { name: 'navisworks_list_viewpoints', description: '列出保存的视点', viewState: false },
  { name: 'navisworks_activate_viewpoint', description: '切换到保存的视点', viewState: true }
] as const

const VIEW_STATE_TOOL_NAMES: readonly ToolName[] = TOOL_CATALOG_UI
  .filter((tool) => tool.viewState)
  .map((tool) => tool.name)

/** Discrete font-size levels; the slider snaps to these so the active
 *  step is always visible. */
const FONT_LEVELS = [
  { value: 0.9, label: '小' },
  { value: 0.95, label: '较小' },
  { value: 1, label: '默认' },
  { value: 1.15, label: '较大' },
  { value: 1.3, label: '大' }
] as const

interface SettingsPanelProps {
  open: boolean
  settings: DesktopSettings
  themeMode: ThemeMode
  navisworks: NavisworksStatus
  serviceAvailable: boolean
  diagnostics?: RuntimeDiagnostics
  onClose(): void
  onThemeModeChange(mode: ThemeMode): void | Promise<void>
  onFontScaleChange(scale: number): void | Promise<void>
  onProviderChange(patch: {
    providerEnabled?: boolean
    providerBaseUrl?: string
    providerApiKey?: string
  }): void | Promise<void>
  onModelChange(model: string): void | Promise<void>
  onReasoningChange(mode: 'fast' | 'deep'): void | Promise<void>
  onDisabledToolsChange(disabledTools: ToolName[]): void | Promise<void>
  onRefreshModels(): void | Promise<void>
  onTestOllama(): boolean | string | void | Promise<boolean | string | void>
  onRefreshNavisworks(): void | Promise<void>
}

type SettingsPageId = 'appearance' | 'model' | 'tools' | 'runtime' | 'navisworks'

const SETTINGS_PAGES: Array<{
  id: SettingsPageId
  label: string
  icon: typeof Palette
}> = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'model', label: '模型', icon: Bot },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'runtime', label: '运行信息', icon: Database },
  { id: 'navisworks', label: 'Navisworks', icon: CheckCircle2 }
]

export function SettingsPanel({
  open,
  settings,
  themeMode,
  navisworks,
  serviceAvailable,
  diagnostics,
  onClose,
  onThemeModeChange,
  onFontScaleChange,
  onProviderChange,
  onModelChange,
  onReasoningChange,
  onDisabledToolsChange,
  onRefreshModels,
  onTestOllama,
  onRefreshNavisworks
}: SettingsPanelProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const [modelBusy, setModelBusy] = useState(false)
  const [navisworksBusy, setNavisworksBusy] = useState(false)
  const [ollamaResult, setOllamaResult] = useState<string>()
  // Last-viewed page survives close/reopen within the session.
  const [activePage, setActivePage] = useState<SettingsPageId>('appearance')
  // Provider connection inputs keep local text state (cherry-studio style
  // blur-commit) and re-sync when the saved settings change underneath.
  // Hooks stay above the `if (!open)` early return — React forbids reordering.
  const [providerBaseUrlText, setProviderBaseUrlText] = useState(settings.providerBaseUrl)
  const [providerApiKeyText, setProviderApiKeyText] = useState(settings.providerApiKey)
  const [showApiKey, setShowApiKey] = useState(false)
  useEffect(() => {
    setProviderBaseUrlText(settings.providerBaseUrl)
  }, [settings.providerBaseUrl])
  useEffect(() => {
    setProviderApiKeyText(settings.providerApiKey)
  }, [settings.providerApiKey])

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.cancelAnimationFrame(frame)
      document.body.style.overflow = previousOverflow
      restoreFocusRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )
    if (!focusable?.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  const refreshModels = async () => {
    setModelBusy(true)
    setOllamaResult(undefined)
    try {
      await onRefreshModels()
    } finally {
      setModelBusy(false)
    }
  }

  const testOllama = async () => {
    setModelBusy(true)
    setOllamaResult(undefined)
    try {
      const result = await onTestOllama()
      setOllamaResult(typeof result === 'string' ? result : result === false ? '连接失败' : '连接正常')
    } catch (error) {
      setOllamaResult(error instanceof Error ? error.message : '连接失败')
    } finally {
      setModelBusy(false)
    }
  }

  const refreshNavisworks = async () => {
    setNavisworksBusy(true)
    try {
      await onRefreshNavisworks()
    } finally {
      setNavisworksBusy(false)
    }
  }

  // Provider fields commit on blur (cherry-studio pattern) so typing an
  // address or key never fires a request per keystroke.
  const commitProviderBaseUrl = () => {
    const next = providerBaseUrlText.trim()
    if (next === settings.providerBaseUrl) return
    void onProviderChange({ providerBaseUrl: next })
  }

  const commitProviderApiKey = () => {
    if (providerApiKeyText === settings.providerApiKey) return
    void onProviderChange({ providerApiKey: providerApiKeyText })
  }

  const disabledTools = settings.disabledTools ?? []
  const readOnlyMode = VIEW_STATE_TOOL_NAMES.every((name) => disabledTools.includes(name))
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

  const setToolEnabled = (name: ToolName, enabled: boolean) => {
    const next = enabled
      ? disabledTools.filter((item) => item !== name)
      : [...new Set([...disabledTools, name])]
    void onDisabledToolsChange(next)
  }

  // Read-only mode is derived state: checked means every view-state tool is
  // off. Turning it off re-enables exactly those tools and leaves the six
  // read-only switches untouched.
  const toggleReadOnlyMode = (enabled: boolean) => {
    const next = enabled
      ? [...new Set([...disabledTools, ...VIEW_STATE_TOOL_NAMES])]
      : disabledTools.filter((name) => !VIEW_STATE_TOOL_NAMES.includes(name))
    void onDisabledToolsChange(next)
  }

  return (
    <div className="settings-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapFocus}>
        <header className="settings-header">
          <div className="settings-title-copy">
            <span className="settings-title-icon" aria-hidden="true"><Settings2 size={18} /></span>
            <h2 id={titleId}>设置</h2>
          </div>
          <button ref={closeRef} className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div className="settings-content">
          <nav className="settings-nav" aria-label="设置分类">
            {SETTINGS_PAGES.map((page) => {
              const NavIcon = page.icon
              const active = activePage === page.id
              return (
                <button
                  key={page.id}
                  type="button"
                  className="settings-nav-item"
                  data-active={active}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setActivePage(page.id)}>
                  <NavIcon aria-hidden="true" size={16} />
                  <span>{page.label}</span>
                </button>
              )
            })}
          </nav>
          <div className="settings-page" role="region" aria-label={activePageMeta.label}>
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
                  <div className="font-scale-ticks" aria-hidden="true">
                    {FONT_LEVELS.map((level, index) => (
                      <span
                        key={level.label}
                        data-active={index === fontLevelIndex}
                        style={{ left: `${index * (100 / (FONT_LEVELS.length - 1))}%` }}
                      />
                    ))}
                  </div>
                  <div className="font-scale-slider-labels" aria-hidden="true">
                    {FONT_LEVELS.map((level, index) => (
                      <span key={level.label} data-active={index === fontLevelIndex}>{level.label}</span>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {activePage === 'model' ? (
              <>
                <div className="provider-header">
                  <div className="provider-title">
                    <span className="provider-icon" aria-hidden="true"><Zap size={15} /></span>
                    <strong>Ollama</strong>
                  </div>
                  <label className="provider-toggle" htmlFor="provider-enabled">
                    启用
                    <input
                      id="provider-enabled"
                      className="settings-switch"
                      type="checkbox"
                      checked={settings.providerEnabled}
                      disabled={!serviceAvailable}
                      onChange={(event) => void onProviderChange({ providerEnabled: event.currentTarget.checked })}
                    />
                  </label>
                </div>

                <div className="provider-field">
                  <label htmlFor="provider-api-key">
                    API 密钥
                    <small>本地 Ollama 可留空；用于云端或代理端点</small>
                  </label>
                  <div className="provider-input-group">
                    <input
                      id="provider-api-key"
                      type={showApiKey ? 'text' : 'password'}
                      value={providerApiKeyText}
                      placeholder="可选"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!serviceAvailable}
                      onChange={(event) => setProviderApiKeyText(event.currentTarget.value)}
                      onBlur={commitProviderApiKey}
                    />
                    <button
                      type="button"
                      className="provider-eye"
                      aria-label={showApiKey ? '隐藏密钥' : '显示密钥'}
                      onClick={() => setShowApiKey((current) => !current)}>
                      {showApiKey ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
                    </button>
                  </div>
                </div>

                <div className="provider-field">
                  <label htmlFor="provider-base-url">
                    API 地址
                    <small>留空使用默认地址</small>
                  </label>
                  <input
                    id="provider-base-url"
                    className="provider-input-mono"
                    type="text"
                    value={providerBaseUrlText}
                    placeholder="http://localhost:11434"
                    spellCheck={false}
                    disabled={!serviceAvailable}
                    onChange={(event) => setProviderBaseUrlText(event.currentTarget.value)}
                    onBlur={commitProviderBaseUrl}
                  />
                </div>

                <div className="provider-connection">
                  <span className="status-copy">
                    <strong>连通性</strong>
                    <small>{ollamaResult ?? (settings.providerEnabled ? '尚未测试' : '提供商已停用')}</small>
                  </span>
                  <button className="secondary-button" type="button" disabled={modelBusy || !serviceAvailable} onClick={() => void testOllama()}>
                    {modelBusy ? <LoaderCircle className="running" aria-hidden="true" size={14} /> : null}
                    测试
                  </button>
                </div>

                <div className="provider-section-heading">
                  <h4 className="settings-group-title">模型列表</h4>
                  <button className="secondary-button" type="button" disabled={modelBusy || !serviceAvailable} onClick={() => void refreshModels()}>
                    <RefreshCw className={modelBusy ? 'running' : undefined} aria-hidden="true" size={14} />
                    刷新
                  </button>
                </div>
                <div className="model-list">
                  {settings.models.map((model) => {
                    const isDefault = model === settings.selectedModel
                    return (
                      <div className="model-item" key={model} data-default={isDefault}>
                        <span className="model-item-name">{model}</span>
                        {isDefault ? (
                          <span className="model-default-badge">默认</span>
                        ) : (
                          <button
                            type="button"
                            className="model-set-default"
                            disabled={!serviceAvailable}
                            onClick={() => void onModelChange(model)}>
                            设为默认
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>

                <h4 className="settings-group-title">生成设置</h4>
                <div className="settings-row">
                  <label htmlFor="settings-reasoning">推理模式</label>
                  <select
                    id="settings-reasoning"
                    value={settings.reasoningMode}
                    disabled={!serviceAvailable}
                    onChange={(event) => void onReasoningChange(event.currentTarget.value === 'deep' ? 'deep' : 'fast')}>
                    <option value="fast">快速</option>
                    <option value="deep">深度</option>
                  </select>
                </div>
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
                    onChange={(event) => toggleReadOnlyMode(event.currentTarget.checked)}
                  />
                </div>
                <div className="tool-list">
                  {TOOL_CATALOG_UI.map((tool) => {
                    const inputId = `tool-switch-${tool.name}`
                    return (
                      <div className="tool-row" key={tool.name}>
                        <label htmlFor={inputId}>
                          <strong>{tool.name}</strong>
                          <small>{tool.description}{tool.viewState ? ' · 会改动画面' : ''}</small>
                        </label>
                        <input
                          id={inputId}
                          className="settings-switch"
                          type="checkbox"
                          checked={!disabledTools.includes(tool.name)}
                          onChange={(event) => setToolEnabled(tool.name, event.currentTarget.checked)}
                        />
                      </div>
                    )
                  })}
                </div>
              </>
            ) : null}

            {activePage === 'runtime' ? (
              <dl className="diagnostic-list">
                <div><dt>桌面服务</dt><dd>{serviceAvailable ? '已连接' : '未连接'}</dd></div>
                {diagnostics?.dataDirectory ? <div><dt>数据目录</dt><dd title={diagnostics.dataDirectory}>{diagnostics.dataDirectory}</dd></div> : null}
                {diagnostics?.runtime ? <div><dt>运行时</dt><dd>{diagnostics.runtime}</dd></div> : null}
              </dl>
            ) : null}

            {activePage === 'navisworks' ? (
              <div className="connection-card" data-connected={navisworks.connected}>
                <span className="status-dot" aria-hidden="true" />
                <div><strong>{navisworks.connected ? '已连接' : '未连接'}</strong><small>{navisworks.documentName || navisworks.status}</small></div>
                <button className="secondary-button" type="button" disabled={navisworksBusy || !serviceAvailable} onClick={() => void refreshNavisworks()}>
                  <RefreshCw className={navisworksBusy ? 'running' : undefined} aria-hidden="true" size={14} />
                  刷新
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
