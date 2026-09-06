import {
  DEFAULT_API_PROFILE_ADVANCED,
  DEFAULT_EXECUTION_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  toolNameSchema,
  type ApiProfile,
  type ApiProfileAdvancedSettings,
  type ContextWindowSource,
  type ExecutionSettings,
  type NavisworksInstanceSummary,
  type StorageSettings,
  type ToolApprovalRequest,
  type ToolName,
} from '../shared/ipc'
import { normalizeReasoningEffort, type ReasoningEffort } from '../shared/reasoning'

export type { ApiProfile, ContextWindowSource, ToolApprovalRequest }
export type { ReasoningEffort }

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
  /** Run-scoped agent execution policy (执行设置页). */
  execution: ExecutionSettings
  /** Disk-history retention. */
  storage: StorageSettings
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

export type ChatRunPhase = 'generating' | 'verifying'

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
  cacheHitRate?: number
  /** Finite context window the finished run budgeted against. */
  contextWindowTokens?: number
  /** Where that window came from ('fallback' = safety budget, NOT a model limit). */
  contextWindowSource?: ContextWindowSource
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

  const rawDisabled = new Set<string>(
    (Array.isArray(source.disabledTools)
      ? source.disabledTools
      : Array.isArray(source.DisabledTools)
        ? source.DisabledTools
        : []).map(String)
  )

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
      hasApiKey: Boolean(profile.hasApiKey),
      advanced: normalizeProfileAdvanced(rawAdvanced)
    }
  })

  return {
    selectedModel,
    models,
    reasoningMode: normalizeReasoningEffort(source.reasoningMode ?? source.ReasoningMode),
    themeMode: source.themeMode === 'light' || source.themeMode === 'dark' ? source.themeMode : 'system',
    disabledTools: toolNameSchema.options.filter((name) => rawDisabled.has(name)),
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
    execution: normalizeExecutionSettings(asRecord(source.execution ?? {})),
    storage: normalizeStorageSettings(asRecord(source.storage ?? {}))
  }
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
