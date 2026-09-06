import {
  Bot,
  Check,
  ChevronDown,
  Database,
  Gauge,
  KeyRound,
  LoaderCircle,
  MonitorCog,
  Palette,
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
import type { ExecutionSettings, ThemeMode, ToolName } from '../shared/ipc'
import type { DesktopSettings } from './chatTypes'

export interface RuntimeDiagnostics {
  dataDirectory?: string
  runtime?: string
}

/**
 * Dropdown model picker styled like the composer's model menu. The trigger
 * shows the current value; 获取模型 feeds the option list, picking one fills
 * the row's read-only display.
 */
function ModelPicker({
  value,
  options,
  placeholder,
  emptyHint,
  disabled,
  onPick
}: {
  value: string
  options: readonly string[]
  placeholder: string
  emptyHint: string
  disabled?: boolean
  onPick(model: string): void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}>
        <span className="model-picker-value">{value.trim() || placeholder}</span>
        <ChevronDown aria-hidden="true" size={13} className={open ? 'flipped' : undefined} />
      </button>
      {open ? (
        <div className="model-picker-list" role="listbox">
          {options.length === 0 ? (
            <div className="model-picker-empty">{emptyHint}</div>
          ) : (
            options.map((model) => (
              <button
                key={model}
                type="button"
                role="option"
                aria-selected={model === value}
                className={`model-picker-option${model === value ? ' selected' : ''}`}
                onClick={() => {
                  setOpen(false)
                  if (model !== value) onPick(model)
                }}>
                <span className="model-picker-option-name">{model}</span>
                {model === value ? <Check aria-hidden="true" size={13} /> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Renderer-local mirror of the main-process catalog, for the settings UI. */
const TOOL_CATALOG_UI = [
  { name: 'navisworks_status', description: '检查插件连接与当前文档', viewState: false },
  { name: 'navisworks_get_document', description: '读取文档、单位和选择数量', viewState: false },
  { name: 'navisworks_get_selection', description: '读取当前选中的构件', viewState: false },
  { name: 'navisworks_find_items', description: '搜索构件（大模型分段续扫）', viewState: false },
  { name: 'navisworks_get_item_properties', description: '读取构件属性', viewState: false },
  { name: 'navisworks_select_items', description: '选中或取消选中构件', viewState: true },
  { name: 'navisworks_set_visibility', description: '隐藏、显示或隔离构件', viewState: true },
  { name: 'navisworks_list_viewpoints', description: '列出保存的视点（可分页）', viewState: false },
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
    apiKey?: string
    clearApiKey?: boolean
  }): Promise<DesktopSettings>
  onDeleteApiProfile(profileId: string): Promise<DesktopSettings>
  onModelChange(model: string): void | Promise<void>
  onDisabledToolsChange(disabledTools: ToolName[]): void | Promise<void>
  /** Persist a patch of the run-scoped execution policy (执行页). */
  onExecutionSettingsChange(execution: ExecutionSettings): void | Promise<void>
  onRefreshModels(): void | Promise<void>
  /** Lists models from the given OpenAI-compatible endpoint (cloud fetch). */
  onFetchCloudModels(profileId: string): Promise<string[]>
  /** Result of the last connectivity test: round-trip ms; ok=false on failure. */
  cloudLatency?: { ok: boolean; ms: number } | null
  onNotice(message: string): void
  onTestApiProfile(profileId: string): Promise<{ connected: boolean; message: string }>
}

/** Execution-page number input: commit on blur/Enter, bounded by the schema. */
function NumberField({
  id,
  value,
  fallback,
  min,
  max,
  disabled,
  onCommit
}: {
  id: string
  value: number | null
  fallback: number
  min: number
  max: number
  disabled?: boolean
  onCommit(value: number | null): void
}) {
  const [text, setText] = useState(value === null ? '' : String(value))
  useEffect(() => {
    setText(value === null ? '' : String(value))
  }, [value])
  const commit = () => {
    const parsed = Number(text)
    if (text.trim() === '' || !Number.isFinite(parsed)) {
      onCommit(null)
      return
    }
    onCommit(Math.min(max, Math.max(min, Math.trunc(parsed))))
  }
  return (
    <input
      id={id}
      className="execution-number-input"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={text}
      placeholder={String(fallback)}
      disabled={disabled}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
      }}
    />
  )
}

/** Auto / fixed segmented choice for the history and tool-result policies. */
function ModeField({
  id,
  value,
  onChange
}: {
  id: string
  value: 'auto' | 'fixed'
  onChange(value: 'auto' | 'fixed'): void
}) {
  return (
    <fieldset className="theme-choice execution-mode-choice" id={id}>
      {([
        ['auto', 'Auto', '按上下文预算自动决定'],
        ['fixed', '固定', '使用下方固定值']
      ] as const).map(([mode, label, hint]) => (
        <label className="theme-option" data-selected={value === mode} key={mode}>
          <input
            type="radio"
            name={id}
            value={mode}
            checked={value === mode}
            onChange={() => onChange(mode)}
          />
          <span><strong>{label}</strong><small>{hint}</small></span>
        </label>
      ))}
    </fieldset>
  )
}

export type SettingsPageId = 'appearance' | 'model' | 'tools' | 'execution' | 'runtime'


export const SETTINGS_PAGES: Array<{
  id: SettingsPageId
  label: string
  icon: typeof Palette
}> = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'model', label: '模型', icon: Bot },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'execution', label: '执行', icon: Gauge },
  { id: 'runtime', label: '运行信息', icon: Database }
]

/**
 * 执行页: the run-scoped agent execution policy. Everything applies on the
 * NEXT message — no restart — because chat.start passes the fresh settings
 * into the runtime every run. Advanced planner/verifier numbers live in a
 * collapsed 高级 area.
 */
function ExecutionPage({
  execution,
  disabled,
  onChange
}: {
  execution: ExecutionSettings
  disabled: boolean
  onChange(patch: Partial<ExecutionSettings>): void
}) {
  return (
    <>
      <div className="settings-row">
        <label htmlFor="execution-max-tool-rounds">
          最大工具轮数
          <small>单次对话中模型连续调用工具的上限（1–64）</small>
        </label>
        <NumberField
          id="execution-max-tool-rounds"
          value={execution.maxToolRounds}
          fallback={8}
          min={1}
          max={64}
          disabled={disabled}
          onCommit={(value) => onChange({ maxToolRounds: value ?? 8 })}
        />
      </div>

      <h4 className="settings-group-title">上下文压缩</h4>
      <div className="settings-row">
        <label htmlFor="execution-compaction-enabled">
          自动压缩
          <small>接近上下文窗口时自动总结早期对话</small>
        </label>
        <input
          id="execution-compaction-enabled"
          className="settings-switch"
          type="checkbox"
          checked={execution.compactionEnabled}
          disabled={disabled}
          onChange={(event) => onChange({ compactionEnabled: event.currentTarget.checked })}
        />
      </div>
      <div className="settings-row">
        <label htmlFor="execution-compaction-ratio">
          压缩触发阈值
          <small>上下文占用达到窗口比例后触发（0.5–0.98）</small>
        </label>
        <NumberField
          id="execution-compaction-ratio"
          value={Math.round(execution.compactionTriggerRatio * 100)}
          fallback={85}
          min={50}
          max={98}
          disabled={disabled || !execution.compactionEnabled}
          onCommit={(value) => onChange({ compactionTriggerRatio: (value ?? 85) / 100 })}
        />
      </div>
      <div className="settings-row">
        <label htmlFor="execution-compact-keep">
          压缩保留最近帧
          <small>压缩时保留最近几轮完整对话（0–20）</small>
        </label>
        <NumberField
          id="execution-compact-keep"
          value={execution.compactKeepRecentFrames}
          fallback={1}
          min={0}
          max={20}
          disabled={disabled || !execution.compactionEnabled}
          onCommit={(value) => onChange({ compactKeepRecentFrames: value ?? 1 })}
        />
      </div>

      <h4 className="settings-group-title">模型上下文</h4>
      <div className="settings-row tool-row">
        <label htmlFor="execution-history-mode">
          历史上下文策略
          <small>Auto 将完整历史交给按 Token 预算裁剪</small>
        </label>
        <ModeField
          id="execution-history-mode"
          value={execution.historyMode}
          onChange={(historyMode) => onChange({ historyMode })}
        />
      </div>
      {execution.historyMode === 'fixed' ? (
        <div className="settings-row">
          <label htmlFor="execution-history-limit">
            历史消息条数
            <small>固定模式下进入上下文的最大消息数（4–1000）</small>
          </label>
          <NumberField
            id="execution-history-limit"
            value={execution.historyMessageLimit}
            fallback={24}
            min={4}
            max={1000}
            disabled={disabled}
            onCommit={(value) => onChange({ historyMessageLimit: value ?? 24 })}
          />
        </div>
      ) : null}
      <div className="settings-row tool-row">
        <label htmlFor="execution-tool-result-mode">
          工具结果上下文
          <small>Auto 按剩余上下文预算动态放大工具结果</small>
        </label>
        <ModeField
          id="execution-tool-result-mode"
          value={execution.toolResultMode}
          onChange={(toolResultMode) => onChange({ toolResultMode })}
        />
      </div>
      {execution.toolResultMode === 'fixed' ? (
        <div className="settings-row">
          <label htmlFor="execution-tool-result-chars">
            工具结果字符上限
            <small>固定模式下每个工具结果注入的字符数（500–200000）</small>
          </label>
          <NumberField
            id="execution-tool-result-chars"
            value={execution.toolResultMaxChars}
            fallback={4000}
            min={500}
            max={200000}
            disabled={disabled}
            onCommit={(value) => onChange({ toolResultMaxChars: value ?? 4000 })}
          />
        </div>
      ) : null}

      <details className="execution-advanced">
        <summary>高级</summary>
        <div className="settings-row">
          <label htmlFor="execution-planner-attempts">
            Planner 最大尝试
            <small>任务规划结构化输出的尝试次数（1–5）</small>
          </label>
          <NumberField
            id="execution-planner-attempts"
            value={execution.plannerMaxAttempts}
            fallback={2}
            min={1}
            max={5}
            disabled={disabled}
            onCommit={(value) => onChange({ plannerMaxAttempts: value ?? 2 })}
          />
        </div>
        <div className="settings-row">
          <label htmlFor="execution-planner-steps">
            Planner 最大步骤
            <small>单个任务计划包含的步骤上限（1–32）</small>
          </label>
          <NumberField
            id="execution-planner-steps"
            value={execution.plannerMaxSteps}
            fallback={10}
            min={1}
            max={32}
            disabled={disabled}
            onCommit={(value) => onChange({ plannerMaxSteps: value ?? 10 })}
          />
        </div>
        <div className="settings-row">
          <label htmlFor="execution-planner-tokens">
            Planner 输出上限
            <small>留空 = Auto（不发送输出限制）</small>
          </label>
          <NumberField
            id="execution-planner-tokens"
            value={execution.plannerMaxTokens}
            fallback={2048}
            min={256}
            max={200000}
            disabled={disabled}
            onCommit={(value) => onChange({ plannerMaxTokens: value ?? 2048 })}
          />
        </div>
        <div className="settings-row">
          <label htmlFor="execution-verifier-attempts">
            Verifier 最大尝试
            <small>完成度验证结构化输出的尝试次数（1–5）</small>
          </label>
          <NumberField
            id="execution-verifier-attempts"
            value={execution.verifierMaxAttempts}
            fallback={2}
            min={1}
            max={5}
            disabled={disabled}
            onCommit={(value) => onChange({ verifierMaxAttempts: value ?? 2 })}
          />
        </div>
        <div className="settings-row">
          <label htmlFor="execution-verifier-evidence">
            Verifier 最大 Evidence
            <small>验证时展示的证据摘要条数（2–50）</small>
          </label>
          <NumberField
            id="execution-verifier-evidence"
            value={execution.verifierMaxEvidence}
            fallback={12}
            min={2}
            max={50}
            disabled={disabled}
            onCommit={(value) => onChange({ verifierMaxEvidence: value ?? 12 })}
          />
        </div>
        <div className="settings-row">
          <label htmlFor="execution-max-replans">
            最大 Replan 次数
            <small>超出后任务转为阻塞（0–16）</small>
          </label>
          <NumberField
            id="execution-max-replans"
            value={execution.maxTaskReplans}
            fallback={2}
            min={0}
            max={16}
            disabled={disabled}
            onCommit={(value) => onChange({ maxTaskReplans: value ?? 2 })}
          />
        </div>
        <div className="settings-row">
          <label htmlFor="execution-compact-transcript">
            压缩输入字符上限
            <small>送入压缩器的对话文本上限（2000–200000）</small>
          </label>
          <NumberField
            id="execution-compact-transcript"
            value={execution.compactMaxTranscriptChars}
            fallback={30000}
            min={2000}
            max={200000}
            disabled={disabled || !execution.compactionEnabled}
            onCommit={(value) => onChange({ compactMaxTranscriptChars: value ?? 30000 })}
          />
        </div>
      </details>
    </>
  )
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
  onDisabledToolsChange,
  onExecutionSettingsChange,
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
  const [cloudModelsBusy, setCloudModelsBusy] = useState(false)
  const [cloudModels, setCloudModels] = useState<string[]>([])
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
  const [providerApiKeyText, setProviderApiKeyText] = useState('')
  const [editingApiKey, setEditingApiKey] = useState(false)
  const [pendingProfileDelete, setPendingProfileDelete] = useState(false)
  useEffect(() => {
    if (!selectedProfile) {
      setSelectedProfileId(settings.apiProfiles[0]?.id ?? null)
      return
    }
    setSelectedProfileId(selectedProfile.id)
    setProfileNameText(selectedProfile.name)
    setProviderBaseUrlText(selectedProfile.baseUrl)
    setCloudModelText(selectedProfile.model)
    setProviderApiKeyText('')
    setEditingApiKey(false)
    setPendingProfileDelete(false)
    setCloudModels([])
  }, [selectedProfile?.id, selectedProfile?.name, selectedProfile?.baseUrl, selectedProfile?.model])

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

  const saveSelectedProfile = async (extra: { apiKey?: string; clearApiKey?: boolean } = {}) => {
    if (!selectedProfile) return null
    try {
      return await onSaveApiProfile({
        id: selectedProfile.id,
        name: profileNameText.trim() || selectedProfile.name,
        baseUrl: providerBaseUrlText.trim(),
        model: cloudModelText.trim(),
        ...extra
      })
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '保存 API 配置失败')
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
      if (created) setSelectedProfileId(created.id)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '新建 API 配置失败')
    }
  }

  const deleteSelectedProfile = async () => {
    if (!selectedProfile) return
    try {
      const saved = await onDeleteApiProfile(selectedProfile.id)
      setSelectedProfileId(saved.activeApiProfileId ?? saved.apiProfiles[0]?.id ?? null)
      setPendingProfileDelete(false)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '删除 API 配置失败')
    }
  }

  // Fetches the endpoint's model list into the picker; an empty 模型选择
  // field is auto-filled with the first model.
  const fetchCloudModels = async () => {
    if (!selectedProfile) {
      onNotice('请先新建 API 配置')
      return
    }
    const saved = await saveSelectedProfile()
    if (!saved) return
    try {
      setCloudModelsBusy(true)
      const models = await onFetchCloudModels(selectedProfile.id)
      setCloudModels(models)
      if (models.length === 0) {
        onNotice('端点未返回任何模型')
        return
      }
      if (!cloudModelText.trim()) {
        const first = models[0] ?? ''
        setCloudModelText(first)
        await onSaveApiProfile({
          id: selectedProfile.id,
          name: profileNameText.trim() || selectedProfile.name,
          baseUrl: providerBaseUrlText.trim(),
          model: first
        })
        onNotice(`已默认使用 ${first}（端点共 ${models.length} 个模型）`)
      } else {
        onNotice(`已获取 ${models.length} 个模型，可在列表中切换`)
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '获取云端模型失败')
    } finally {
      setCloudModelsBusy(false)
    }
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
    <section
      className="settings-page"
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
                <div className="provider-section-heading">
                  <h4 className="settings-group-title">API 配置</h4>
                  <button className="secondary-button" type="button" disabled={!serviceAvailable} onClick={() => void addApiProfile()}>
                    <Plus aria-hidden="true" size={14} />
                    新建
                  </button>
                </div>
                <div className="settings-row">
                  <label htmlFor="api-enabled">
                    启用 API
                    <small>关闭后对话不再使用 API 配置</small>
                  </label>
                  <input
                    id="api-enabled"
                    className="settings-switch"
                    type="checkbox"
                    checked={settings.apiEnabled}
                    disabled={!serviceAvailable}
                    onChange={(event) => void onProviderChange({ apiEnabled: event.currentTarget.checked })}
                  />
                </div>
                <div className="api-profile-tabs" role="listbox" aria-label="API 配置">
                  {settings.apiProfiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      role="option"
                      aria-selected={profile.id === selectedProfile?.id}
                      data-selected={profile.id === selectedProfile?.id}
                      onClick={() => setSelectedProfileId(profile.id)}>
                      {profile.name}
                    </button>
                  ))}
                  {settings.apiProfiles.length === 0 ? <span>还没有 API 配置</span> : null}
                </div>

                {selectedProfile ? <>
                  <div className="provider-field">
                    <label htmlFor="provider-name">配置名称</label>
                    <input
                      id="provider-name"
                      type="text"
                      value={profileNameText}
                      disabled={!serviceAvailable}
                      onChange={(event) => setProfileNameText(event.currentTarget.value)}
                      onBlur={() => void saveSelectedProfile()}
                    />
                  </div>
                  <div className="provider-field">
                    <div className="provider-field-heading">
                      <label htmlFor="provider-base-url">API 地址</label>
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
                    <div className="provider-field-heading">
                      <span className="provider-field-label">API 密钥</span>
                      <span className="api-key-status"><KeyRound aria-hidden="true" size={13} />{selectedProfile.hasApiKey ? '已安全保存' : '未设置'}</span>
                    </div>
                    {editingApiKey ? (
                      <div className="provider-input-group api-key-editor">
                        <input
                          id="provider-api-key"
                          type="password"
                          value={providerApiKeyText}
                          placeholder="输入新密钥"
                          autoComplete="new-password"
                          spellCheck={false}
                          disabled={!serviceAvailable}
                          onChange={(event) => setProviderApiKeyText(event.currentTarget.value)}
                        />
                        <button className="secondary-button" type="button" disabled={!providerApiKeyText || !serviceAvailable} onClick={async () => {
                          const saved = await saveSelectedProfile({ apiKey: providerApiKeyText })
                          if (saved) {
                            setProviderApiKeyText('')
                            setEditingApiKey(false)
                          }
                        }}>保存密钥</button>
                      </div>
                    ) : (
                      <div className="provider-field-actions">
                        <button className="secondary-button" type="button" onClick={() => setEditingApiKey(true)}>
                          {selectedProfile.hasApiKey ? '更换密钥' : '设置密钥'}
                        </button>
                        {selectedProfile.hasApiKey ? (
                          <button className="secondary-button" type="button" onClick={() => void saveSelectedProfile({ clearApiKey: true })}>清除密钥</button>
                        ) : null}
                      </div>
                    )}
                  </div>

                  <div className="provider-field">
                    <div className="provider-field-heading">
                      <span className="provider-field-label">模型选择</span>
                      <button className="secondary-button" type="button" disabled={cloudModelsBusy || !serviceAvailable} onClick={() => void fetchCloudModels()}>
                        {cloudModelsBusy ? <LoaderCircle className="running" aria-hidden="true" size={14} /> : <RefreshCw aria-hidden="true" size={14} />}
                        获取模型
                      </button>
                    </div>
                    <div className="cloud-model-row">
                      <span className="cloud-model-label">当前模型</span>
                      <span className="model-display" title={cloudModelText}>{cloudModelText || '未设置'}</span>
                      <ModelPicker
                        value={cloudModelText}
                        options={cloudModels}
                        placeholder="未设置"
                        emptyHint="先获取模型"
                        disabled={!serviceAvailable}
                        onPick={(model) => {
                          setCloudModelText(model)
                          void onSaveApiProfile({
                            id: selectedProfile.id,
                            name: profileNameText.trim() || selectedProfile.name,
                            baseUrl: providerBaseUrlText.trim(),
                            model
                          })
                        }}
                      />
                    </div>
                  </div>

                  <div className="api-profile-actions">
                    <button className="secondary-button" type="button" disabled={!settings.apiEnabled || !selectedProfile.baseUrl || !selectedProfile.model} onClick={() => void onProviderChange({ activeApiProfileId: selectedProfile.id, preferApiModel: true })}>
                      设为当前
                    </button>
                    {pendingProfileDelete ? <>
                      <span>确定删除此配置？</span>
                      <button className="danger-button" type="button" onClick={() => void deleteSelectedProfile()}>确认删除</button>
                      <button className="secondary-button" type="button" onClick={() => setPendingProfileDelete(false)}>取消</button>
                    </> : (
                      <button className="secondary-button" type="button" onClick={() => setPendingProfileDelete(true)}>
                        <Trash2 aria-hidden="true" size={14} />删除
                      </button>
                    )}
                  </div>
                </> : null}

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
                    <span className="model-display" title={settings.selectedModel}>{settings.selectedModel}</span>
                    <ModelPicker
                      value={settings.selectedModel}
                      options={settings.models}
                      placeholder="未设置"
                      emptyHint="先获取模型"
                      disabled={!serviceAvailable}
                      onPick={(model) => void onModelChange(model)}
                    />
                  </div>
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

            {activePage === 'execution' ? (
              <ExecutionPage
                execution={settings.execution}
                disabled={!serviceAvailable}
                onChange={(patch) => void onExecutionSettingsChange({ ...settings.execution, ...patch })}
              />
            ) : null}

            {activePage === 'runtime' ? (
              <dl className="diagnostic-list">
                <div><dt>桌面服务</dt><dd>{serviceAvailable ? '已连接' : '未连接'}</dd></div>
                {diagnostics?.dataDirectory ? <div><dt>数据目录</dt><dd title={diagnostics.dataDirectory}>{diagnostics.dataDirectory}</dd></div> : null}
                {diagnostics?.runtime ? <div><dt>运行时</dt><dd>{diagnostics.runtime}</dd></div> : null}
              </dl>
            ) : null}
    </section>
  )
}
