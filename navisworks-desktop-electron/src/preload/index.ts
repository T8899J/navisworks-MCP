import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  DesktopIpcError,
  type IpcEnvelope,
  type IpcErrorPayload
} from '../shared/ipc/errors'
import {
  IPC_EVENT_CHANNEL,
  IPC_REQUEST_CHANNEL,
  type DesktopApi
} from '../shared/ipc/contracts'
import type {
  DesktopEventName,
  EventPayload,
  InputFor,
  IpcRoute,
  OutputFor
} from '../shared/ipc/schemas'

const allowedRoutes = new Set<IpcRoute>([
  'app.runtime.get',
  'sessions.list',
  'sessions.get',
  'sessions.save',
  'sessions.delete',
  'sessions.summarizeTitle',
  'settings.get',
  'settings.update',
  'api.profile.save',
  'api.profile.delete',
  'api.profile.models.list',
  'api.profile.connection.test',
  'appearance.get',
  'appearance.update',
  'ollama.models.list',
  'ollama.connection.test',
  'chat.start',
  'chat.abort',
  'tool.approval.resolve',
  'chat.compact',
  'navisworks.status.get',
  'navisworks.instances.list',
  'navisworks.instance.select',
  'navisworks.tool.execute'
])

const allowedEvents = new Set<DesktopEventName>([
  'chat.chunk',
  'chat.done',
  'chat.error',
  'tool.approval.requested',
  'navisworks.status.changed',
  'navisworks.instances.changed',
  'nativeTheme.updated'
])

function isErrorPayload(value: unknown): value is IpcErrorPayload {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.code === 'string' && typeof candidate.message === 'string'
}

function unwrapEnvelope<T>(value: unknown): T {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    throw new DesktopIpcError('INTERNAL', 'Desktop IPC returned a malformed response')
  }

  const envelope = value as IpcEnvelope<T>
  if (envelope.ok === true && 'data' in envelope) return envelope.data
  if (envelope.ok === false && 'error' in envelope && isErrorPayload(envelope.error)) {
    throw new DesktopIpcError(envelope.error.code, envelope.error.message, envelope.error.details)
  }

  throw new DesktopIpcError('INTERNAL', 'Desktop IPC returned a malformed response')
}

async function request<R extends IpcRoute>(route: R, input?: InputFor<R>): Promise<OutputFor<R>> {
  if (!allowedRoutes.has(route)) {
    throw new DesktopIpcError('ROUTE_NOT_FOUND', `Unknown desktop route: ${String(route)}`)
  }
  const rawEnvelope = await ipcRenderer.invoke(IPC_REQUEST_CHANNEL, route, input)
  return unwrapEnvelope<OutputFor<R>>(rawEnvelope)
}

function subscribe<E extends DesktopEventName>(
  event: E,
  listener: (payload: EventPayload<E>) => void
): () => void {
  if (!allowedEvents.has(event)) {
    throw new DesktopIpcError('ROUTE_NOT_FOUND', `Unknown desktop event: ${String(event)}`)
  }
  if (typeof listener !== 'function') {
    throw new DesktopIpcError('VALIDATION_FAILED', `Listener for ${event} must be a function`)
  }

  const handler = (_ipcEvent: IpcRendererEvent, emittedEvent: unknown, payload: unknown): void => {
    if (emittedEvent !== event) return
    listener(payload as EventPayload<E>)
  }

  ipcRenderer.on(IPC_EVENT_CHANNEL, handler)
  return () => ipcRenderer.removeListener(IPC_EVENT_CHANNEL, handler)
}

const desktopApi: DesktopApi = {
  request: request as DesktopApi['request'],
  subscribe
}

if (!process.contextIsolated) {
  throw new Error('Navisworks MCP Desktop requires Electron context isolation')
}

contextBridge.exposeInMainWorld('desktop', desktopApi)
