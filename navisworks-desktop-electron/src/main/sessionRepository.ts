import { contextUsageSchema, type ContextUsage } from '../shared/ipc'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DesktopDataPaths } from './dataPaths'
import type { ThemeMode } from '../shared/ipc'
import { sanitizeToolNames } from '../shared/ipc'
import {
  DEFAULT_API_PROFILE_ADVANCED,
  DEFAULT_EXECUTION_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  type ApiProfileAdvancedSettings,
  type ExecutionSettings,
  type StorageSettings,
  type ToolPermission,
} from '../shared/ipc'
import type { SemanticMemory } from './agent/semanticMemory'
import type { ModelConfiguration, ModelInputModality, ModelOutputModality } from '../shared/model'

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000'
const DEFAULT_DATE_TIME_OFFSET = '0001-01-01T00:00:00+00:00'

export interface PersistedToolCall {
  id: string
  name: string
  status: string
  arguments: unknown
  result: unknown
  error: string
}

export interface ConversationMessage {
  role: string
  content: string
  isTransient: boolean
  thinkingText: string
  tools: PersistedToolCall[]
}

export interface ConversationSession {
  id: string
  title: string
  preview: string
  updatedAt: string
  messages: ConversationMessage[] | null
  contextTokensUsed: number
  contextUsage?: ContextUsage
  pinnedAt: string | null
  /** P4: durable digest of compacted early turns; absent ⇒ nothing compacted yet. */
  compactSummary?: string
  semanticMemory?: SemanticMemory
}

export interface ManagedExtension {
  id: string
  name: string
  type: string
  isEnabled: boolean
}

export interface ApiProfileSettings {
  id: string
  name: string
  baseUrl: string
  model: string
  models?: string[]
  enabled?: boolean
  apiKeyCiphertext: string
  /** Read only during one-time migration; never written back to disk. */
  legacyApiKey: string
  /** Compatibility & capability overrides; always complete after load. */
  advanced: ApiProfileAdvancedSettings
}

export interface AppSettings {
  selectedModel: string
  models: string[]
  plugins: ManagedExtension[]
  skills: ManagedExtension[]
  reasoningMode: string | null
  activeSessionId: string | null
  /** Legacy local-model field (migration only); the API runtime never reads it. */
  gpuVramGb: number
  /** Local Ollama context window; API windows come from profile/capability. */
  contextWindowTokens: number
  /** Local Ollama output cap; API output comes from the profile's advanced. */
  numPredict: number
  themeMode: ThemeMode
  disabledTools: string[]
  fontScale: number
  /** When true, chat completions run on the API model instead of local. */
  preferApiModel: boolean
  /** Whether the local Ollama daemon may serve chat requests. */
  ollamaEnabled: boolean
  /** Whether the configured API endpoint may serve chat requests. */
  apiEnabled: boolean
  apiProfiles: ApiProfileSettings[]
  activeApiProfileId: string | null
  /** Per-tool permission overrides; legacy disabledTools still honored on load. */
  toolPermissions: Record<string, ToolPermission>
  /** Run-scoped agent execution policy (defaults filled on load). */
  execution: ExecutionSettings
  /** Disk-history retention (defaults filled on load). */
  storage: StorageSettings
  /**
   * Model Configuration v2 (§19/§20): per-model overrides bound to a structured
   * ModelRef. OPTIONAL — absent (old settings.json) loads as undefined/[] with
   * no migration; the resolver treats absent as "no override".
   */
  modelConfigurations?: ModelConfiguration[]
}

/** Exact PascalCase disk contract written by the WPF System.Text.Json model. */
export interface WpfChatMessageSnapshot {
  Role: string
  Content: string
  IsTransient: boolean
  ThinkingText: string
  Tools?: WpfToolCallSnapshot[] | null
}

/** PascalCase tool-call snapshot; unknown to the legacy WPF reader, which ignores it. */
export interface WpfToolCallSnapshot {
  Id: string
  Name: string
  Status: string
  Arguments: unknown
  Result: unknown
  Error: string
}

/** Exact PascalCase disk contract written by ChatSessionSnapshot. */
export interface WpfChatSessionSnapshot {
  Id: string
  Title: string
  Preview: string
  UpdatedAt: string
  Messages: WpfChatMessageSnapshot[] | null
  ContextTokensUsed: number
  ContextUsage?: ContextUsage
  PinnedAt: string | null
  CompactSummary?: string
  SemanticMemory?: SemanticMemory
}

export interface WpfManagedExtensionSnapshot {
  Id: string
  Name: string
  Type: string
  IsEnabled: boolean
  /** WPF serializes this computed property; readers do not rely on it. */
  TypeLabel?: string
}

export interface WpfApiProfileSnapshot {
  Id: string
  Name: string
  BaseUrl: string
  Model: string
  Models?: string[]
  Enabled?: boolean
  ApiKeyCiphertext: string
  /** Electron-only extension: compatibility & capability overrides. */
  Advanced?: Record<string, unknown> | null
}

/** Exact PascalCase disk contract written by AppSettingsSnapshot. */
export interface WpfAppSettingsSnapshot {
  SelectedModel: string
  Models: string[]
  Plugins: WpfManagedExtensionSnapshot[]
  Skills: WpfManagedExtensionSnapshot[]
  ReasoningMode: string | null
  ActiveSessionId: string | null
  GpuVramGb: number
  CustomProfileContextWindowTokens: number
  CustomProfileNumPredict: number
  /** Electron-only extension. Older WPF readers ignore unknown JSON fields. */
  ThemeMode: ThemeMode
  /** Electron-only extension: tool names the user has switched off. */
  DisabledTools?: string[] | null
  /** Electron-only extension: global UI font zoom (0.85–1.3). */
  FontScale?: number | null
  /** Electron-only extensions: API endpoint settings. */
  PreferApiModel?: boolean | null
  /** Electron-only extensions: provider enable switches. */
  OllamaEnabled?: boolean | null
  ApiEnabled?: boolean | null
  ProviderBaseUrl?: string | null
  ProviderApiKey?: string | null
  CloudModel?: string | null
  ApiProfiles?: WpfApiProfileSnapshot[] | null
  ActiveApiProfileId?: string | null
  /** Electron-only extension: per-tool permission overrides. */
  ToolPermissions?: Record<string, unknown> | null
  /** Electron-only extension: run-scoped agent execution policy. */
  Execution?: Record<string, unknown> | null
  /** Electron-only extension: disk-history retention. */
  Storage?: Record<string, unknown> | null
  /**
   * Electron-only extension (Model Configuration v2): per-model overrides. The
   * structured ModelRef is preserved as an OBJECT (§19 — never a joined string
   * key). Older readers ignore this unknown field, so round-trips stay safe.
   */
  ModelConfigurations?: unknown[] | null
}

export type SessionLoadSource = 'none' | 'primary' | 'backup' | 'unavailable'

export interface SessionLoadResult {
  sessions: ConversationSession[]
  source: SessionLoadSource
  canPersist: boolean
}

export class JsonSessionRepository {
  readonly #primaryPath: string
  readonly #backupPath: string

  constructor(paths: Pick<DesktopDataPaths, 'sessionsFile' | 'sessionsBackupFile'>) {
    this.#primaryPath = paths.sessionsFile
    this.#backupPath = paths.sessionsBackupFile
  }

  async load(): Promise<SessionLoadResult> {
    const [primary, backup] = await Promise.all([
      tryReadSessions(this.#primaryPath),
      tryReadSessions(this.#backupPath),
    ])

    if (primary.kind === 'missing' && backup.kind === 'missing') {
      return { sessions: [], source: 'none', canPersist: true }
    }
    if (primary.kind === 'success') {
      return { sessions: primary.sessions, source: 'primary', canPersist: true }
    }
    if (backup.kind === 'success') {
      return { sessions: backup.sessions, source: 'backup', canPersist: true }
    }

    // Preserve future-schema or damaged history. The caller must not replace
    // it with an empty list until the user has recovered or moved the files.
    return { sessions: [], source: 'unavailable', canPersist: false }
  }

  async save(sessions: readonly ConversationSession[]): Promise<boolean> {
    try {
      const snapshots = sessions.map(toWpfSessionSnapshot)
      const json = `${JSON.stringify(snapshots, null, 2)}\n`
      await atomicWriteText(this.#primaryPath, json)
      await atomicWriteText(this.#backupPath, json)
      return true
    } catch (error) {
      if (isPersistenceError(error)) {
        return false
      }
      throw error
    }
  }
}

export class JsonSettingsRepository {
  readonly #settingsPath: string

  constructor(paths: Pick<DesktopDataPaths, 'settingsFile'>) {
    this.#settingsPath = paths.settingsFile
  }

  async load(): Promise<AppSettings | null> {
    try {
      const json = await readFile(this.#settingsPath, 'utf8')
      return fromWpfSettingsSnapshot(parseWpfSettingsSnapshot(JSON.parse(json)))
    } catch (error) {
      if (isPersistenceError(error) || error instanceof SyntaxError || error instanceof SnapshotError) {
        return null
      }
      throw error
    }
  }

  async save(settings: AppSettings): Promise<boolean> {
    try {
      const json = `${JSON.stringify(toWpfSettingsSnapshot(settings), null, 2)}\n`
      await atomicWriteText(this.#settingsPath, json)
      return true
    } catch (error) {
      if (isPersistenceError(error)) {
        return false
      }
      throw error
    }
  }
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  selectedModel: 'qwen3.5:9b-q4_K_M',
  models: ['qwen3.5:9b-q4_K_M'],
  plugins: [],
  skills: [],
  reasoningMode: 'low',
  activeSessionId: null,
  gpuVramGb: 8,
  contextWindowTokens: 32768,
  numPredict: 2048,
  themeMode: 'system',
  disabledTools: [],
  fontScale: 1,
  preferApiModel: false,
  ollamaEnabled: true,
  apiEnabled: true,
  apiProfiles: [],
  activeApiProfileId: null,
  toolPermissions: {},
  execution: { ...DEFAULT_EXECUTION_SETTINGS },
  storage: { ...DEFAULT_STORAGE_SETTINGS },
}

/**
 * Main-process facade used by IPC. Mutations are serialized so concurrent
 * renderer requests cannot lose sessions through overlapping read-modify-write
 * cycles; disk writes still use the WPF-compatible primary/backup repository.
 */
export class SessionRepository {
  readonly #sessions: JsonSessionRepository
  readonly #settings: JsonSettingsRepository
  #mutationChain: Promise<void> = Promise.resolve()

  constructor(paths: Pick<
    DesktopDataPaths,
    'sessionsFile' | 'sessionsBackupFile' | 'settingsFile'
  >) {
    this.#sessions = new JsonSessionRepository(paths)
    this.#settings = new JsonSettingsRepository(paths)
  }

  async listSessions(): Promise<ConversationSession[]> {
    const result = await this.#sessions.load()
    if (!result.canPersist) {
      throw new SessionRepositoryError(
        'SESSION_STORE_UNAVAILABLE',
        'sessions.json 与 sessions.backup.json 均不可读；已禁止覆盖历史。',
      )
    }
    return [...result.sessions].sort(compareSessionsByRecency)
  }

  async getSession(id: string): Promise<ConversationSession | null> {
    return (await this.listSessions()).find((session) => session.id === id) ?? null
  }

  async saveSession(session: ConversationSession): Promise<void> {
    await this.#serializeMutation(async () => {
      const sessions = await this.listSessions()
      const index = sessions.findIndex((entry) => entry.id === session.id)
      if (index >= 0) {
        sessions[index] = session
      } else {
        sessions.push(session)
      }
      // Disk retention follows the user's StorageSettings, read fresh so a
      // settings change applies without a restart. Model-context trimming is
      // a different concern and never deletes what is kept on disk.
      const { storage } = await this.getSettings()
      await this.#saveOrThrow(sessions.sort(compareSessionsByRecency), storage)
    })
  }

  async deleteSession(id: string): Promise<boolean> {
    return await this.#serializeMutation(async () => {
      const sessions = await this.listSessions()
      const remaining = sessions.filter((session) => session.id !== id)
      if (remaining.length === sessions.length) {
        return false
      }
      const { storage } = await this.getSettings()
      await this.#saveOrThrow(remaining, storage)
      return true
    })
  }

  async getSettings(): Promise<AppSettings> {
    const loaded = await this.#settings.load()
    return loaded ?? structuredClone(DEFAULT_APP_SETTINGS)
  }

  async updateSettings(
    update: Partial<AppSettings> | ((current: AppSettings) => AppSettings),
  ): Promise<AppSettings> {
    return await this.#serializeMutation(async () => {
      const current = await this.getSettings()
      const next = typeof update === 'function'
        ? update(current)
        : { ...current, ...update }
      if (!await this.#settings.save(next)) {
        throw new SessionRepositoryError('SETTINGS_SAVE_FAILED', '无法保存 settings.json。')
      }
      return next
    })
  }

  async #saveOrThrow(
    sessions: readonly ConversationSession[],
    storage: StorageSettings = { ...DEFAULT_STORAGE_SETTINGS },
  ): Promise<void> {
    // 0 disables count-based retention: keep everything on disk.
    const bounded = (storage.maxSessions > 0 ? sessions.slice(0, storage.maxSessions) : sessions)
      .map((session) => ({
        ...session,
        messages: storage.maxMessagesPerSession > 0 && session.messages !== null
          ? session.messages.slice(-storage.maxMessagesPerSession)
          : session.messages,
      }))
    if (!await this.#sessions.save(bounded)) {
      throw new SessionRepositoryError('SESSION_SAVE_FAILED', '无法保存会话文件。')
    }
  }

  async #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationChain
    let release: (() => void) | undefined
    this.#mutationChain = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }
}

export class SessionRepositoryError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionRepositoryError'
    this.code = code
  }
}

export function fromWpfSessionSnapshot(snapshot: WpfChatSessionSnapshot): ConversationSession {
  return {
    id: snapshot.Id,
    title: snapshot.Title,
    preview: snapshot.Preview,
    updatedAt: snapshot.UpdatedAt,
    messages: snapshot.Messages?.map((message) => ({
      role: message.Role,
      content: message.Content,
      isTransient: message.IsTransient,
      thinkingText: message.ThinkingText,
      tools: (message.Tools ?? []).map(fromWpfToolCallSnapshot),
    })) ?? null,
    contextTokensUsed: snapshot.ContextTokensUsed,
    ...(snapshot.ContextUsage ? { contextUsage: snapshot.ContextUsage } : {}),
    pinnedAt: snapshot.PinnedAt,
    ...(snapshot.CompactSummary === undefined ? {} : { compactSummary: snapshot.CompactSummary }),
    ...(snapshot.SemanticMemory === undefined ? {} : { semanticMemory: snapshot.SemanticMemory }),
  }
}

export function toWpfSessionSnapshot(session: ConversationSession): WpfChatSessionSnapshot {
  return {
    Id: session.id,
    Title: session.title,
    Preview: session.preview,
    UpdatedAt: session.updatedAt,
    Messages: session.messages?.map((message) => ({
      Role: message.role,
      Content: message.content,
      IsTransient: message.isTransient,
      ThinkingText: message.thinkingText,
      Tools: message.tools.map(toWpfToolCallSnapshot),
    })) ?? null,
    ContextTokensUsed: session.contextTokensUsed,
    ...(session.contextUsage ? { ContextUsage: session.contextUsage } : {}),
    PinnedAt: session.pinnedAt,
    ...(session.compactSummary === undefined ? {} : { CompactSummary: session.compactSummary }),
    ...(session.semanticMemory === undefined ? {} : { SemanticMemory: session.semanticMemory }),
  }
}

function fromWpfToolCallSnapshot(snapshot: WpfToolCallSnapshot): PersistedToolCall {
  return {
    id: snapshot.Id,
    name: snapshot.Name,
    status: snapshot.Status,
    arguments: snapshot.Arguments,
    result: snapshot.Result,
    error: snapshot.Error,
  }
}

function toWpfToolCallSnapshot(tool: PersistedToolCall): WpfToolCallSnapshot {
  return {
    Id: tool.id,
    Name: tool.name,
    Status: tool.status,
    Arguments: tool.arguments,
    Result: tool.result,
    Error: tool.error,
  }
}

function fromWpfSettingsSnapshot(snapshot: WpfAppSettingsSnapshot): AppSettings {
  const apiProfiles = (snapshot.ApiProfiles ?? []).map(fromWpfApiProfileSnapshot)
  const hasStoredProfiles = apiProfiles.length > 0
  if (
    apiProfiles.length === 0
    && (snapshot.ProviderBaseUrl || snapshot.ProviderApiKey || snapshot.CloudModel)
  ) {
    apiProfiles.push({
      id: 'legacy-default-api',
      name: '默认 API',
      baseUrl: optionalString(snapshot.ProviderBaseUrl, ''),
      model: optionalString(snapshot.CloudModel, ''),
      apiKeyCiphertext: '',
      legacyApiKey: optionalString(snapshot.ProviderApiKey, ''),
      advanced: { ...DEFAULT_API_PROFILE_ADVANCED },
    })
  }
  const fallbackProfileId = apiProfiles[0]?.id ?? null
  return {
    selectedModel: snapshot.SelectedModel,
    models: snapshot.Models,
    plugins: snapshot.Plugins.map(fromWpfExtensionSnapshot),
    skills: snapshot.Skills.map(fromWpfExtensionSnapshot),
    reasoningMode: snapshot.ReasoningMode,
    activeSessionId: snapshot.ActiveSessionId,
    gpuVramGb: snapshot.GpuVramGb,
    contextWindowTokens: snapshot.CustomProfileContextWindowTokens,
    numPredict: snapshot.CustomProfileNumPredict,
    themeMode: snapshot.ThemeMode,
    disabledTools: snapshot.DisabledTools ?? [],
    fontScale: clampFontScale(optionalFiniteNumber(snapshot.FontScale, 1)),
    preferApiModel: optionalBoolean(snapshot.PreferApiModel, false),
    ollamaEnabled: optionalBoolean(snapshot.OllamaEnabled, true),
    apiEnabled: optionalBoolean(snapshot.ApiEnabled, true),
    apiProfiles,
    activeApiProfileId: hasStoredProfiles ? snapshot.ActiveApiProfileId ?? null : fallbackProfileId,
    toolPermissions: parseToolPermissions(snapshot.ToolPermissions),
    // New fields default when absent — old settings.json files migrate intact.
    execution: parseExecutionSettings(snapshot.Execution),
    storage: parseStorageSettings(snapshot.Storage),
    // Model Configuration v2: absent in old files → undefined (resolver reads []
    // and applies no override). Structured ModelRef preserved, never a string.
    ...(snapshot.ModelConfigurations === undefined || snapshot.ModelConfigurations === null
      ? {}
      : { modelConfigurations: parseModelConfigurations(snapshot.ModelConfigurations) }),
  }
}

function toWpfSettingsSnapshot(settings: AppSettings): WpfAppSettingsSnapshot {
  const activeProfile = settings.apiProfiles.find((profile) => profile.id === settings.activeApiProfileId)
  return {
    SelectedModel: settings.selectedModel,
    Models: settings.models,
    Plugins: settings.plugins.map(toWpfExtensionSnapshot),
    Skills: settings.skills.map(toWpfExtensionSnapshot),
    ReasoningMode: settings.reasoningMode,
    ActiveSessionId: settings.activeSessionId,
    GpuVramGb: settings.gpuVramGb,
    CustomProfileContextWindowTokens: settings.contextWindowTokens,
    CustomProfileNumPredict: settings.numPredict,
    ThemeMode: settings.themeMode,
    DisabledTools: settings.disabledTools,
    FontScale: settings.fontScale,
    PreferApiModel: settings.preferApiModel,
    OllamaEnabled: settings.ollamaEnabled,
    ApiEnabled: settings.apiEnabled,
    ProviderBaseUrl: activeProfile?.baseUrl ?? '',
    ProviderApiKey: '',
    CloudModel: activeProfile?.model ?? '',
    ApiProfiles: settings.apiProfiles.map(toWpfApiProfileSnapshot),
    ActiveApiProfileId: settings.activeApiProfileId,
    ToolPermissions: { ...settings.toolPermissions },
    Execution: { ...settings.execution },
    Storage: { ...settings.storage },
    ...(settings.modelConfigurations === undefined
      ? {}
      : { ModelConfigurations: settings.modelConfigurations.map((configuration) => ({
        ref: { providerId: configuration.ref.providerId, modelId: configuration.ref.modelId },
        ...(configuration.contextWindowTokens === undefined
          ? {} : { contextWindowTokens: configuration.contextWindowTokens }),
        ...(configuration.maxOutputTokens === undefined
          ? {} : { maxOutputTokens: configuration.maxOutputTokens }),
        ...(configuration.inputModalities === undefined
          ? {} : { inputModalities: [...configuration.inputModalities] }),
        ...(configuration.outputModalities === undefined
          ? {} : { outputModalities: [...configuration.outputModalities] }),
      })) }),
  }
}

/** Keeps the persisted zoom inside the schema's 0.85–1.3 window. */
function clampFontScale(value: number): number {
  return Math.min(1.3, Math.max(0.85, value))
}

function fromWpfExtensionSnapshot(snapshot: WpfManagedExtensionSnapshot): ManagedExtension {
  return {
    id: snapshot.Id,
    name: snapshot.Name,
    type: snapshot.Type,
    isEnabled: snapshot.IsEnabled,
  }
}

function toWpfExtensionSnapshot(extension: ManagedExtension): WpfManagedExtensionSnapshot {
  return {
    Id: extension.id,
    Name: extension.name,
    Type: extension.type,
    IsEnabled: extension.isEnabled,
    TypeLabel: extension.type === 'plugin' ? '插件' : '技能',
  }
}

function fromWpfApiProfileSnapshot(snapshot: WpfApiProfileSnapshot): ApiProfileSettings {
  return {
    id: snapshot.Id,
    name: snapshot.Name,
    baseUrl: snapshot.BaseUrl,
    model: snapshot.Model,
    models: snapshot.Models,
    enabled: snapshot.Enabled,
    apiKeyCiphertext: snapshot.ApiKeyCiphertext,
    legacyApiKey: '',
    advanced: parseProfileAdvanced(snapshot.Advanced),
  }
}

function toWpfApiProfileSnapshot(profile: ApiProfileSettings): WpfApiProfileSnapshot {
  return {
    Id: profile.id,
    Name: profile.name,
    BaseUrl: profile.baseUrl,
    Model: profile.model,
    Models: profile.models,
    Enabled: profile.enabled,
    ApiKeyCiphertext: profile.apiKeyCiphertext,
    Advanced: { ...profile.advanced },
  }
}

type ReadSessionsResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'success'; sessions: ConversationSession[] }

async function tryReadSessions(filePath: string): Promise<ReadSessionsResult> {
  try {
    const json = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) {
      return { kind: 'invalid' }
    }

    return {
      kind: 'success',
      sessions: parsed.map((entry) => fromWpfSessionSnapshot(parseWpfSessionSnapshot(entry))),
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { kind: 'missing' }
    }
    if (isPersistenceError(error) || error instanceof SyntaxError || error instanceof SnapshotError) {
      return { kind: 'invalid' }
    }
    throw error
  }
}

function parseWpfSessionSnapshot(value: unknown): WpfChatSessionSnapshot {
  const entry = requireObject(value, 'session')
  const id = optionalString(entry.Id, EMPTY_GUID)
  assertGuid(id, 'Id')

  const messagesValue = entry.Messages
  let messages: WpfChatMessageSnapshot[] | null = null
  if (messagesValue !== undefined && messagesValue !== null) {
    if (!Array.isArray(messagesValue)) {
      throw new SnapshotError('Messages must be an array or null.')
    }
    messages = messagesValue.map(parseWpfMessageSnapshot)
  }

  const pinnedAt = nullableString(entry.PinnedAt)
  if (pinnedAt !== null) {
    assertDateTimeOffset(pinnedAt, 'PinnedAt')
  }

  const updatedAt = optionalString(entry.UpdatedAt, DEFAULT_DATE_TIME_OFFSET)
  assertDateTimeOffset(updatedAt, 'UpdatedAt')
  const semanticMemory = parseSemanticMemory(entry.SemanticMemory)

  return {
    Id: id,
    Title: optionalString(entry.Title, ''),
    Preview: optionalString(entry.Preview, ''),
    UpdatedAt: updatedAt,
    Messages: messages,
    ContextTokensUsed: optionalFiniteInteger(entry.ContextTokensUsed, 0),
    ...(contextUsageSchema.safeParse(entry.ContextUsage).success ? { ContextUsage: contextUsageSchema.parse(entry.ContextUsage) } : {}),
    PinnedAt: pinnedAt,
    ...(typeof entry.CompactSummary === 'string' ? { CompactSummary: entry.CompactSummary } : {}),
    ...(semanticMemory === undefined ? {} : { SemanticMemory: semanticMemory }),
  }
}

function parseWpfMessageSnapshot(value: unknown): WpfChatMessageSnapshot {
  const entry = requireObject(value, 'message')
  return {
    Role: optionalString(entry.Role, ''),
    Content: optionalString(entry.Content, ''),
    IsTransient: optionalBoolean(entry.IsTransient, false),
    ThinkingText: optionalString(entry.ThinkingText, ''),
    Tools: optionalObjectArray(entry.Tools).map(parseWpfToolCallSnapshot),
  }
}

function parseWpfToolCallSnapshot(value: unknown): WpfToolCallSnapshot {
  const entry = requireObject(value, 'tool call')
  return {
    Id: optionalString(entry.Id, ''),
    Name: optionalString(entry.Name, ''),
    Status: optionalString(entry.Status, ''),
    Arguments: entry.Arguments ?? null,
    Result: entry.Result ?? null,
    Error: optionalString(entry.Error, ''),
  }
}

function parseWpfSettingsSnapshot(value: unknown): WpfAppSettingsSnapshot {
  const entry = requireObject(value, 'settings')
  const activeSessionId = nullableString(entry.ActiveSessionId)
  if (activeSessionId !== null) {
    assertGuid(activeSessionId, 'ActiveSessionId')
  }

  return {
    SelectedModel: optionalString(entry.SelectedModel, ''),
    Models: optionalStringArray(entry.Models),
    Plugins: optionalObjectArray(entry.Plugins).map(parseWpfExtensionSnapshot),
    Skills: optionalObjectArray(entry.Skills).map(parseWpfExtensionSnapshot),
    ReasoningMode: nullableString(entry.ReasoningMode),
    ActiveSessionId: activeSessionId,
    GpuVramGb: optionalFiniteNumber(entry.GpuVramGb, 8),
    CustomProfileContextWindowTokens: optionalFiniteInteger(
      entry.CustomProfileContextWindowTokens,
      32768,
    ),
    CustomProfileNumPredict: optionalFiniteInteger(entry.CustomProfileNumPredict, 2048),
    ThemeMode: optionalThemeMode(entry.ThemeMode),
    // P30.7: malformed names from hand-edited files are dropped; any
    // well-formed name (current Navisworks tool or a future capability) is
    // trusted, since disabledTools only ever maps a name to deny (§39).
    DisabledTools: sanitizeToolNames(optionalStringArray(entry.DisabledTools)),
    FontScale: optionalFiniteNumber(entry.FontScale, 1),
    PreferApiModel: typeof entry.PreferApiModel === 'boolean'
      ? entry.PreferApiModel
      : null,
    OllamaEnabled: optionalBoolean(entry.OllamaEnabled, true),
    ApiEnabled: optionalBoolean(entry.ApiEnabled, true),
    ProviderBaseUrl: optionalString(entry.ProviderBaseUrl, ''),
    ProviderApiKey: optionalString(entry.ProviderApiKey, ''),
    CloudModel: optionalString(entry.CloudModel, ''),
    ApiProfiles: optionalObjectArray(entry.ApiProfiles).map(parseWpfApiProfileSnapshot),
    ActiveApiProfileId: nullableString(entry.ActiveApiProfileId),
    ToolPermissions: objectOrNull(entry.ToolPermissions),
    Execution: objectOrNull(entry.Execution),
    Storage: objectOrNull(entry.Storage),
    // Model Configuration v2: pass the raw array through (validated in
    // fromWpfSettingsSnapshot → parseModelConfigurations). Absent → undefined,
    // so old settings stay "no overrides".
    ModelConfigurations: Array.isArray(entry.ModelConfigurations) ? entry.ModelConfigurations : null,
  }
}

function parseWpfApiProfileSnapshot(value: unknown): WpfApiProfileSnapshot {
  const entry = requireObject(value, 'API profile')
  return {
    Id: optionalString(entry.Id, ''),
    Name: optionalString(entry.Name, 'API'),
    BaseUrl: optionalString(entry.BaseUrl, ''),
    Model: optionalString(entry.Model, ''),
    ApiKeyCiphertext: optionalString(entry.ApiKeyCiphertext, ''),
    Models: Array.isArray(entry.Models) ? entry.Models.filter((value): value is string => typeof value === 'string' && value.trim() !== '') : undefined,
    Enabled: typeof entry.Enabled === 'boolean' ? entry.Enabled : undefined,
    Advanced: objectOrNull(entry.Advanced),
  }
}

function parseWpfExtensionSnapshot(value: unknown): WpfManagedExtensionSnapshot {
  const entry = requireObject(value, 'extension')
  const id = optionalString(entry.Id, EMPTY_GUID)
  assertGuid(id, 'extension Id')
  return {
    Id: id,
    Name: optionalString(entry.Name, ''),
    Type: optionalString(entry.Type, ''),
    IsEnabled: optionalBoolean(entry.IsEnabled, false),
    TypeLabel: typeof entry.TypeLabel === 'string' ? entry.TypeLabel : undefined,
  }
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true })

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().replaceAll('-', '')}.tmp`
  try {
    await writeFile(temporaryPath, content, 'utf8')
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

class SnapshotError extends Error {}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotError(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'string') {
    throw new SnapshotError('Expected a string.')
  }
  return value
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new SnapshotError('Expected a string or null.')
  }
  return value
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'boolean') {
    throw new SnapshotError('Expected a boolean.')
  }
  return value
}

function optionalFiniteNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SnapshotError('Expected a finite number.')
  }
  return value
}

function optionalFiniteInteger(value: unknown, fallback: number): number {
  const number = optionalFiniteNumber(value, fallback)
  if (!Number.isInteger(number)) {
    throw new SnapshotError('Expected an integer.')
  }
  return number
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new SnapshotError('Expected an array of strings.')
  }
  return [...value] as string[]
}

function optionalThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function optionalObjectArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new SnapshotError('Expected an array.')
  }
  return value
}

function parseSemanticMemory(value: unknown): SemanticMemory | undefined {
  if (value === undefined || value === null) return undefined
  const entry = requireObject(value, 'semantic memory')
  const legacyGoal = optionalString(entry.goal, '')
  const goals = optionalStringArray(entry.goals)
  return {
    goals: (goals.length > 0 ? goals : legacyGoal ? [legacyGoal] : []).slice(-8),
    constraints: optionalStringArray(entry.constraints).slice(-8),
    decisions: optionalStringArray(entry.decisions).slice(-8),
    notes: optionalStringArray(entry.notes).slice(-8),
    updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
      ? Math.max(0, Math.trunc(entry.updatedAt))
      : 0,
  }
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, value))
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function nullableClampInteger(
  value: unknown,
  fallback: number | null,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return fallback
  return clampInteger(value, fallback ?? min, min, max)
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

/** Lenient per-field normalization for profile advanced settings (schema-compatible). */
export function normalizeProfileAdvanced(value: unknown): ApiProfileAdvancedSettings {
  return parseProfileAdvanced(value)
}

/** Lenient normalization for permission patches (schema-compatible). */
export function normalizeToolPermissions(value: unknown): Record<string, ToolPermission> {
  return parseToolPermissions(value)
}

/** Lenient per-field normalization for execution settings (schema-compatible). */
export function normalizeExecutionSettings(value: unknown): ExecutionSettings {
  return parseExecutionSettings(value)
}

/** Lenient per-field normalization for storage settings (schema-compatible). */
export function normalizeStorageSettings(value: unknown): StorageSettings {
  return parseStorageSettings(value)
}

function parseToolPermissions(value: unknown): Record<string, ToolPermission> {
  const entry = objectOrNull(value) ?? {}
  const allowed: readonly string[] = ['allow', 'ask', 'deny']
  const result: Record<string, ToolPermission> = {}
  for (const [name, permission] of Object.entries(entry)) {
    if (typeof name === 'string' && name.trim() && typeof permission === 'string' && allowed.includes(permission)) {
      result[name] = permission as ToolPermission
    }
  }
  return result
}

function parseExecutionSettings(value: unknown): ExecutionSettings {
  const entry = objectOrNull(value) ?? {}
  const defaults = DEFAULT_EXECUTION_SETTINGS
  return {
    maxToolRounds: clampInteger(entry.maxToolRounds, defaults.maxToolRounds, 1, 64),
    compactionEnabled: typeof entry.compactionEnabled === 'boolean'
      ? entry.compactionEnabled
      : defaults.compactionEnabled,
    compactionTriggerRatio: clampNumber(
      entry.compactionTriggerRatio,
      defaults.compactionTriggerRatio,
      0.5,
      0.98,
    ),
    compactKeepRecentFrames: clampInteger(
      entry.compactKeepRecentFrames,
      defaults.compactKeepRecentFrames,
      0,
      20,
    ),
    compactMaxTranscriptChars: clampInteger(
      entry.compactMaxTranscriptChars,
      defaults.compactMaxTranscriptChars,
      2_000,
      200_000,
    ),
    historyMode: optionalEnum(entry.historyMode, ['auto', 'fixed'] as const, defaults.historyMode),
    historyMessageLimit: nullableClampInteger(
      entry.historyMessageLimit,
      defaults.historyMessageLimit,
      4,
      1_000,
    ),
    toolResultMode: optionalEnum(entry.toolResultMode, ['auto', 'fixed'] as const, defaults.toolResultMode),
    toolResultMaxChars: nullableClampInteger(
      entry.toolResultMaxChars,
      defaults.toolResultMaxChars,
      500,
      200_000,
    ),
    plannerMaxAttempts: clampInteger(entry.plannerMaxAttempts, defaults.plannerMaxAttempts, 1, 5),
    plannerMaxSteps: clampInteger(entry.plannerMaxSteps, defaults.plannerMaxSteps, 1, 32),
    plannerMaxTokens: nullableClampInteger(
      entry.plannerMaxTokens,
      defaults.plannerMaxTokens,
      256,
      200_000,
    ),
    verifierMaxAttempts: clampInteger(entry.verifierMaxAttempts, defaults.verifierMaxAttempts, 1, 5),
    verifierMaxEvidence: clampInteger(entry.verifierMaxEvidence, defaults.verifierMaxEvidence, 2, 50),
    maxTaskReplans: clampInteger(entry.maxTaskReplans, defaults.maxTaskReplans, 0, 16),
  }
}

function parseStorageSettings(value: unknown): StorageSettings {
  const entry = objectOrNull(value) ?? {}
  const defaults = DEFAULT_STORAGE_SETTINGS
  return {
    maxSessions: clampInteger(entry.maxSessions, defaults.maxSessions, 0, 10_000),
    maxMessagesPerSession: clampInteger(entry.maxMessagesPerSession, defaults.maxMessagesPerSession, 0, 10_000),
  }
}

function parseProfileAdvanced(value: unknown): ApiProfileAdvancedSettings {
  const entry = objectOrNull(value) ?? {}
  const defaults = DEFAULT_API_PROFILE_ADVANCED
  return {
    contextWindowTokens: nullableClampInteger(
      entry.contextWindowTokens,
      defaults.contextWindowTokens,
      1024,
      2_000_000,
    ),
    maxOutputTokens: nullableClampInteger(
      entry.maxOutputTokens,
      defaults.maxOutputTokens,
      128,
      1_000_000,
    ),
    temperature: typeof entry.temperature === 'number' && Number.isFinite(entry.temperature)
      ? clampNumber(entry.temperature, 0.2, 0, 2)
      : defaults.temperature,
    requestTimeoutMs: clampInteger(entry.requestTimeoutMs, defaults.requestTimeoutMs, 5_000, 600_000),
    maxTokensParameter: optionalEnum(
      entry.maxTokensParameter,
      ['auto', 'max_tokens', 'max_completion_tokens', 'omit'] as const,
      defaults.maxTokensParameter,
    ),
    sendReasoningEffort: optionalEnum(
      entry.sendReasoningEffort,
      ['auto', 'on', 'off'] as const,
      defaults.sendReasoningEffort,
    ),
    sendStreamOptions: typeof entry.sendStreamOptions === 'boolean'
      ? entry.sendStreamOptions
      : defaults.sendStreamOptions,
  }
}

/**
 * Model Configuration v2 (§19/§28): validate persisted per-model overrides. Each
 * needs a STRUCTURED ref (providerId + non-empty modelId — never a joined
 * string); numeric fields clamp to the schema bounds or drop to undefined (Auto);
 * modalities filter to the known enum. An entry with no valid ref is DROPPED so
 * a hand-edited file can't inject a broken key. Returns undefined only for an
 * empty result (so absent old settings stay absent).
 */
const MODEL_INPUT_MODALITIES = ['text', 'image', 'video', 'pdf'] as const
const MODEL_OUTPUT_MODALITIES = ['text', 'image'] as const

function parseModelConfigurations(value: unknown): ModelConfiguration[] {
  if (!Array.isArray(value)) return []
  const configurations: ModelConfiguration[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const entry = objectOrNull(raw)
    const ref = objectOrNull(entry?.ref)
    const providerId = typeof ref?.providerId === 'string' ? ref.providerId.trim() : ''
    const modelId = typeof ref?.modelId === 'string' ? ref.modelId.trim() : ''
    if (providerId === '' || modelId === '') continue
    const key = `${providerId} ${modelId}`
    if (seen.has(key)) continue
    seen.add(key)
    const inputModalities = Array.isArray(entry?.inputModalities)
      ? entry.inputModalities.filter((m): m is ModelInputModality =>
        (MODEL_INPUT_MODALITIES as readonly string[]).includes(String(m)))
      : undefined
    const outputModalities = Array.isArray(entry?.outputModalities)
      ? entry.outputModalities.filter((m): m is ModelOutputModality =>
        (MODEL_OUTPUT_MODALITIES as readonly string[]).includes(String(m)))
      : undefined
    const context = nullableClampInteger(entry?.contextWindowTokens, null, 1024, 2_000_000)
    const output = nullableClampInteger(entry?.maxOutputTokens, null, 128, 1_000_000)
    configurations.push({
      ref: { providerId, modelId },
      ...(context === null ? {} : { contextWindowTokens: context }),
      ...(output === null ? {} : { maxOutputTokens: output }),
      ...(inputModalities === undefined || inputModalities.length === 0
        ? {}
        : { inputModalities }),
      ...(outputModalities === undefined || outputModalities.length === 0
        ? {}
        : { outputModalities }),
    })
  }
  return configurations
}

function assertGuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new SnapshotError(`${label} must be a GUID.`)
  }
}

function assertDateTimeOffset(value: string, label: string): void {
  if (!/^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new SnapshotError(`${label} must be an ISO 8601 DateTimeOffset.`)
  }
}

function isPersistenceError(error: unknown): boolean {
  return error instanceof Error && (
    error instanceof SyntaxError
    || hasErrorCode(error, 'EACCES')
    || hasErrorCode(error, 'EPERM')
    || hasErrorCode(error, 'EIO')
    || hasErrorCode(error, 'ENOSPC')
    || hasErrorCode(error, 'EROFS')
    || hasErrorCode(error, 'ENAMETOOLONG')
    || hasErrorCode(error, 'ENOENT')
    || hasErrorCode(error, 'ENOTDIR')
    || hasErrorCode(error, 'EISDIR')
  )
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}

function compareSessionsByRecency(left: ConversationSession, right: ConversationSession): number {
  const leftTime = Date.parse(left.updatedAt)
  const rightTime = Date.parse(right.updatedAt)
  return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
}
