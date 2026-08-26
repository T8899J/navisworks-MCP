import { toolNameSchema, type ToolName } from '../shared/ipc'

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
}

export interface DesktopSettings {
  selectedModel: string
  models: string[]
  reasoningMode: 'fast' | 'deep'
  themeMode: 'system' | 'light' | 'dark'
  disabledTools: ToolName[]
  fontScale: number
  providerEnabled: boolean
  providerBaseUrl: string
  providerApiKey: string
}

export interface NavisworksStatus {
  connected: boolean
  status: string
  documentName?: string
  selectionCount?: number
}

export interface ChatStreamEvent {
  sessionId: string
  turnId?: string
  messageId?: string
  kind: 'thinking' | 'text' | 'tool-start' | 'tool-result' | 'done' | 'error'
  text?: string
  delta?: string
  content?: string
  thinkingText?: string
  toolCallId?: string
  toolName?: string
  arguments?: unknown
  result?: unknown
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

  return {
    ...summary,
    messages: rawMessages.map(normalizeMessage),
    contextTokensUsed: Number(source.contextTokensUsed ?? source.ContextTokensUsed ?? 0)
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

  return {
    selectedModel,
    models,
    reasoningMode: String(source.reasoningMode ?? source.ReasoningMode).toLowerCase() === 'deep' ? 'deep' : 'fast',
    themeMode: source.themeMode === 'light' || source.themeMode === 'dark' ? source.themeMode : 'system',
    disabledTools: toolNameSchema.options.filter((name) => rawDisabled.has(name)),
    fontScale: Number.isFinite(rawFontScale) ? Math.min(1.3, Math.max(0.85, rawFontScale)) : 1,
    providerEnabled: Boolean(source.providerEnabled ?? source.ProviderEnabled ?? true),
    providerBaseUrl: String(source.providerBaseUrl ?? source.ProviderBaseUrl ?? ''),
    providerApiKey: String(source.providerApiKey ?? source.ProviderApiKey ?? '')
  }
}

export function normalizeStatus(value: unknown): NavisworksStatus {
  const source = asRecord(value)
  const connected = Boolean(source.connected ?? source.isConnected ?? source.Connected)
  return {
    connected,
    status: String(source.status ?? source.label ?? (connected ? '已连接' : '未连接')),
    documentName:
      typeof (source.documentName ?? source.activeDocument) === 'string'
        ? String(source.documentName ?? source.activeDocument)
        : undefined,
    selectionCount:
      typeof source.selectionCount === 'number' ? source.selectionCount : undefined
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
