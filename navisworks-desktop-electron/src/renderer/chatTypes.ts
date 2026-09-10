import { contextUsageSchema, type ContextUsage } from '../shared/ipc'
import {
  DEFAULT_API_PROFILE_ADVANCED,
  DEFAULT_EXECUTION_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  sanitizeToolNames,
  type ApiProfile,
  type ApiProfileAdvancedSettings,
  type ContextWindowSource,
  type ToolDefinitionSummary,
  type ToolPermission,
  type ExecutionSettings,
  type NavisworksInstanceSummary,
  type StorageSettings,
  type ToolApprovalRequest,
  type ToolName,
} from '../shared/ipc'
import { normalizeReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from '../shared/reasoning'
import type {
  ModelConfiguration,
  ModelInfo,
  ModelInputModality,
  ModelMetadataSourceId,
  ModelOutputModality,
  ModelRef,
  ModelUsage,
} from '../shared/model'

export type { ApiProfile, ContextWindowSource, ToolApprovalRequest, ToolDefinitionSummary, ToolPermission }
export type { ReasoningEffort }
export type {
  ModelConfiguration,
  ModelInfo,
  ModelInputModality,
  ModelOutputModality,
  ModelUsage,
  ModelRef,
}
export type { QuestionAnswer, QuestionPrompt, QuestionRequest } from '../shared/ipc'

export type MessageRole = 'user' | 'assistant' | 'system' | 'error'

export type ToolStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled'

export interface ToolCall {
  id: string
  name: string
  status: ToolStatus
  arguments?: unknown
  result?: unknown
  error?: string
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: string
  thinking?: string
  transient?: boolean
  tools: ToolCall[]
}

export interface SessionSummary {
  id: string
  title: string
  preview: string
  updatedAt: string
  pinnedAt?: string | null
}

export interface ChatSession extends SessionSummary {
  contextUsage?: ContextUsage
  messages: ChatMessage[]
  contextTokensUsed?: number
  /** P4: durable digest of compacted early turns; undefined ⇒ nothing compacted yet. */
  compactSummary?: string
}

export interface DesktopSettings {
  selectedModel: string
  models: string[]
  reasoningMode: ReasoningEffort
  themeMode: 'system' | 'light' | 'dark'
  disabledTools: ToolName[]
  fontScale: number
  /** Local model context window (tokens); the runtime caps it at 32K. */
  contextWindowTokens: number
  preferApiModel: boolean
  /** Whether the local Ollama daemon may serve chat requests. */
  ollamaEnabled: boolean
  /** Whether the configured API endpoint may serve chat requests. */
  apiEnabled: boolean
  apiProfiles: ApiProfile[]
  activeApiProfileId: string | null
  /** Per-tool permission overrides (allow/ask/deny). */
  toolPermissions: Record<string, ToolPermission>
  /** Run-scoped agent execution policy (defaults; no user UI). */
  execution: ExecutionSettings
  /** Disk-history retention. */
  storage: StorageSettings
  /** Model Configuration v2: per-model overrides (empty when none saved). */
  modelConfigurations: ModelConfiguration[]
}

export type { ApiProfileAdvancedSettings, ExecutionSettings, StorageSettings }

export interface NavisworksStatus {
  connected: boolean
  status: string
  documentName?: string
  selectionCount?: number
}

/**
 * Header chip texts for the Navisworks status. While disconnected the chip
 * de-emphasizes to the bare product name — Curi's front page should lead with
 * Curi, and "Navisworks 未连接" is a third-layer detail that belongs in the
 * hover title. Connected states keep the current prominence.
 */
export function navisworksStatusBadge(status: NavisworksStatus): { label: string; title: string } {
  if (status.documentName) {
    return { label: status.documentName, title: status.documentName }
  }
  return status.connected
    ? { label: 'Navisworks 已连接', title: 'Navisworks 已连接' }
    : { label: 'Navisworks', title: 'Navisworks 未连接' }
}

/**
 * Display name for an instance's document: basename only, the last known
 * Navisworks extension stripped (case-insensitive). Rendering-only — never
 * feeds selection or safety logic. Missing names read as 未命名文档.
 */
export function formatNavisworksDocumentName(documentName: string | undefined): string {
  const base = (documentName ?? '').split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(nwd|nwf|nwc)$/i, '') || '未命名文档'
}

/**
 * Single-line label for one instance row, with PID added only when another
 * connected instance shares the same display name (so name collisions stay
 * distinguishable while quiet rows stay quiet).
 */
export function navisworksInstanceDisplay(
  instance: NavisworksInstanceSummary,
  instances: readonly NavisworksInstanceSummary[],
): { name: string; label: string } {
  const name = formatNavisworksDocumentName(instance.documentName)
  const colliding = instances.filter(
    (candidate) => candidate.connected
      && formatNavisworksDocumentName(candidate.documentName) === name,
  ).length > 1
  return { name, label: colliding ? `${name} · ${instance.processId}` : name }
}

export type ChatRunPhase = 'generating' | 'verifying' | 'awaiting-user-input'

export interface ChatStreamEvent {
  sessionId: string
  turnId?: string
  messageId?: string
  kind: 'thinking' | 'text' | 'tool-start' | 'tool-result' | 'done' | 'error' | 'phase'
  /** Present on kind='phase': what the background run is doing right now. */
  phase?: ChatRunPhase
  text?: string
  delta?: string
  content?: string
  thinkingText?: string
  toolCallId?: string
  toolName?: string
  arguments?: unknown
  result?: unknown
  contextTokensUsed?: number
  /** P6: raw provider usage of the finished run's last round. */
  usage?: ModelUsage
  cacheHitRate?: number
  /** Finite context window the finished run budgeted against. */
  contextWindowTokens?: number
  /** Where that window came from ('fallback' = safety budget, NOT a model limit). */
  contextWindowSource?: ContextWindowSource
  /**
   * Model Configuration v2 (§31): the ModelRef the reported window/usage belong
   * to. The ring refuses a stale window from a different model.
   */
  modelRef?: ModelRef
  compacted?: boolean
  error?: string | { code: string; message: string }
}

export function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function normalizeRole(value: unknown): MessageRole {
  switch (String(value ?? '').toLowerCase()) {
    case 'user':
      return 'user'
    case 'ai':
    case 'assistant':
      return 'assistant'
    case 'error':
      return 'error'
    default:
      return 'system'
  }
}

function normalizeToolStatus(value: unknown): ToolStatus {
  switch (String(value ?? '').toLowerCase()) {
    case 'queued':
      return 'queued'
    case 'success':
    case 'done':
    case 'completed':
      return 'success'
    case 'error':
    case 'failed':
      return 'error'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      return 'running'
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function normalizeTool(value: unknown, index = 0): ToolCall {
  const source = asRecord(value)
  return {
    id: String(source.id ?? source.toolCallId ?? `tool-${index}`),
    name: String(source.name ?? source.toolName ?? '工具'),
    status: normalizeToolStatus(source.status),
    arguments: source.arguments ?? source.args,
    result: source.result ?? source.output,
    error: typeof source.error === 'string' ? source.error : undefined
  }
}

export function normalizeMessage(value: unknown, index = 0): ChatMessage {
  const source = asRecord(value)
  const rawTools = Array.isArray(source.tools)
    ? source.tools
    : Array.isArray(source.toolEvents)
      ? source.toolEvents
      : []

  return {
    id: String(source.id ?? `message-${index}-${source.createdAt ?? Date.now()}`),
    role: normalizeRole(source.role ?? source.Role),
    content: String(source.content ?? source.Content ?? ''),
    createdAt: String(source.createdAt ?? source.CreatedAt ?? new Date().toISOString()),
    thinking: String(source.thinking ?? source.thinkingText ?? source.ThinkingText ?? '') || undefined,
    transient: Boolean(source.transient ?? source.isTransient ?? source.IsTransient),
    tools: rawTools.map(normalizeTool)
  }
}

export function normalizeSummary(value: unknown, index = 0): SessionSummary {
  const source = asRecord(value)
  return {
    id: String(source.id ?? source.Id ?? `session-${index}`),
    title: String(source.title ?? source.Title ?? '新会话'),
    preview: String(source.preview ?? source.Preview ?? ''),
    updatedAt: String(source.updatedAt ?? source.UpdatedAt ?? new Date().toISOString()),
    pinnedAt: (source.pinnedAt ?? source.PinnedAt ?? null) as string | null
  }
}

export function normalizeSession(value: unknown): ChatSession {
  const source = asRecord(value)
  const summary = normalizeSummary(source)
  const rawMessages = Array.isArray(source.messages)
    ? source.messages
    : Array.isArray(source.Messages)
      ? source.Messages
      : []

  const compactSummary = typeof source.compactSummary === 'string' ? source.compactSummary : undefined
  return {
    ...summary,
    messages: rawMessages.map(normalizeMessage),
    ...(contextUsageSchema.safeParse(source.contextUsage).success ? { contextUsage: contextUsageSchema.parse(source.contextUsage) } : {}),
    contextTokensUsed: Number(source.contextTokensUsed ?? source.ContextTokensUsed ?? 0),
    ...(compactSummary === undefined ? {} : { compactSummary })
  }
}

export function normalizeSettings(value: unknown): DesktopSettings {
  const source = asRecord(value)
  const rawModels = Array.isArray(source.models)
    ? source.models
    : Array.isArray(source.Models)
      ? source.Models
      : []
  const models = rawModels.map(String).filter(Boolean)
  const selectedModel = String(source.selectedModel ?? source.SelectedModel ?? models[0] ?? 'qwen3.5:9b-q4_K_M')
  if (!models.includes(selectedModel)) models.unshift(selectedModel)

  // P30.7: persisted disabled tools are sanitized by FORMAT, not against a
  // closed enum, so a future capability's name survives the round-trip (§39).
  const rawDisabled = (Array.isArray(source.disabledTools)
    ? source.disabledTools
    : Array.isArray(source.DisabledTools)
      ? source.DisabledTools
      : []).map(String)

  const rawFontScale = Number(source.fontScale ?? source.FontScale ?? 1)
  const rawApiProfiles = Array.isArray(source.apiProfiles) ? source.apiProfiles : []
  const apiProfiles = rawApiProfiles.map((value, index): ApiProfile => {
    const profile = asRecord(value)
    const rawAdvanced = asRecord(profile.advanced ?? {})
    return {
      id: String(profile.id ?? `api-${index}`),
      name: String(profile.name ?? 'API'),
      baseUrl: String(profile.baseUrl ?? ''),
      model: String(profile.model ?? ''),
      models: Array.isArray(profile.models) ? profile.models.filter((value): value is string => typeof value === 'string' && value.trim() !== '') : undefined,
      enabled: profile.enabled !== false,
      hasApiKey: Boolean(profile.hasApiKey),
      advanced: normalizeProfileAdvanced(rawAdvanced)
    }
  })

  return {
    selectedModel,
    models,
    reasoningMode: normalizeReasoningEffort(source.reasoningMode ?? source.ReasoningMode),
    themeMode: source.themeMode === 'light' || source.themeMode === 'dark' ? source.themeMode : 'system',
    disabledTools: sanitizeToolNames(rawDisabled),
    fontScale: Number.isFinite(rawFontScale) ? Math.min(1.3, Math.max(0.85, rawFontScale)) : 1,
    contextWindowTokens: Number(
      source.contextWindowTokens
        ?? source.ContextTokensUsed
        ?? source.CustomProfileContextWindowTokens
        ?? 32768
    ) || 32768,
    preferApiModel: Boolean(source.preferApiModel ?? source.PreferApiModel ?? false),
    ollamaEnabled: Boolean(source.ollamaEnabled ?? source.OllamaEnabled ?? true),
    apiEnabled: Boolean(source.apiEnabled ?? source.ApiEnabled ?? true),
    apiProfiles,
    activeApiProfileId: typeof source.activeApiProfileId === 'string' ? source.activeApiProfileId : null,
    toolPermissions: normalizeToolPermissions(asRecord(source.toolPermissions ?? {})),
    execution: normalizeExecutionSettings(asRecord(source.execution ?? {})),
    storage: normalizeStorageSettings(asRecord(source.storage ?? {})),
    // Model Configuration v2: old settings (no key) → []. Structured ref only.
    modelConfigurations: normalizeModelConfigurations(
      Array.isArray(source.modelConfigurations)
        ? source.modelConfigurations
        : Array.isArray(source.ModelConfigurations)
          ? source.ModelConfigurations
          : [],
    ),
  }
}

const INPUT_MODALITIES: readonly string[] = ['text', 'image', 'video', 'pdf']
const OUTPUT_MODALITIES: readonly string[] = ['text', 'image']

function normalizeModelConfigurations(value: readonly unknown[]): ModelConfiguration[] {
  const configs: ModelConfiguration[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const entry = asRecord(raw)
    const ref = asRecord(entry.ref)
    const providerId = typeof ref.providerId === 'string' ? ref.providerId.trim() : ''
    const modelId = typeof ref.modelId === 'string' ? ref.modelId.trim() : ''
    if (providerId === '' || modelId === '') continue
    const key = `${providerId} ${modelId}`
    if (seen.has(key)) continue
    seen.add(key)
    const context = clampOptionalInt(entry.contextWindowTokens, 1024, 2_000_000)
    const output = clampOptionalInt(entry.maxOutputTokens, 128, 1_000_000)
    const inputModalities = Array.isArray(entry.inputModalities)
      ? entry.inputModalities.filter((m): m is ModelInputModality => INPUT_MODALITIES.includes(String(m)))
      : undefined
    const outputModalities = Array.isArray(entry.outputModalities)
      ? entry.outputModalities.filter((m): m is ModelOutputModality => OUTPUT_MODALITIES.includes(String(m)))
      : undefined
    configs.push({
      ref: { providerId, modelId },
      ...(context === undefined ? {} : { contextWindowTokens: context }),
      ...(output === undefined ? {} : { maxOutputTokens: output }),
      ...(inputModalities === undefined || inputModalities.length === 0 ? {} : { inputModalities }),
      ...(outputModalities === undefined || outputModalities.length === 0 ? {} : { outputModalities }),
    })
  }
  return configs
}

function clampOptionalInt(value: unknown, min: number, max: number): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function normalizeToolPermissions(value: Record<string, unknown>): Record<string, ToolPermission> {
  const allowed: readonly string[] = ['allow', 'ask', 'deny']
  const result: Record<string, ToolPermission> = {}
  for (const [name, permission] of Object.entries(value)) {
    if (name.trim() && typeof permission === 'string' && allowed.includes(permission)) {
      result[name] = permission as ToolPermission
    }
  }
  return result
}

function normalizeProfileAdvanced(value: Record<string, unknown>): ApiProfileAdvancedSettings {
  return {
    contextWindowTokens: nullableInt(value.contextWindowTokens, DEFAULT_API_PROFILE_ADVANCED.contextWindowTokens),
    maxOutputTokens: nullableInt(value.maxOutputTokens, DEFAULT_API_PROFILE_ADVANCED.maxOutputTokens),
    temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature)
      ? Math.min(2, Math.max(0, value.temperature))
      : DEFAULT_API_PROFILE_ADVANCED.temperature,
    requestTimeoutMs: boundedInt(value.requestTimeoutMs, DEFAULT_API_PROFILE_ADVANCED.requestTimeoutMs, 5_000, 600_000),
    maxTokensParameter: value.maxTokensParameter === 'max_tokens'
      || value.maxTokensParameter === 'max_completion_tokens'
      || value.maxTokensParameter === 'omit'
      ? value.maxTokensParameter
      : 'auto',
    sendReasoningEffort: value.sendReasoningEffort === 'on' || value.sendReasoningEffort === 'off'
      ? value.sendReasoningEffort
      : 'auto',
    sendStreamOptions: typeof value.sendStreamOptions === 'boolean'
      ? value.sendStreamOptions
      : DEFAULT_API_PROFILE_ADVANCED.sendStreamOptions
  }
}

function normalizeExecutionSettings(value: Record<string, unknown>): ExecutionSettings {
  return {
    maxToolRounds: boundedInt(value.maxToolRounds, DEFAULT_EXECUTION_SETTINGS.maxToolRounds, 1, 64),
    compactionEnabled: typeof value.compactionEnabled === 'boolean'
      ? value.compactionEnabled
      : DEFAULT_EXECUTION_SETTINGS.compactionEnabled,
    compactionTriggerRatio: boundedNumber(
      value.compactionTriggerRatio,
      DEFAULT_EXECUTION_SETTINGS.compactionTriggerRatio,
      0.5,
      0.98,
    ),
    compactKeepRecentFrames: boundedInt(
      value.compactKeepRecentFrames,
      DEFAULT_EXECUTION_SETTINGS.compactKeepRecentFrames,
      0,
      20,
    ),
    compactMaxTranscriptChars: boundedInt(
      value.compactMaxTranscriptChars,
      DEFAULT_EXECUTION_SETTINGS.compactMaxTranscriptChars,
      2_000,
      200_000,
    ),
    historyMode: value.historyMode === 'fixed' ? 'fixed' : 'auto',
    historyMessageLimit: nullableInt(value.historyMessageLimit, DEFAULT_EXECUTION_SETTINGS.historyMessageLimit),
    toolResultMode: value.toolResultMode === 'fixed' ? 'fixed' : 'auto',
    toolResultMaxChars: nullableInt(value.toolResultMaxChars, DEFAULT_EXECUTION_SETTINGS.toolResultMaxChars),
    plannerMaxAttempts: boundedInt(value.plannerMaxAttempts, DEFAULT_EXECUTION_SETTINGS.plannerMaxAttempts, 1, 5),
    plannerMaxSteps: boundedInt(value.plannerMaxSteps, DEFAULT_EXECUTION_SETTINGS.plannerMaxSteps, 1, 32),
    plannerMaxTokens: nullableInt(value.plannerMaxTokens, DEFAULT_EXECUTION_SETTINGS.plannerMaxTokens),
    verifierMaxAttempts: boundedInt(value.verifierMaxAttempts, DEFAULT_EXECUTION_SETTINGS.verifierMaxAttempts, 1, 5),
    verifierMaxEvidence: boundedInt(value.verifierMaxEvidence, DEFAULT_EXECUTION_SETTINGS.verifierMaxEvidence, 2, 50),
    maxTaskReplans: boundedInt(value.maxTaskReplans, DEFAULT_EXECUTION_SETTINGS.maxTaskReplans, 0, 16)
  }
}

function normalizeStorageSettings(value: Record<string, unknown>): StorageSettings {
  return {
    maxSessions: boundedInt(value.maxSessions, DEFAULT_STORAGE_SETTINGS.maxSessions, 0, 10_000),
    maxMessagesPerSession: boundedInt(
      value.maxMessagesPerSession,
      DEFAULT_STORAGE_SETTINGS.maxMessagesPerSession,
      0,
      10_000,
    )
  }
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function nullableInt(value: unknown, fallback: number | null): number | null {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.trunc(parsed)
}

export function normalizeStatus(value: unknown): NavisworksStatus {
  const source = asRecord(value)
  const connected = Boolean(source.connected ?? source.isConnected ?? source.Connected)
  const documentInstanceId =
    typeof source.documentInstanceId === 'string' && source.documentInstanceId.trim()
      ? source.documentInstanceId
      : undefined
  const bridgeSessionId =
    typeof source.bridgeSessionId === 'string' && source.bridgeSessionId.trim()
      ? source.bridgeSessionId
      : undefined
  return {
    connected,
    status: String(source.status ?? source.label ?? (connected ? '已连接' : '未连接')),
    documentName:
      typeof (source.documentName ?? source.activeDocument) === 'string'
        ? String(source.documentName ?? source.activeDocument)
        : undefined,
    selectionCount:
      typeof source.selectionCount === 'number' ? source.selectionCount : undefined,
    ...(documentInstanceId === undefined ? {} : { documentInstanceId }),
    ...(bridgeSessionId === undefined ? {} : { bridgeSessionId })
  }
}

export function displayValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** IPC usage payload: keep only well-reported numbers (absent ≠ 0). */
export function normalizeModelUsage(value: unknown): ModelUsage | undefined {
  const usage = asRecord(value)
  const result: ModelUsage = {}
  for (const key of [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ] as const) {
    const field = usage[key]
    if (typeof field === 'number' && Number.isFinite(field) && field >= 0) {
      result[key] = field
    }
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/** All ModelMetadataSourceId values the wire may carry (kept as a plain array
 *  so the membership test below type-checks without an `includes` narrowing). */
const MODEL_METADATA_SOURCES: readonly ModelMetadataSourceId[] = [
  'local', 'profile', 'provider', 'model', 'unknown',
]

/**
 * Active ModelInfo from `model.info.get`. Malformed / missing pieces degrade
 * field by field — the UI must still render with an honest empty metadata set
 * rather than crash or invent values.
 */
export function normalizeModelInfo(value: unknown): ModelInfo | null {
  const source = asRecord(value)
  const ref = asRecord(source.ref)
  const providerId = typeof ref.providerId === 'string' ? ref.providerId : ''
  const modelId = typeof ref.modelId === 'string' ? ref.modelId : ''
  if (!providerId || !modelId) return null
  const provider = asRecord(source.provider)
  const capabilities = asRecord(source.capabilities)
  const limits = asRecord(source.limits)
  const reasoning = asRecord(source.reasoning)
  const rawModes = Array.isArray(reasoning.modes) ? reasoning.modes : []
  const modes = rawModes.filter((mode): mode is ReasoningEffort =>
    REASONING_EFFORTS.includes(mode as ReasoningEffort))
  const positiveInt = (field: unknown): number | undefined =>
    typeof field === 'number' && Number.isFinite(field) && field > 0 ? field : undefined
  const optionalBool = (field: unknown): boolean | undefined =>
    typeof field === 'boolean' ? field : undefined
  return {
    ref: { providerId, modelId },
    displayName: typeof source.displayName === 'string' && source.displayName.trim()
      ? source.displayName
      : modelId,
    provider: {
      id: providerId,
      displayName: typeof provider.displayName === 'string' ? provider.displayName : providerId,
      kind: provider.kind === 'ollama' ? 'ollama' : 'openai-compatible',
    },
    capabilities: (() => {
      const tools = optionalBool(capabilities.tools)
      const reasoning = optionalBool(capabilities.reasoning)
      const temperature = optionalBool(capabilities.temperature)
      const attachments = optionalBool(capabilities.attachments)
      return {
        ...(tools === undefined ? {} : { tools }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(temperature === undefined ? {} : { temperature }),
        ...(attachments === undefined ? {} : { attachments }),
      }
    })(),
    limits: (() => {
      const context = positiveInt(limits.context)
      const input = positiveInt(limits.input)
      const output = positiveInt(limits.output)
      return {
        ...(context === undefined ? {} : { context }),
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
      }
    })(),
    reasoning: {
      modes,
      ...(reasoning.requestPolicy === 'auto' || reasoning.requestPolicy === 'on' || reasoning.requestPolicy === 'off'
        ? { requestPolicy: reasoning.requestPolicy }
        : {}),
    },
    // Model Configuration v2 (§22): 'model' must be preserved here. This
    // whitelist previously omitted it, so a per-model override resolved by main
    // was coerced to 'unknown' → Composer hid the known window → the ring fell
    // back to "Auto". Accept every known ModelMetadataSourceId value.
    metadataSource: MODEL_METADATA_SOURCES.includes(source.metadataSource as ModelMetadataSourceId)
      ? source.metadataSource as ModelMetadataSourceId
      : 'unknown',
  }
}
