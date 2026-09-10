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

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  ChatRunRegistry,
  PersistenceFacade,
  registerDesktopIpc,
  ToolApprovalRegistry,
  type DesktopIpcDependencies,
  type OllamaAgentPort,
} from '../ipc'
import {
  eventSchemas,
  requestSchemas,
} from '../../shared/ipc'
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
import { createToolRegistry, type ToolRegistry } from '../tool/registry'
import { CapabilityRegistry } from '../capability/capabilityRegistry'
import { NavisworksCapabilityProvider } from '../navisworks/capability'
import { ContextState } from '../agent/contextState'
import { QuestionService } from '../question/questionService'
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
  questions?: import('../question/questionService').QuestionService
  secrets?: { encrypt(value: string): string; decrypt(value: string): string }
  bridge?: NavisworksBridgeClient
  tools?: ToolCatalog
  agentTools?: ToolRegistry
  instanceRegistry?: NavisworksInstanceRegistry
  instanceSelection?: NavisworksInstanceSelection
  contextState?: ContextState
}): IpcHarness {
  const store = options.store ?? createSessionStore()
  const dependencies: DesktopIpcDependencies = {
    questions: options.questions,
    agentTools: options.agentTools ?? createToolRegistry({}),
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
    contextState: options.contextState,
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

describe('tools.list single truth (P30.1)', () => {
  it('returns the composed capability inventory through the REAL route+schema (§5/§7)', async () => {
    // A production-like composition: a real Navisworks capability contributes
    // its tools; internal helpers must stay hidden. The route output is
    // validated by toolDefinitionSummarySchema, so a shape drift fails here.
    const bridge = { async call<T>() { return {} as T } } as unknown as NavisworksBridgeClient
    const capabilities = new CapabilityRegistry([
      new NavisworksCapabilityProvider({ bridge }),
    ])
    const harness = createHarness({
      ollama: stubAgent(),
      agentTools: createToolRegistry({ capabilities }),
    })
    try {
      const result = await harness.invoke('tools.list', undefined)
      expect(result.ok).toBe(true)
      const names = ((result as { data: Array<{ name: string; capabilityId?: string }> }).data).map((entry) => entry.name)
      expect(names).toContain('navisworks_status')
      expect(names).toContain('navisworks_get_document')
      expect(names).toContain('navisworks_set_visibility')
      // Internal tools are never configurable in Settings.
      expect(names).not.toContain('read_tool_result')
      expect(names).not.toContain('question')
      expect(names).not.toContain('skill')
    } finally {
      await harness.dispose()
    }
  })
})

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

  it('rebinding from a stale A to B updates ContextState and broadcasts the new identity', async () => {
    const instanceA = discoveredInstance('instance-a', 12340, 'Model-A.nwf')
    const instanceB = discoveredInstance('instance-b', 18120, 'Model-B.nwf')
    let refreshCount = 0
    const current = () => (refreshCount <= 1 ? [instanceA] : [instanceB])
    const registry = {
      get instances() { return current().map((instance) => ({ ...instance })) },
      async refresh() {
        refreshCount += 1
        return current().map((instance) => ({ ...instance }))
      },
      get(instanceId: string) {
        return current().find((instance) => instance.instanceId === instanceId)
      },
    } as unknown as NavisworksInstanceRegistry
    const contextState = new ContextState()
    const observe = vi.spyOn(contextState, 'observe')
    const windowWebContents = fakeSender()
    const fakeWindow = { isDestroyed: () => false, webContents: windowWebContents }
    const getAllWindows = vi.mocked(BrowserWindow.getAllWindows)
    getAllWindows.mockReturnValue([fakeWindow as never])
    const harness = createHarness({
      ollama: stubAgent(),
      instanceRegistry: registry,
      instanceSelection: new NavisworksInstanceSelection(),
      contextState,
    })
    try {
      // A is the only instance at first: auto-selected as the safe default.
      await harness.invoke('navisworks.instances.list', undefined)
      // A closed and B (re)started: A remains the explicit target, kept as a
      // disconnected snapshot; no silent switch to B.
      const stale = await harness.invoke('navisworks.instances.list', undefined)
      expect(stale).toMatchObject({
        ok: true,
        data: {
          selectedInstanceId: 'instance-a',
          instances: expect.arrayContaining([
            expect.objectContaining({ instanceId: 'instance-a', connected: false }),
            expect.objectContaining({ instanceId: 'instance-b', connected: true }),
          ]),
        },
      })

      const selected = await harness.invoke('navisworks.instance.select', { instanceId: 'instance-b' })
      expect(selected).toMatchObject({ ok: true, data: { selectedInstanceId: 'instance-b' } })

      // ContextState must have observed the NEW instance's status so the old
      // document's facts / reference sets are invalidated against B.
      expect(observe).toHaveBeenCalledTimes(1)
      expect(observe.mock.calls[0]?.[0]).toMatchObject({
        connected: true,
        instanceId: 'instance-b',
        bridgeSessionId: 'instance-b',
        documentInstanceId: 'doc-18120',
      })

      const send = windowWebContents.send as unknown as ReturnType<typeof vi.fn>
      const connectionEvents = send.mock.calls.filter((call) => call[1] === 'navisworks.instances.changed')
      expect(connectionEvents.at(-1)?.[2]).toMatchObject({ selectedInstanceId: 'instance-b' })
      const statusEvents = send.mock.calls.filter((call) => call[1] === 'navisworks.status.changed')
      expect(statusEvents.at(-1)?.[2]).toMatchObject({
        connected: true,
        instanceId: 'instance-b',
        documentInstanceId: 'doc-18120',
      })
    } finally {
      getAllWindows.mockReturnValue([])
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

  it('P30.9: prepares NO Navisworks run state — the agent input is field-free (§24/§86/Invariant C)', async () => {
    // The old preflight tests (binding creation, A→B document switching,
    // pending-transition marking, offline status) moved to the Navisworks
    // capability where that preparation now lives. This test proves the
    // chat runtime side no longer participates in any of it.
    const createRun = vi.fn(async (
      _runId: string,
      _sessionId: string,
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
    // The ChatRunRegistry constructor is Navisworks-free: only the port,
    // persistence, approvals and the (optional) scope manager.
    const registry = new ChatRunRegistry(
      agent,
      createFacade(createSessionStore()),
      new ToolApprovalRegistry(),
      scopeManager,
    )
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>

    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.filter((call) => call[1] === 'chat.done')).toHaveLength(1))

    const input = inputs[0] ?? {}
    expect(input.navisworksBinding).toBeUndefined()
    expect(input.navisworksUnavailable).toBeUndefined()
    expect(input.currentDocument).toBeUndefined()
    expect(input.documentNotice).toBeUndefined()
    // The run scope is created WITHOUT a Navisworks document instance id.
    expect(createRun).toHaveBeenCalledWith(expect.stringMatching(/./), 'session-a')
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

describe('P30.7 generic vs Navisworks-only tool-name schemas (REAL schemas §41/§90)', () => {
  it('toolNameSchema accepts a future capability name and rejects junk', async () => {
    // The generic name is now an open namespace (§37): a future tool validates.
    expect(() => requestSchemas['settings.update'].input.parse({
      settings: { disabledTools: ['fake_echo', 'files_read', 'browser.open', 'a:b-c_d'] },
    })).not.toThrow()
    // Whitespace / over-long names are still refused.
    expect(() => requestSchemas['settings.update'].input.parse({
      settings: { disabledTools: ['not a tool name'] },
    })).toThrow()
  })

  it('the generic tool.approval.requested EVENT accepts a fake capability tool (§41)', () => {
    const parsed = eventSchemas['tool.approval.requested'].safeParse({
      approvalId: 'a1',
      runId: 'r1',
      sessionId: 's1',
      turnId: 't1',
      messageId: 'm1',
      toolCallId: 'tc1',
      toolName: 'fake_write',
      arguments: {},
      argumentsHash: 'h1',
    })
    expect(parsed.success).toBe(true)
  })

  it('navisworks.tool.execute KEEPS the closed Navisworks enum: fake_echo invalid, read tool valid (§38/§100)', () => {
    const executeInput = requestSchemas['navisworks.tool.execute'].input
    expect(executeInput.safeParse({ toolName: 'fake_echo', arguments: {} }).success).toBe(false)
    expect(executeInput.safeParse({ toolName: 'navisworks_get_document', arguments: {} }).success).toBe(true)
    // Even a well-formed non-Navisworks name cannot reach the direct route.
    expect(executeInput.safeParse({ toolName: 'files_read', arguments: {} }).success).toBe(false)
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

  it('P30.7 fix: settings.update persists modelConfigurations and settings.get echoes it back', async () => {
    // This is the reported bug: 编辑模型配置 saved nothing. The IPC
    // PersistenceFacade dropped patch.modelConfigurations on WRITE and
    // toDesktopSettings dropped it on READ — the repository layer round-tripped
    // fine (tested in sessionRepository.test) but the facade did not, so this
    // IPC-level regression belongs HERE, not only at the store.
    const harness = createHarness({
      ollama: stubAgent(),
      settings: statefulSettingsStub({ ...baseSettings }),
    })
    const configurations = [{
      ref: { providerId: 'api:p1', modelId: 'qwen3.8-max' },
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    }]
    try {
      const updated = await harness.invoke('settings.update', {
        settings: { modelConfigurations: configurations },
      })
      expect(updated).toMatchObject({ ok: true })
      if (updated.ok) {
        expect((updated.data as { modelConfigurations: unknown[] }).modelConfigurations)
          .toEqual(configurations)
      }
      const got = await harness.invoke('settings.get', undefined)
      expect(got).toMatchObject({ ok: true })
      if (got.ok) {
        expect((got.data as { modelConfigurations: unknown[] }).modelConfigurations)
          .toEqual(configurations)
      }
      // An unrelated later patch must NOT wipe the stored model configs (§20/§42).
      const patched = await harness.invoke('settings.update', {
        settings: { themeMode: 'dark' },
      })
      if (patched.ok) {
        expect((patched.data as { modelConfigurations: unknown[] }).modelConfigurations)
          .toEqual(configurations)
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

  it('persists model lists and independent enabled states across unrelated edits', async () => {
    const harness = createHarness({ ollama: stubAgent(), settings: statefulSettingsStub({ ...baseSettings, apiEnabled: false }) })
    try {
      const profile = { name: 'API', baseUrl: 'https://example.com/v1', model: 'm1' }
      await harness.invoke('api.profile.save', { ...profile, id: 'a', models: ['m1', 'm2'] })
      await harness.invoke('api.profile.save', { ...profile, id: 'b' })
      await harness.invoke('api.profile.save', { ...profile, id: 'a', enabled: true })
      const result = await harness.invoke('api.profile.save', { ...profile, id: 'a', name: 'Renamed' })
      expect(result).toMatchObject({ ok: true, data: {
        apiEnabled: true,
        apiProfiles: [
          expect.objectContaining({ id: 'a', name: 'Renamed', models: ['m1', 'm2'], enabled: true }),
          expect.objectContaining({ id: 'b', enabled: false }),
        ],
      } })
      await harness.invoke('api.profile.save', { ...profile, id: 'a', models: [], model: '', enabled: false })
      expect(await harness.invoke('settings.get', undefined)).toMatchObject({ ok: true, data: {
        apiProfiles: [expect.objectContaining({ id: 'a', models: [], model: '', enabled: false }), expect.objectContaining({ id: 'b', enabled: false })],
      } })
    } finally { await harness.dispose() }
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

describe('ChatRunRegistry — terminal event guarantees', () => {
  it('emits chat.done even when compaction persistence never resolves', async () => {
    const facade = createFacade(createSessionStore())
    // A wedged disk write must not hold the renderer in "生成回复中".
    // (Shadowed on the instance so the facade's private state stays reachable.)
    const persistCompactSummary = vi.fn(() => new Promise<void>(() => {}))
    ;(facade as unknown as { persistCompactSummary: () => Promise<void> }).persistCompactSummary = persistCompactSummary
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run() {
        return { content: '回答完成。', compactSummary: '压缩摘要' }
      },
    }
    const registry = new ChatRunRegistry(agent, facade)
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>

    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.some((call) => call[1] === 'chat.done')).toBe(true))
    // The background persistence was started, but the terminal event did not
    // wait for it.
    expect(persistCompactSummary).toHaveBeenCalled()
    expect(send.mock.calls.some((call) => call[1] === 'chat.error')).toBe(false)
  })

  it('emits exactly one terminal event when the run fails', async () => {
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run() {
        throw new Error('模型调用失败')
      },
    }
    const registry = new ChatRunRegistry(agent, createFacade(createSessionStore()))
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>

    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => expect(send.mock.calls.some((call) => call[1] === 'chat.error')).toBe(true))
    // Settle any follow-up work, then assert the exactly-once guarantee.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const terminalEvents = send.mock.calls.filter((call) => call[1] === 'chat.done' || call[1] === 'chat.error')
    expect(terminalEvents).toHaveLength(1)
    expect(terminalEvents[0]?.[1]).toBe('chat.error')
  })
})

describe('ChatRunRegistry — chat.done payload survives the IPC schema', () => {
  it('Case F: a fallback-source result reaches the sender as chat.done exactly once', async () => {
    // The exact shape a real local run produces: fallback window + source.
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run() {
        return {
          content: '回答完成。',
          contextTokensUsed: 1820,
          contextWindowTokens: 32_768,
          contextWindowSource: 'fallback' as const,
        }
      },
    }
    const registry = new ChatRunRegistry(agent, createFacade(createSessionStore()))
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>

    registry.start(chatStartInput(), sender)
    // emitTo drops schema-invalid payloads BEFORE sender.send, so a send event
    // is itself the proof that the done payload passed the real wire schema.
    await vi.waitFor(() => {
      const doneCalls = send.mock.calls.filter((call) => call[1] === 'chat.done')
      expect(doneCalls).toHaveLength(1)
    })
    const donePayload = send.mock.calls.find((call) => call[1] === 'chat.done')?.[2] as Record<string, unknown>
    expect(donePayload).toMatchObject({
      contextWindowTokens: 32_768,
      contextWindowSource: 'fallback',
    })
    expect(send.mock.calls.some((call) => call[1] === 'chat.error')).toBe(false)
  })
})

describe('ChatRunRegistry — Model System integration (P5/P6/P8)', () => {
  it('carries the raw usage object through the REAL chat.done schema', async () => {
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run() {
        return {
          content: '回答完成。',
          usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 500 },
          contextTokensUsed: 1_200,
          cacheHitRate: 0.5,
          contextWindowTokens: 32_768,
          contextWindowSource: 'local' as const,
        }
      },
    }
    const registry = new ChatRunRegistry(agent, createFacade(createSessionStore()))
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>
    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => {
      expect(send.mock.calls.filter((call) => call[1] === 'chat.done')).toHaveLength(1)
    })
    const donePayload = send.mock.calls.find((call) => call[1] === 'chat.done')?.[2] as Record<string, unknown>
    expect(donePayload.usage).toEqual({ inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 500 })
    // Legacy derived fields still ride along (compatibility round).
    expect(donePayload.contextTokensUsed).toBe(1_200)
    expect(donePayload.cacheHitRate).toBe(0.5)
  })

  it('fails with MODEL_NOT_CONFIGURED — before running the agent — when no provider can serve', async () => {
    // Ollama off + active API profile with an EMPTY model: the chat run must
    // say "尚未选择模型" and must NOT silently execute a different provider.
    const store = createSessionStore()
    const settings = statefulSettingsStub({
      selectedModel: 'qwen3.5:9b-q4_K_M',
      models: ['qwen3.5:9b-q4_K_M'],
      reasoningMode: 'low',
      themeMode: 'system',
      disabledTools: [],
      fontScale: 1,
      contextWindowTokens: 32_768,
      preferApiModel: true,
      ollamaEnabled: false,
      apiEnabled: true,
      activeApiProfileId: 'p-empty',
      apiProfiles: [{
        id: 'p-empty', name: 'P', baseUrl: 'https://api.example.com/v1', model: '',
        apiKeyCiphertext: '', legacyApiKey: '',
      }],
    })
    const facade = new PersistenceFacade(
      store as unknown as JsonSessionRepository,
      settings,
    )
    const runSpy = vi.fn(async () => ({ content: 'never' }))
    const registry = new ChatRunRegistry({ ...stubAgent(), run: runSpy }, facade)
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>
    registry.start(chatStartInput(), sender)
    await vi.waitFor(() => {
      const errorCall = send.mock.calls.find((call) => call[1] === 'chat.error')
      if (!errorCall) throw new Error('chat.error not emitted yet')
      expect(errorCall[2]).toMatchObject({ error: { code: 'MODEL_NOT_CONFIGURED' } })
    })
    expect(runSpy).not.toHaveBeenCalled()
    expect(send.mock.calls.some((call) => call[1] === 'chat.done')).toBe(false)
  })

  it('model.info.get answers with the resolved ollama ModelInfo (P8)', async () => {
    const harness = createHarness({
      ollama: stubAgent(),
      settings: statefulSettingsStub({
        selectedModel: 'qwen3.5:9b-q4_K_M',
        models: ['qwen3.5:9b-q4_K_M'],
        reasoningMode: 'low',
        themeMode: 'system',
        disabledTools: [],
        fontScale: 1,
        contextWindowTokens: 32_768,
        preferApiModel: false,
        ollamaEnabled: true,
        apiEnabled: false,
        activeApiProfileId: null,
        apiProfiles: [],
      }),
    })
    try {
      const response = await harness.invoke('model.info.get')
      expect(response.ok).toBe(true)
      const info = (response as { data: Record<string, unknown> }).data
      expect(info.ref).toEqual({ providerId: 'ollama', modelId: 'qwen3.5:9b-q4_K_M' })
      expect(info.reasoning).toEqual({ modes: ['low', 'max'] })
      expect((info.limits as Record<string, unknown>).context).toBe(32_768)
      expect(info.metadataSource).toBe('local')
      expect(JSON.stringify(info)).not.toMatch(/apiKey|secret/i)
    } finally {
      await harness.dispose()
    }
  })

  it('model.info.get errors MODEL_NOT_CONFIGURED for an empty selection (no crash)', async () => {
    const harness = createHarness({
      ollama: stubAgent(),
      settings: statefulSettingsStub({
        selectedModel: '',
        models: [],
        reasoningMode: 'low',
        themeMode: 'system',
        disabledTools: [],
        fontScale: 1,
        contextWindowTokens: 32_768,
        preferApiModel: false,
        ollamaEnabled: true,
        apiEnabled: true,
        activeApiProfileId: null,
        apiProfiles: [],
      }),
    })
    try {
      const response = await harness.invoke('model.info.get')
      if (response.ok !== false) throw new Error('expected model.info.get to fail')
      expect(response.error.code).toBe('MODEL_NOT_CONFIGURED')
    } finally {
      await harness.dispose()
    }
  })
})

describe('ChatRunRegistry — pending questions across session switches (§85)', () => {
  it('A suspends, B runs to completion, A restores via pending.list and resumes', async () => {
    const questions = new QuestionService()
    const facade = createFacade(createSessionStore())
    let askedA = 0
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(input, options) {
        if (input.sessionId === 'session-a') {
          askedA += 1
          const outcome = await options.requestQuestion({
            source: 'tool',
            questions: [{
              question: '范围？',
              kind: 'single',
              options: [{ label: '整个模型' }, { label: '当前选择' }],
            }],
          })
          return { content: 'A 继续完成：' + outcome.kind }
        }
        return { content: 'B 已完成' }
      },
    }
    // P30.9: ChatRunRegistry is Navisworks-free — no status reader / instance
    // registry / selection / bridge args.
    const registry = new ChatRunRegistry(agent, facade, new ToolApprovalRegistry(), undefined, undefined, questions)
    const senderA = fakeSender()
    const senderB = fakeSender()
    const sendA = senderA.send as unknown as ReturnType<typeof vi.fn>
    const sendB = senderB.send as unknown as ReturnType<typeof vi.fn>

    registry.start({ sessionId: 'session-a', messageId: 'm-a', text: '帮我查支架' }, senderA)
    await vi.waitFor(() => {
      const asked = sendA.mock.calls.find((call) => call[1] === 'question.requested')
      if (!asked) throw new Error('question.requested not delivered yet')
    })
    // The event passed the REAL schema (emitTo drops invalid payloads).
    const questionPayload = sendA.mock.calls.find((call) => call[1] === 'question.requested')?.[2] as {
      requestId: string
      sessionId: string
    }
    expect(questionPayload.sessionId).toBe('session-a')
    // A is suspended; B runs the SAME registry concurrently and finishes.
    registry.start({ sessionId: 'session-b', messageId: 'm-b', text: '你好' }, senderB)
    await vi.waitFor(() => {
      expect(sendB.mock.calls.some((call) => call[1] === 'chat.done')).toBe(true)
    })
    expect(askedA).toBe(1)
    // Session switch restore: pending.list(sessionId) finds A's question —
    // the UI never depends on having CAUGHT the event live (§18).
    expect(questions.listPending('session-a')).toHaveLength(1)
    expect(questions.listPending('session-b')).toHaveLength(0)
    // ...and answering it resumes A's ORIGINAL run (Invariant B).
    expect(questions.answer(questionPayload.requestId, [{ questionIndex: 0, values: ['当前选择'] }])).toBe(true)
    await vi.waitFor(() => {
      const done = sendA.mock.calls.find((call) => call[1] === 'chat.done')
      if (!done) throw new Error('A never resumed')
      expect((done[2] as { content: string }).content).toContain('A 继续完成：answered')
    })
    expect(questions.pendingCount).toBe(0)
  })

  it('aborting a suspended run rejects the question promise (Invariant D)', async () => {
    const questions = new QuestionService()
    const facade = createFacade(createSessionStore())
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      async run(_input, options) {
        await options.requestQuestion({
          source: 'tool',
          questions: [{ question: 'q?', kind: 'single', options: [{ label: 'a' }, { label: 'b' }] }],
        })
        return { content: 'unreachable' }
      },
    }
    // P30.9: ChatRunRegistry is Navisworks-free — no status reader / instance
    // registry / selection / bridge args.
    const registry = new ChatRunRegistry(agent, facade, new ToolApprovalRegistry(), undefined, undefined, questions)
    const sender = fakeSender()
    const send = sender.send as unknown as ReturnType<typeof vi.fn>
    const started = registry.start({ sessionId: 'session-c', messageId: 'm-c', text: 'x' }, sender)
    await vi.waitFor(() => {
      expect(questions.listPending('session-c')).toHaveLength(1)
    })
    registry.abort(started.sessionId, started.turnId)
    await vi.waitFor(() => {
      expect(questions.pendingCount).toBe(0)
    })
    await vi.waitFor(() => {
      expect(send.mock.calls.some((call) => call[1] === 'chat.error')).toBe(true)
    })
  })
})

describe('question routes — renderer answer validation via the REAL handlers (§101/§16)', () => {
  const PROMPTS = [{
    question: '范围？',
    kind: 'single' as const,
    options: [{ label: '整个模型' }, { label: '当前选择' }],
  }]
  const VALID = {
    runId: 'r1',
    sessionId: 's1',
    turnId: undefined,
    messageId: undefined,
    toolCallId: undefined,
    source: 'tool' as const,
    questions: PROMPTS,
  }

  it('question.answer rejects unknown ids, invented labels, bad indexes, multi-single, empty required; accepts valid', async () => {
    const questions = new QuestionService()
    let pendingId = ''
    const promise = questions.ask(VALID, (request) => {
      pendingId = request.requestId
    })
    const harness = createHarness({ ollama: stubAgent(), questions })
    try {
      const attempts: Array<[() => string, unknown[], boolean]> = [
        [() => 'no-such-id', [{ questionIndex: 0, values: ['整个模型'] }], false],
        [() => pendingId, [{ questionIndex: 0, values: ['我自己编的选项'] }], false],
        [() => pendingId, [{ questionIndex: 5, values: ['整个模型'] }], false],
        [() => pendingId, [{ questionIndex: 0, values: ['整个模型', '当前选择'] }], false],
        [() => pendingId, [{ questionIndex: 0, values: [] }], false],
        [() => pendingId, [{ questionIndex: 0, values: ['当前选择'] }], true],
      ]
      for (const [pick, answers, expected] of attempts) {
        const response = await harness.invoke('question.answer', { requestId: pick(), answers })
        expect(response).toMatchObject({ ok: true, data: { resolved: expected } })
      }
      await expect(promise).resolves.toEqual({ kind: 'answered', answers: [{ questionIndex: 0, values: ['当前选择'] }] })
    } finally {
      await harness.dispose()
    }
  })

  it('question.pending.list filters by session through the real route', async () => {
    const questions = new QuestionService()
    void questions.ask({ ...VALID, sessionId: 'sA' }, () => undefined)
    const harness = createHarness({ ollama: stubAgent(), questions })
    try {
      const mine = await harness.invoke('question.pending.list', { sessionId: 'sA' })
      const list = (mine as { data: unknown[] }).data
      expect(list).toHaveLength(1)
      expect((list[0] as { sessionId: string }).sessionId).toBe('sA')
      const none = await harness.invoke('question.pending.list', { sessionId: 'sB' })
      expect((none as { data: unknown[] }).data).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })
})
