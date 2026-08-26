import type { DesktopApi, DesktopEventName } from '../shared/ipc'
import type { RuntimeInfo } from '../shared/ipc'
import {
  type ChatSession,
  type ChatStreamEvent,
  type DesktopSettings,
  type NavisworksStatus,
  type SessionSummary,
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

  async deleteSession(sessionId: string): Promise<void> {
    await requireApi().request('sessions.delete', { sessionId })
  },

  async getSettings(): Promise<DesktopSettings> {
    return normalizeSettings(await requireApi().request('settings.get'))
  },

  async updateSettings(settings: Partial<DesktopSettings>): Promise<DesktopSettings> {
    return normalizeSettings(await requireApi().request('settings.update', { settings }))
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

  async startChat(payload: {
    sessionId: string
    messageId: string
    text: string
    model: string
    reasoningMode: 'fast' | 'deep'
  }): Promise<{ turnId?: string }> {
    const response = await requireApi().request('chat.start', payload)
    return { turnId: response.turnId }
  },

  async abortChat(sessionId: string, turnId?: string): Promise<void> {
    await requireApi().request('chat.abort', { sessionId, ...(turnId ? { turnId } : {}) })
  },

  subscribe(event: DesktopEventName, listener: (event: ChatStreamEvent | NavisworksStatus) => void): () => void {
    const desktop = api()
    if (!desktop) return () => undefined
    return desktop.subscribe(event, listener as never)
  }
}
