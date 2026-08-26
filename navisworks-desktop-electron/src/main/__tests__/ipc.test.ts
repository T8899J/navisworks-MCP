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
  return {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents
}

const TRUSTED_EVENT = {
  sender: {
    isDestroyed: () => false,
    getType: () => 'window',
    send: vi.fn(),
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
    bridge: {} as NavisworksBridgeClient,
    tools: { assertAllowed: () => undefined } as unknown as ToolCatalog,
    ollama: options.ollama,
    appearance: {
      getState: () => ({ themeMode: 'system', effectiveTheme: 'light' }),
      setThemeMode: (themeMode) => ({ themeMode, effectiveTheme: 'light' }),
    },
    senderTrust: { isPackaged: false, rendererRoot: 'D:\\app\\renderer', devServerUrl: DEV_ORIGIN },
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

describe('desktop IPC settings routes', () => {
  const baseSettings = {
    selectedModel: 'qwen3.5:9b-q4_K_M',
    models: ['qwen3.5:9b-q4_K_M'],
    plugins: [],
    skills: [],
    reasoningMode: 'fast',
    activeSessionId: null,
    gpuVramGb: 8,
    contextWindowTokens: 8192,
    numPredict: 2048,
    themeMode: 'system',
    disabledTools: [],
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

  it('passes provider endpoint settings into the run', async () => {
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
        providerBaseUrl: 'http://192.168.1.20:11434',
        providerApiKey: 'sk-test',
      }),
    })
    try {
      const started = await harness.invoke('chat.start', chatStartInput())
      expect(started).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0]?.providerBaseUrl).toBe('http://192.168.1.20:11434')
      expect(seen[0]?.providerApiKey).toBe('sk-test')
    } finally {
      await harness.dispose()
    }
  })

  it('rejects chat runs while the provider is disabled', async () => {
    const run = vi.fn(async () => ({ content: '' }))
    const agent: OllamaAgentPort = {
      ...stubAgent(),
      run: run as unknown as OllamaAgentPort['run'],
    }
    const harness = createHarness({
      ollama: agent,
      settings: statefulSettingsStub({
        ...baseSettings,
        providerEnabled: false,
      }),
    })
    try {
      const started = await harness.invoke('chat.start', chatStartInput())
      expect(started).toMatchObject({ ok: true }) // start() returns before the run executes
      // The run is refused before reaching the agent; a chat.error explains why.
      const sender = TRUSTED_EVENT.sender as unknown as { send: ReturnType<typeof vi.fn> }
      await vi.waitFor(() => {
        if (!sender.send.mock.calls.some((call) => call[1] === 'chat.error')) {
          throw new Error('chat.error not emitted yet')
        }
      })
      expect(run).not.toHaveBeenCalled()
      const errorCall = sender.send.mock.calls.find((call) => call[1] === 'chat.error')
      expect(JSON.stringify(errorCall?.[2])).toContain('模型提供商已停用')
    } finally {
      await harness.dispose()
    }
  })
})
