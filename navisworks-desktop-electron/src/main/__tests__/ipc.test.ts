import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({ mockedWindow: true })),
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  ChatRunRegistry,
  PersistenceFacade,
  registerDesktopIpc,
  ToolApprovalRegistry,
  type DesktopIpcDependencies,
  type OllamaAgentPort,
} from '../ipc'
import type {
  IpcEnvelope,
  InputFor,
  Session,
} from '../../shared/ipc'
import type {
  ConversationSession,
  JsonSessionRepository,
  JsonSettingsRepository,
} from '../sessionRepository'
import type { NavisworksBridgeClient } from '../bridgeClient'
import type { ToolCatalog } from '../toolCatalog'
import { ContextState } from '../agent/contextState'
import type { AgentScopeManager } from '../kernel/agentScopes'
import type { NavisworksInstanceRegistry } from '../navisworks/instanceRegistry'
import { NavisworksInstanceSelection } from '../navisworks/instanceSelection'
import type { DiscoveredNavisworksInstance } from '../navisworks/instanceTypes'

const DEV_ORIGIN = 'http://localhost:5173'

beforeEach(() => {
  vi.clearAllMocks()
})

function cloneSession(session: ConversationSession): ConversationSession {
  return structuredClone(session)
}

function persistedSession(id: string): ConversationSession {
  return {
    id,
    title: `会话 ${id}`,
    preview: '',
    updatedAt: '2026-08-24T00:00:00.000Z',
    messages: [],
    contextTokensUsed: 0,
    pinnedAt: null,
  }
}

function desktopSession(id: string): Session {
  return {
    id,
    title: `会话 ${id}`,
    preview: '',
    updatedAt: '2026-08-24T00:00:00.000Z',
    messages: [],
  }
}

interface SessionStore {
  state: { sessions: ConversationSession[]; failSave: boolean }
  load(): Promise<{ sessions: ConversationSession[]; source: 'primary'; canPersist: boolean }>
  save(sessions: readonly ConversationSession[]): Promise<boolean>
}

function createSessionStore(initial: ConversationSession[] = []): SessionStore {
  const state = {
    sessions: initial.map(cloneSession),
    failSave: false,
  }
  return {
    state,
    async load() {
      return { sessions: state.sessions.map(cloneSession), source: 'primary', canPersist: true }
    },
    async save(sessions) {
      if (state.failSave) return false
      state.sessions = sessions.map(cloneSession)
      return true
    },
  }
}

function settingsStub(): JsonSettingsRepository {
  return {
    async load() {
      return null
    },
    async save() {
      return true
    },
  } as unknown as JsonSettingsRepository
}

function statefulSettingsStub(initial: Record<string, unknown>): JsonSettingsRepository {
  let stored: unknown = initial
  return {
    async load() {
      return stored
    },
    async save(next: unknown) {
      stored = next
      return true
    },
  } as unknown as JsonSettingsRepository
}

function createFacade(store: SessionStore): PersistenceFacade {
  return new PersistenceFacade(
    store as unknown as JsonSessionRepository,
    settingsStub(),
  )
}

function chatStartInput(sessionId = 'session-a'): InputFor<'chat.start'> {
  return { sessionId, messageId: 'message-1', text: '你好' }
}

/**
 * A promise that rejects once the run's abort signal fires, mirroring how a
 * real fetch-based agent throws on cancellation. Await it inside try/catch to
 * model an agent that observes the cancel and unwinds gracefully.
 */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('The operation was aborted'))
      return
    }
    signal.addEventListener('abort', () => {
      reject(signal.reason ?? new Error('The operation was aborted'))
    }, { once: true })
  })
}

function stubAgent(): OllamaAgentPort {
  return {
    async listModels() {
      return []
    },
    async testConnection() {
      return { connected: true, message: '' }
    },
    async run() {
      return { content: '' }
    },
  }
}

function fakeSender(): WebContents {
  const events = new EventEmitter()
  return {
    id: 1,
    isDestroyed: () => false,
    send: vi.fn(),
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
  } as unknown as WebContents
}

const TRUSTED_EVENT = {
  sender: {
    id: 1,
    isDestroyed: () => false,
    getType: () => 'window',
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
  senderFrame: { parent: null, url: `${DEV_ORIGIN}/` },
} as unknown as IpcMainInvokeEvent

interface IpcHarness {
  store: SessionStore
  invoke(route: string, input?: unknown): Promise<IpcEnvelope<unknown>>
  dispose(): Promise<void>
}

function createHarness(options: {
  ollama: OllamaAgentPort
  store?: SessionStore
  settings?: JsonSettingsRepository
  secrets?: { encrypt(value: string): string; decrypt(value: string): string }
  bridge?: NavisworksBridgeClient
  tools?: ToolCatalog
  instanceRegistry?: NavisworksInstanceRegistry
  instanceSelection?: NavisworksInstanceSelection
}): IpcHarness {
  const store = options.store ?? createSessionStore()
  const dependencies: DesktopIpcDependencies = {
    runtimeInfo: {
      version: '0.0.0-test',
      platform: 'win32',
      isPackaged: false,
      dataDirectory: 'C:\\temp\\navisworks-desktop-test',
      profile: 'Debug',
    },
    sessions: store as unknown as JsonSessionRepository,
    settings: options.settings ?? settingsStub(),
    bridge: options.bridge ?? ({} as NavisworksBridgeClient),
    tools: options.tools ?? ({ assertAllowed: () => undefined, get: () => undefined } as unknown as ToolCatalog),
    ollama: options.ollama,
    appearance: {
      getState: () => ({ themeMode: 'system', effectiveTheme: 'light' }),
      setThemeMode: (themeMode) => ({ themeMode, effectiveTheme: 'light' }),
    },
    senderTrust: { isPackaged: false, rendererRoot: 'D:\\app\\renderer', devServerUrl: DEV_ORIGIN },
    toolApprovals: new ToolApprovalRegistry(),
    secrets: options.secrets,
    instanceRegistry: options.instanceRegistry,
    instanceSelection: options.instanceSelection,
  }

  const dispose = registerDesktopIpc(dependencies)
  const dispatchEntry = vi.mocked(ipcMain.handle).mock.calls.at(-1)
  if (!dispatchEntry) throw new Error('ipcMain.handle was not registered')
  const dispatch = dispatchEntry[1] as (
    event: unknown,
    route: unknown,
    input: unknown,
  ) => Promise<IpcEnvelope<unknown>>

  return {
    store,
    invoke: (route, input) => dispatch(TRUSTED_EVENT, route, input),
    dispose,
  }
}

describe('Navisworks instance IPC selection', () => {
  it('keeps A selected when B appears and changes to B only on explicit selection', async () => {
    const instanceA = discoveredInstance('instance-a', 12340, 'Model-A.nwf')
    const instanceB = discoveredInstance('instance-b', 18120, 'Model-B.nwf')
    let refreshCount = 0
    let current = [instanceA]
    const summaries = () => current.map((instance) => ({ ...instance }))
    const registry = {
      get instances() { return summaries() },
      async refresh() {
        refreshCount += 1
        current = refreshCount === 1 ? [instanceA] : [instanceA, instanceB]
        return summaries()
      },
      get(instanceId: string) {
        return current.find((instance) => instance.instanceId === instanceId)
      },
    } as unknown as NavisworksInstanceRegistry
    const harness = createHarness({
      ollama: stubAgent(),
      instanceRegistry: registry,
      instanceSelection: new NavisworksInstanceSelection(),
    })
    try {
      const first = await harness.invoke('navisworks.instances.list', undefined)
      expect(first).toMatchObject({ ok: true, data: { selectedInstanceId: 'instance-a' } })

      const second = await harness.invoke('navisworks.instances.list', undefined)
      expect(second).toMatchObject({
        ok: true,
        data: { selectedInstanceId: 'instance-a', instances: expect.arrayContaining([
          expect.objectContaining({ instanceId: 'instance-a' }),
          expect.objectContaining({ instanceId: 'instance-b' }),
        ]) },
      })
      expect(JSON.stringify(second)).not.toContain('pipeName')

      const selected = await harness.invoke('navisworks.instance.select', { instanceId: 'instance-b' })
      expect(selected).toMatchObject({ ok: true, data: { selectedInstanceId: 'instance-b' } })
    } finally {
      await harness.dispose()
    }
  })
})

function discoveredInstance(
  instanceId: string,
  processId: number,
  documentName: string,
): DiscoveredNavisworksInstance {
  const pipeName = `pipe-${processId}`
  return {
    instanceId,
    processId,
    pipeName,
    bridgeSessionId: instanceId,
    documentInstanceId: `doc-${processId}`,
    documentName,
    pluginVersion: '1.0.0',
    hostVersion: '2023',
    startedAtUtc: '2026-09-01T00:00:00Z',
    connected: true,
    lastSeenAt: 1,
    endpoint: {
      ProtocolVersion: 1,
      PipeName: pipeName,
      ProcessId: processId,
      PluginVersion: '1.0.0',
      HostVersion: '2023',
      StartedAtUtc: '2026-09-01T00:00:00Z',
    },
  }
}

describe('ChatRunRegistry.abortAndWait', () => {
  it('refreshes immediately, binds the selected instance, and ignores a later selection change', async () => {
    const instanceA = discoveredInstance('instance-a', 12340, 'Model-A.nwf')
    const instanceB = discoveredInstance('instance-b', 18120, 'Model-B.nwf')
    const instances = [instanceA, instanceB]
    const registry = {
      get instances() { return instances.map((instance) => ({ ...instance })) },
      refresh: vi.fn(async () => instances.map((instance) => ({ ...instance }))),
      get(instanceId: string) { return instances.find((instance) => instance.instanceId === instanceId) },
    } as unknown as NavisworksInstanceRegistry
    const selection = new NavisworksInstanceSelection()
    selection.observe([instanceA])
    const bridge = {
      async callToEndpoint<T>(_endpoint: unknown, method: string): Promise<T> {
        if (method !== 'navisworks_status') throw new Error('unexpected method')
        return {
          connected: true,
          bridgeSessionId: 'instance-a',
          documentInstanceId: 'doc-12340',
          documentTitle: 'Model-A.nwf',
        } as T
      },
    } as unknown as NavisworksBridgeClient
    const inputs: Array<Record<string, unknown>> = []
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(input) {
        inputs.push(input as unknown as Record<string, unknown>)
        selection.select('instance-b', instances)
        return { content: '完成。' }
      },
    }
    const createRun = vi.fn(async (
      _runId: string,
      _sessionId: string,
      _documentInstanceId?: string | null,
    ) => ({ dispose: vi.fn(async () => undefined) }))
    const registryUnderTest = new ChatRunRegistry(
      agent,
      createFacade(createSessionStore()),
      new ToolApprovalRegistry(),
      { createRun } as unknown as AgentScopeManager,
      new ContextState(),
      async () => ({ connected: false, status: 'legacy must not be used' }),
      registry,
      selection,
      bridge,
    )
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>

    registryUnderTest.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.some((call) => call[1] === 'chat.done')).toBe(true))

    expect(registry.refresh).toHaveBeenCalledTimes(1)
    expect(createRun.mock.calls[0]?.[2]).toBe('doc-12340')
    expect(inputs[0]?.navisworksBinding).toMatchObject({
      instanceId: 'instance-a',
      pipeName: 'pipe-12340',
      documentInstanceId: 'doc-12340',
    })
    expect(selection.selectedInstanceId).toBe('instance-b')
    expect((inputs[0]?.navisworksBinding as { instanceId: string }).instanceId).toBe('instance-a')
  })

  it('escapes within the timeout when the agent ignores the abort signal', async () => {
    const signals: AbortSignal[] = []
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(_input, { signal }) {
        signals.push(signal)
        await new Promise<void>(() => {}) // wedged: never observes the signal
        return { content: '' }
      },
    }
    const registry = new ChatRunRegistry(agent, createFacade(createSessionStore()))
    registry.start(chatStartInput(), fakeSender())
    await vi.waitFor(() => expect(signals).toHaveLength(1))

    const startedAt = Date.now()
    await expect(registry.abortAndWait('session-a', 30)).resolves.toBe(true)

    expect(signals[0]?.aborted).toBe(true)
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(20)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('waits for a cooperative run to finish unwinding before returning', async () => {
    let started = false
    let finished = false
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(_input, { signal }) {
        started = true
        try {
          await abortPromise(signal)
        } catch {
          // Cancelled: unwind gracefully like a fetch-based agent would.
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 60)
        })
        finished = true
        return { content: '' }
      },
    }
    const registry = new ChatRunRegistry(agent, createFacade(createSessionStore()))
    registry.start(chatStartInput(), fakeSender())
    await vi.waitFor(() => expect(started).toBe(true))

    await expect(registry.abortAndWait('session-a')).resolves.toBe(true)
    expect(finished).toBe(true)
    // The settled run must have left the registry.
    await expect(registry.abortAndWait('session-a')).resolves.toBe(false)
  })

  it('reports false when the session has no active runs', async () => {
    const registry = new ChatRunRegistry(stubAgent(), createFacade(createSessionStore()))
    await expect(registry.abortAndWait('missing-session')).resolves.toBe(false)
  })

  it('aborts every run belonging to the session', async () => {
    const signals: AbortSignal[] = []
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(_input, { signal }) {
        signals.push(signal)
        await abortPromise(signal)
        return { content: '' }
      },
    }
    const registry = new ChatRunRegistry(agent, createFacade(createSessionStore()))
    registry.start(chatStartInput(), fakeSender())
    registry.start(chatStartInput(), fakeSender())
    await vi.waitFor(() => expect(signals).toHaveLength(2))

    await expect(registry.abortAndWait('session-a')).resolves.toBe(true)
    expect(signals).toHaveLength(2)
    for (const signal of signals) expect(signal.aborted).toBe(true)
  })

  it('preflights Navisworks before createRun and binds an immediate A to B switch to B', async () => {
    const contextState = new ContextState()
    const statuses = [
      { connected: true, status: 'A', documentName: 'Model-A.nwf', documentInstanceId: 'doc-A', bridgeSessionId: 'bridge-1' },
      { connected: true, status: 'B', documentName: 'Model-B.nwf', documentInstanceId: 'doc-B', bridgeSessionId: 'bridge-1' },
    ]
    const readStatus = vi.fn(async () => statuses.shift()!)
    const createRun = vi.fn(async (
      _runId: string,
      _sessionId: string,
      _documentInstanceId?: string | null,
    ) => ({ dispose: vi.fn(async () => undefined) }))
    const scopeManager = { createRun } as unknown as AgentScopeManager
    const inputs: Array<Record<string, unknown>> = []
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(input) {
        inputs.push(input as unknown as Record<string, unknown>)
        return { content: '完成。' }
      },
    }
    const registry = new ChatRunRegistry(
      agent,
      createFacade(createSessionStore()),
      new ToolApprovalRegistry(),
      scopeManager,
      contextState,
      readStatus,
    )
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>

    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.filter((call) => call[1] === 'chat.done')).toHaveLength(1))
    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.filter((call) => call[1] === 'chat.done')).toHaveLength(2))

    expect(createRun.mock.calls[1]?.[2]).toBe('doc-B')
    expect(inputs[1]?.currentDocument).toMatchObject({
      documentName: 'Model-B.nwf',
      documentInstanceId: 'doc-B',
    })
    expect(inputs[1]?.documentNotice).toMatchObject({
      previous: { documentName: 'Model-A.nwf', documentInstanceId: 'doc-A' },
      current: { documentName: 'Model-B.nwf', documentInstanceId: 'doc-B' },
    })
    expect(readStatus.mock.invocationCallOrder[1]).toBeLessThan(createRun.mock.invocationCallOrder[1]!)
  })

  it('keeps a transition pending after failure and marks it seen only after success', async () => {
    const contextState = new ContextState()
    const statuses = [
      { connected: true, status: 'A', documentName: 'A.nwf', documentInstanceId: 'doc-A' },
      { connected: true, status: 'B', documentName: 'B.nwf', documentInstanceId: 'doc-B' },
      { connected: true, status: 'B', documentName: 'B.nwf', documentInstanceId: 'doc-B' },
      { connected: true, status: 'B', documentName: 'B.nwf', documentInstanceId: 'doc-B' },
    ]
    const seenNotices: unknown[] = []
    let runCount = 0
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(input) {
        runCount += 1
        seenNotices.push(input.documentNotice)
        if (runCount === 2) throw new Error('timeout')
        return { content: '完成。' }
      },
    }
    const registry = new ChatRunRegistry(
      agent,
      createFacade(createSessionStore()),
      new ToolApprovalRegistry(),
      undefined,
      contextState,
      async () => statuses.shift()!,
    )
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>

    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.filter((call) => call[1] === 'chat.done')).toHaveLength(1))
    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.filter((call) => call[1] === 'chat.error')).toHaveLength(1))
    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.filter((call) => call[1] === 'chat.done')).toHaveLength(2))
    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.filter((call) => call[1] === 'chat.done')).toHaveLength(3))

    expect(seenNotices[0]).toBeUndefined()
    expect(seenNotices[1]).toMatchObject({ revision: 1 })
    expect(seenNotices[2]).toMatchObject({ revision: 1 })
    expect(seenNotices[3]).toBeUndefined()
  })

  it('continues ordinary chat when the preflight status read fails', async () => {
    const contextState = new ContextState()
    const run = vi.fn(async () => ({ content: '普通聊天正常。' }))
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      run: run as unknown as OllamaAgentPort['run'],
    }
    const registry = new ChatRunRegistry(
      agent,
      createFacade(createSessionStore()),
      new ToolApprovalRegistry(),
      undefined,
      contextState,
      async () => { throw new Error('bridge unavailable') },
    )
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>

    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.some((call) => call[1] === 'chat.done')).toBe(true))

    expect(run).toHaveBeenCalledTimes(1)
    expect(contextState.currentDocument).toEqual({ connected: false })
  })
})

describe('ToolApprovalRegistry', () => {
  it('binds a one-shot approval to the requesting renderer', async () => {
    const registry = new ToolApprovalRegistry()
    const sender = fakeSender()
    const controller = new AbortController()
    const pending = registry.request({
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'message-1',
      toolCallId: 'tool-call-1',
      toolName: 'navisworks_set_visibility',
      arguments: { action: 'hide', itemIds: ['1'] },
      argumentsHash: 'hash-1',
    }, sender, controller.signal)

    const send = sender.send as unknown as ReturnType<typeof vi.fn>
    const payload = send.mock.calls[0]?.[2] as { approvalId: string }
    expect(payload.approvalId).toBeTruthy()
    expect(registry.resolve(payload.approvalId, true, { ...sender, id: 2 } as WebContents)).toBe(false)
    expect(registry.resolve(payload.approvalId, true, sender)).toBe(true)
    await expect(pending).resolves.toBe(true)
    expect(registry.resolve(payload.approvalId, true, sender)).toBe(false)
  })

  it('cancels only approvals bound to an invalidated document', async () => {
    const registry = new ToolApprovalRegistry()
    const sender = fakeSender()
    const controller = new AbortController()
    const base = {
      runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1', messageId: 'message-1',
      toolName: 'navisworks_set_visibility' as const,
      arguments: { action: 'hide', itemIds: ['1'] }, argumentsHash: 'hash-1',
    }
    const stale = registry.request({
      ...base, toolCallId: 'call-A', documentInstanceId: 'doc-A',
    }, sender, controller.signal)
    const current = registry.request({
      ...base, toolCallId: 'call-B', documentInstanceId: 'doc-B',
    }, sender, controller.signal)
    registry.cancelForDocument('doc-A')
    await expect(stale).resolves.toBe(false)

    const send = sender.send as unknown as ReturnType<typeof vi.fn>
    const approvalId = (send.mock.calls[1]?.[2] as { approvalId: string }).approvalId
    expect(registry.resolve(approvalId, true, sender)).toBe(true)
    await expect(current).resolves.toBe(true)
  })

  it('cancels approvals only for the matching instance environment', async () => {
    const registry = new ToolApprovalRegistry()
    const sender = fakeSender()
    const controller = new AbortController()
    const base = {
      runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1', messageId: 'message-1',
      toolName: 'navisworks_set_visibility' as const,
      arguments: { action: 'hide', itemIds: ['1'] }, argumentsHash: 'hash-1',
      documentInstanceId: 'same-doc',
    }
    const approvalA = registry.request({
      ...base, toolCallId: 'call-A', instanceId: 'instance-A', bridgeSessionId: 'bridge-A',
    }, sender, controller.signal)
    const approvalB = registry.request({
      ...base, toolCallId: 'call-B', instanceId: 'instance-B', bridgeSessionId: 'bridge-B',
    }, sender, controller.signal)

    registry.cancelForEnvironment('instance-A', 'bridge-A', 'same-doc')
    await expect(approvalA).resolves.toBe(false)

    const send = sender.send as unknown as ReturnType<typeof vi.fn>
    const approvalIdB = (send.mock.calls[1]?.[2] as { approvalId: string }).approvalId
    expect(registry.resolve(approvalIdB, true, sender)).toBe(true)
    await expect(approvalB).resolves.toBe(true)
  })
})

describe('PersistenceFacade tombstone gate', () => {
  it('rejects writing back a session id that was durably deleted', async () => {
    const store = createSessionStore([persistedSession('gone')])
    const facade = createFacade(store)

    await facade.deleteSession('gone')
    const error = await facade.saveSession(desktopSession('gone')).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error).toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: '会话已被删除，拒绝写回。',
        name: 'DesktopIpcError',
      }),
    )
    expect(store.state.sessions).toEqual([])
  })

  it('still inserts a brand-new session after some other deletion', async () => {
    const store = createSessionStore([persistedSession('old')])
    const facade = createFacade(store)

    await facade.deleteSession('old')
    await expect(facade.saveSession(desktopSession('fresh'))).resolves.toMatchObject({ id: 'fresh' })
    expect(store.state.sessions.map((session) => session.id)).toEqual(['fresh'])
  })

  it('does not tombstone an id that was never on disk', async () => {
    const store = createSessionStore([])
    const facade = createFacade(store)

    await facade.deleteSession('phantom')
    await expect(facade.saveSession(desktopSession('phantom'))).resolves.toMatchObject({
      id: 'phantom',
    })
    expect(store.state.sessions.map((session) => session.id)).toEqual(['phantom'])
  })

  it('keeps the id writable when the durable delete itself fails', async () => {
    const store = createSessionStore([persistedSession('keep-me')])
    const facade = createFacade(store)

    store.state.failSave = true
    await expect(facade.deleteSession('keep-me')).rejects.toEqual(
      expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
    )

    store.state.failSave = false
    await expect(facade.saveSession(desktopSession('keep-me'))).resolves.toMatchObject({
      id: 'keep-me',
    })
  })
})

describe('desktop IPC session routes', () => {
  it('sessions.delete aborts the active run before touching the disk', async () => {
    const order: string[] = []
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(_input, { signal }) {
        order.push('run-started')
        try {
          await abortPromise(signal)
        } catch {
          // Cancelled by sessions.delete: unwind gracefully.
        }
        order.push('run-aborted')
        return { content: '' }
      },
    }
    const store = createSessionStore([persistedSession('session-a')])
    const baseSave = store.save.bind(store)
    store.save = async (sessions) => {
      order.push('disk-saved')
      return baseSave(sessions)
    }
    const harness = createHarness({ ollama: agent, store })
    try {
      const started = await harness.invoke('chat.start', chatStartInput())
      expect(started).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(order).toContain('run-started'))

      const deleted = await harness.invoke('sessions.delete', { sessionId: 'session-a' })
      expect(deleted).toMatchObject({ ok: true })
      expect(order).toEqual(['run-started', 'run-aborted', 'disk-saved'])
      expect(harness.store.state.sessions).toEqual([])
    } finally {
      await harness.dispose()
    }
  })

  it('surfaces the tombstone conflict through the IPC envelope', async () => {
    const harness = createHarness({
      ollama: stubAgent(),
      store: createSessionStore([persistedSession('doomed')]),
    })
    try {
      await expect(harness.invoke('sessions.delete', { sessionId: 'doomed' })).resolves.toMatchObject(
        { ok: true },
      )

      const result = await harness.invoke('sessions.save', { session: desktopSession('doomed') })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CONFLICT')
        expect(result.error.message).toBe('会话已被删除，拒绝写回。')
      }
      expect(harness.store.state.sessions).toEqual([])
    } finally {
      await harness.dispose()
    }
  })
})

describe('desktop IPC tool authorization', () => {
  it('rejects direct renderer attempts to bypass confirmation for view changes', async () => {
    const bridgeCall = vi.fn()
    const harness = createHarness({
      ollama: stubAgent(),
      bridge: {
        async call<T>(method: string, parameters?: Record<string, unknown>) {
          bridgeCall(method, parameters)
          return {} as T
        },
      } as NavisworksBridgeClient,
      tools: {
        assertAllowed: () => undefined,
        get: () => ({ impact: 'view-state-change' }),
      } as unknown as ToolCatalog,
    })
    try {
      const result = await harness.invoke('navisworks.tool.execute', {
        toolName: 'navisworks_set_visibility',
        arguments: { action: 'hide', itemIds: ['1'] },
      })
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      })
      expect(bridgeCall).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })
})

describe('sessions.summarizeTitle route', () => {
  it('returns the model-suggested title when the agent supports summarization', async () => {
    const agent = {
      ...stubAgent(),
      async summarizeTitle() {
        return '三层风管排查'
      },
    }
    const harness = createHarness({ ollama: agent })
    try {
      await expect(
        harness.invoke('sessions.summarizeTitle', { text: '帮我把三层的所有风管隐藏掉' }),
      ).resolves.toMatchObject({ ok: true, data: { title: '三层风管排查' } })
    } finally {
      await harness.dispose()
    }
  })

  it('falls back to truncation when the agent cannot summarize', async () => {
    // stubAgent() has no summarizeTitle — the route must still answer.
    const harness = createHarness({ ollama: stubAgent() })
    try {
      const text = '帮我把三层的所有风管隐藏掉，然后截图对比前后差异'
      await expect(harness.invoke('sessions.summarizeTitle', { text })).resolves.toMatchObject({
        ok: true,
        data: { title: text.slice(0, 28) },
      })
    } finally {
      await harness.dispose()
    }
  })
})

describe('desktop IPC settings routes', () => {
  const baseSettings = {
    selectedModel: 'qwen3.5:9b-q4_K_M',
    models: ['qwen3.5:9b-q4_K_M'],
    plugins: [],
    skills: [],
    reasoningMode: 'low',
    activeSessionId: null,
    gpuVramGb: 8,
    contextWindowTokens: 8192,
    numPredict: 2048,
    themeMode: 'system',
    disabledTools: [],
    preferApiModel: false,
    ollamaEnabled: true,
    apiEnabled: true,
    apiProfiles: [],
    activeApiProfileId: null,
  }

  it('merges a disabledTools patch and serves it back from settings.get', async () => {
    const harness = createHarness({
      ollama: stubAgent(),
      settings: statefulSettingsStub({ ...baseSettings }),
    })
    try {
      const updated = await harness.invoke('settings.update', {
        settings: { disabledTools: ['navisworks_set_visibility'] },
      })
      expect(updated).toMatchObject({ ok: true })
      if (updated.ok) {
        expect((updated.data as { disabledTools: string[] }).disabledTools).toEqual([
          'navisworks_set_visibility',
        ])
      }

      const got = await harness.invoke('settings.get', undefined)
      expect(got).toMatchObject({ ok: true })
      if (got.ok) {
        expect((got.data as { disabledTools: string[] }).disabledTools).toEqual([
          'navisworks_set_visibility',
        ])
      }
    } finally {
      await harness.dispose()
    }
  })

  it('saves an API profile without returning its plaintext key', async () => {
    const harness = createHarness({
      ollama: stubAgent(),
      settings: statefulSettingsStub({ ...baseSettings }),
      secrets: {
        encrypt: (value) => `encrypted:${value}`,
        decrypt: (value) => value.replace(/^encrypted:/, ''),
      },
    })
    try {
      const updated = await harness.invoke('api.profile.save', {
        name: '云端',
        baseUrl: 'https://cloud.example.com/v1',
        model: 'qwen-plus',
        apiKey: 'sk-secret',
      })
      expect(updated).toMatchObject({ ok: true })
      if (updated.ok) {
        expect(updated.data).toMatchObject({
          apiProfiles: [expect.objectContaining({ name: '云端', hasApiKey: true })],
        })
        expect(JSON.stringify(updated.data)).not.toContain('sk-secret')
      }
    } finally {
      await harness.dispose()
    }
  })

  it('rejects insecure remote API addresses while allowing local HTTP endpoints', async () => {
    const harness = createHarness({
      ollama: stubAgent(),
      settings: statefulSettingsStub({ ...baseSettings }),
    })
    try {
      await expect(harness.invoke('api.profile.save', {
        name: '远程 HTTP',
        baseUrl: 'http://192.168.1.20:8080/v1',
        model: 'model-a',
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      })
      await expect(harness.invoke('api.profile.save', {
        name: '本机接口',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'model-a',
      })).resolves.toMatchObject({ ok: true })
    } finally {
      await harness.dispose()
    }
  })

  it('migrates a legacy plaintext key before exposing settings to the renderer', async () => {
    let savedSettings: unknown
    const settings = {
      async load() {
        return {
          ...baseSettings,
          apiProfiles: [{
            id: 'legacy-profile',
            name: '旧配置',
            baseUrl: 'https://legacy.example.com/v1',
            model: 'legacy-model',
            apiKeyCiphertext: '',
            legacyApiKey: 'sk-legacy',
          }],
          activeApiProfileId: 'legacy-profile',
        }
      },
      async save(next: unknown) {
        savedSettings = next
        return true
      },
    } as unknown as JsonSettingsRepository
    const harness = createHarness({
      ollama: stubAgent(),
      settings,
      secrets: {
        encrypt: (value) => `encrypted:${value}`,
        decrypt: (value) => value.replace(/^encrypted:/, ''),
      },
    })
    try {
      const got = await harness.invoke('settings.get', undefined)
      expect(got).toMatchObject({
        ok: true,
        data: { apiProfiles: [expect.objectContaining({ hasApiKey: true })] },
      })
      expect(JSON.stringify(got)).not.toContain('sk-legacy')
      expect(savedSettings).toMatchObject({
        apiProfiles: [expect.objectContaining({
          apiKeyCiphertext: 'encrypted:sk-legacy',
          legacyApiKey: '',
        })],
      })
    } finally {
      await harness.dispose()
    }
  })

  it('hands the disabled-tool list from settings to every chat run', async () => {
    const seen: Array<Record<string, unknown>> = []
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(input) {
        seen.push(input as unknown as Record<string, unknown>)
        return { content: '好的。' }
      },
    }
    const harness = createHarness({
      ollama: agent,
      settings: statefulSettingsStub({
        ...baseSettings,
        disabledTools: ['navisworks_find_items'],
      }),
    })
    try {
      const started = await harness.invoke('chat.start', chatStartInput())
      expect(started).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0]?.disabledTools).toEqual(['navisworks_find_items'])
    } finally {
      await harness.dispose()
    }
  })

  it('passes the active API profile into the run', async () => {
    const seen: Array<Record<string, unknown>> = []
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(input) {
        seen.push(input as unknown as Record<string, unknown>)
        return { content: '好的。' }
      },
    }
    const harness = createHarness({
      ollama: agent,
      settings: statefulSettingsStub({
        ...baseSettings,
        preferApiModel: true,
        apiProfiles: [{
          id: 'active-profile',
          name: '当前',
          baseUrl: 'https://active.example.com/v1',
          model: 'active-model',
          apiKeyCiphertext: 'encrypted:active-key',
          legacyApiKey: '',
        }],
        activeApiProfileId: 'active-profile',
      }),
      secrets: {
        encrypt: (value) => `encrypted:${value}`,
        decrypt: (value) => value.replace(/^encrypted:/, ''),
      },
    })
    try {
      const started = await harness.invoke('chat.start', chatStartInput())
      expect(started).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0]?.api).toEqual({
        baseUrl: 'https://active.example.com/v1',
        apiKey: 'active-key',
        model: 'active-model',
      })
    } finally {
      await harness.dispose()
    }
  })

  it('runs chat locally when no API profile is active', async () => {
    const run = vi.fn(async (_input: unknown) => ({ content: '本地回答。' }))
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      run: run as unknown as OllamaAgentPort['run'],
    }
    const harness = createHarness({
      ollama: agent,
      settings: statefulSettingsStub({ ...baseSettings }),
    })
    try {
      const started = await harness.invoke('chat.start', chatStartInput())
      expect(started).toMatchObject({ ok: true }) // start() returns before the run executes
      // The done event proves the local run was never gated.
      const sender = TRUSTED_EVENT.sender as unknown as { send: ReturnType<typeof vi.fn> }
      await vi.waitFor(() => {
        if (!sender.send.mock.calls.some((call) => call[1] === 'chat.done')) {
          throw new Error('chat.done not emitted yet')
        }
      })
      expect(run).toHaveBeenCalledTimes(1)
      const runInput = run.mock.calls[0]?.[0] as { api?: unknown }
      expect(runInput.api).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('migrates legacy fast/deep reasoning modes onto the five-step scale', async () => {
    const harness = createHarness({
      ollama: stubAgent(),
      settings: statefulSettingsStub({ ...baseSettings, reasoningMode: 'deep' }),
    })
    try {
      const got = await harness.invoke('settings.get', undefined)
      expect(got).toMatchObject({ ok: true })
      if (got.ok) {
        expect((got.data as { reasoningMode: string }).reasoningMode).toBe('max')
      }

      const updated = await harness.invoke('settings.update', {
        settings: { reasoningMode: 'high' },
      })
      expect(updated).toMatchObject({
        ok: true,
        data: expect.objectContaining({ reasoningMode: 'high' }),
      })
    } finally {
      await harness.dispose()
    }
  })

  it('persists provider enable switches through settings.update', async () => {
    const harness = createHarness({
      ollama: stubAgent(),
      settings: statefulSettingsStub({ ...baseSettings }),
    })
    try {
      const updated = await harness.invoke('settings.update', {
        settings: { ollamaEnabled: false, apiEnabled: false },
      })
      expect(updated).toMatchObject({
        ok: true,
        data: expect.objectContaining({ ollamaEnabled: false, apiEnabled: false }),
      })
    } finally {
      await harness.dispose()
    }
  })

  it('keeps chat on the local model when the API switch is off', async () => {
    const seen: Array<Record<string, unknown>> = []
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(input) {
        seen.push(input as unknown as Record<string, unknown>)
        return { content: '好的。' }
      },
    }
    const harness = createHarness({
      ollama: agent,
      settings: statefulSettingsStub({
        ...baseSettings,
        preferApiModel: true,
        apiEnabled: false,
        apiProfiles: [{
          id: 'active-profile',
          name: '当前',
          baseUrl: 'https://active.example.com/v1',
          model: 'active-model',
          apiKeyCiphertext: 'encrypted:active-key',
          legacyApiKey: '',
        }],
        activeApiProfileId: 'active-profile',
      }),
      secrets: {
        encrypt: (value) => `encrypted:${value}`,
        decrypt: (value) => value.replace(/^encrypted:/, ''),
      },
    })
    try {
      const started = await harness.invoke('chat.start', chatStartInput())
      expect(started).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0]?.api).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })

  it('forces the API profile when the local Ollama switch is off', async () => {
    const seen: Array<Record<string, unknown>> = []
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(input) {
        seen.push(input as unknown as Record<string, unknown>)
        return { content: '好的。' }
      },
    }
    const harness = createHarness({
      ollama: agent,
      settings: statefulSettingsStub({
        ...baseSettings,
        preferApiModel: false,
        ollamaEnabled: false,
        apiProfiles: [{
          id: 'active-profile',
          name: '当前',
          baseUrl: 'https://active.example.com/v1',
          model: 'active-model',
          apiKeyCiphertext: 'encrypted:active-key',
          legacyApiKey: '',
        }],
        activeApiProfileId: 'active-profile',
      }),
      secrets: {
        encrypt: (value) => `encrypted:${value}`,
        decrypt: (value) => value.replace(/^encrypted:/, ''),
      },
    })
    try {
      const started = await harness.invoke('chat.start', chatStartInput())
      expect(started).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0]?.api).toEqual({
        baseUrl: 'https://active.example.com/v1',
        apiKey: 'active-key',
        model: 'active-model',
      })
    } finally {
      await harness.dispose()
    }
  })

  it('errors the chat run when both provider switches are off', async () => {
    const harness = createHarness({
      ollama: stubAgent(),
      settings: statefulSettingsStub({
        ...baseSettings,
        ollamaEnabled: false,
        apiEnabled: false,
      }),
    })
    try {
      const started = await harness.invoke('chat.start', chatStartInput())
      expect(started).toMatchObject({ ok: true })
      const sender = TRUSTED_EVENT.sender as unknown as { send: ReturnType<typeof vi.fn> }
      await vi.waitFor(() => {
        const errorCall = sender.send.mock.calls.find((call) => call[1] === 'chat.error')
        if (!errorCall) throw new Error('chat.error not emitted yet')
        expect(errorCall[2]).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } })
      })
    } finally {
      await harness.dispose()
    }
  })
})
