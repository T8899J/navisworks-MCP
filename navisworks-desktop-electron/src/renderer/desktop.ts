import type { DesktopApi, DesktopEventName } from '../shared/ipc'
import type { NavisworksConnectionState, RuntimeInfo } from '../shared/ipc'
import type { ReasoningEffort } from '../shared/reasoning'
import {
  type ChatSession,
  type ChatStreamEvent,
  type DesktopSettings,
  type NavisworksStatus,
  type SessionSummary,
  type ToolApprovalRequest,
  normalizeSession,
  normalizeSettings,
  normalizeStatus,
  normalizeSummary
} from './chatTypes'

function api(): DesktopApi | undefined {
  return (window as unknown as { desktop?: DesktopApi }).desktop
}

function requireApi(): DesktopApi {
  const desktop = api()
  if (!desktop) throw new Error('桌面服务尚未连接，请通过 Electron 主进程启动应用。')
  return desktop
}

export const desktopGateway = {
  isAvailable(): boolean {
    return Boolean(api())
  },

  async windowControl(action: 'minimize' | 'toggle-maximize' | 'close'): Promise<void> {
    await requireApi().request('window.control', { action })
  },

  async listSessions(): Promise<SessionSummary[]> {
    const response = await requireApi().request('sessions.list')
    return response.map(normalizeSummary)
  },

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    return requireApi().request('app.runtime.get')
  },

  async getSession(sessionId: string): Promise<ChatSession> {
    const response = await requireApi().request('sessions.get', { sessionId })
    if (!response) throw new Error('会话不存在或已经删除。')
    return normalizeSession(response)
  },

  async saveSession(session: ChatSession): Promise<void> {
    await requireApi().request('sessions.save', { session })
  },

  /** Model-generated conversation title; never throws — falls back inside IPC. */
  async suggestSessionTitle(text: string): Promise<string> {
    const response = await requireApi().request('sessions.summarizeTitle', { text })
    return response.title
  },

  async deleteSession(sessionId: string): Promise<void> {
    await requireApi().request('sessions.delete', { sessionId })
  },

  async getSettings(): Promise<DesktopSettings> {
    return normalizeSettings(await requireApi().request('settings.get'))
  },

  async updateSettings(settings: Partial<DesktopSettings>): Promise<DesktopSettings> {
    return normalizeSettings(await requireApi().request('settings.update', { settings }))
  },

  async saveApiProfile(input: {
    id?: string
    name: string
    baseUrl: string
    model: string
    apiKey?: string
    clearApiKey?: boolean
  }): Promise<DesktopSettings> {
    return normalizeSettings(await requireApi().request('api.profile.save', input))
  },

  async deleteApiProfile(profileId: string): Promise<DesktopSettings> {
    return normalizeSettings(await requireApi().request('api.profile.delete', { profileId }))
  },

  async listApiProfileModels(profileId: string): Promise<string[]> {
    return [...await requireApi().request('api.profile.models.list', { profileId })]
  },

  async testApiProfile(profileId: string): Promise<{ connected: boolean; message: string }> {
    return requireApi().request('api.profile.connection.test', { profileId })
  },

  async compactSession(sessionId: string): Promise<{ summary: string }> {
    const response = await requireApi().request('chat.compact', { sessionId })
    return response as { summary: string }
  },

  async listModels(endpoint?: { baseUrl?: string; apiKey?: string }): Promise<string[]> {
    return [...await requireApi().request('ollama.models.list', endpoint)]
  },

  async testOllama(
    model?: string,
    endpoint?: { baseUrl?: string; apiKey?: string }
  ): Promise<{ connected: boolean; message: string }> {
    const input: Record<string, string> = {}
    if (model) input.model = model
    if (endpoint?.baseUrl) input.baseUrl = endpoint.baseUrl
    if (endpoint?.apiKey) input.apiKey = endpoint.apiKey
    return requireApi().request('ollama.connection.test', Object.keys(input).length > 0 ? input : undefined)
  },

  async getNavisworksStatus(): Promise<NavisworksStatus> {
    return normalizeStatus(await requireApi().request('navisworks.status.get'))
  },

  async getNavisworksInstances(): Promise<NavisworksConnectionState> {
    return requireApi().request('navisworks.instances.list')
  },

  async selectNavisworksInstance(instanceId: string): Promise<NavisworksConnectionState> {
    return requireApi().request('navisworks.instance.select', { instanceId })
  },

  async startChat(payload: {
    sessionId: string
    messageId: string
    text: string
    model: string
    reasoningMode: ReasoningEffort
  }): Promise<{ turnId?: string }> {
    const response = await requireApi().request('chat.start', payload)
    return { turnId: response.turnId }
  },

  async abortChat(sessionId: string, turnId?: string): Promise<void> {
    await requireApi().request('chat.abort', { sessionId, ...(turnId ? { turnId } : {}) })
  },

  async resolveToolApproval(
    approvalId: string,
    decision: 'confirm' | 'cancel'
  ): Promise<boolean> {
    const response = await requireApi().request('tool.approval.resolve', { approvalId, decision })
    return response.resolved
  },

  subscribe(
    event: DesktopEventName,
    listener: (
      event: ChatStreamEvent | NavisworksStatus | NavisworksConnectionState | ToolApprovalRequest
    ) => void
  ): () => void {
    const desktop = api()
    if (!desktop) return () => undefined
    return desktop.subscribe(event, listener as never)
  }
}
