import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, Menu, nativeTheme } from 'electron'

import { NativeAppearanceService } from './appearance'
import { NavisworksBridgeClient } from './bridgeClient'
import { resolveDesktopDataPaths } from './dataPaths'
import {
  registerDesktopIpc,
  broadcastNativeThemeUpdated,
  type OllamaAgentPort,
  type OllamaEndpointOptions,
  type OllamaRunInput,
  type OllamaRunResult,
  type OllamaStreamEvent
} from './ipc'
import { OllamaAgent, type AgentRunEvent, type OllamaAgentOptions } from './ollamaAgent'
import { JsonSessionRepository, JsonSettingsRepository } from './sessionRepository'
import { denyAllPermissions, installProductionContentSecurityPolicy, secureWindowNavigation } from './security/windowSecurity'
import type { SenderTrustOptions } from './security/validateSender'
import { ToolCatalog } from './toolCatalog'
import { DesktopIpcError, type RuntimeInfo } from '../shared/ipc'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(moduleDirectory, '../renderer')
const preloadPath = join(moduleDirectory, '../preload/index.js')
const devServerUrl = process.env.ELECTRON_RENDERER_URL

// Resolve and freeze the complete Electron profile before app.whenReady() or
// any BrowserWindow/session service can derive a path from Electron defaults.
const dataPaths = resolveDesktopDataPaths({ isPackaged: app.isPackaged })
app.setPath('userData', dataPaths.rootDirectory)
app.setPath('sessionData', join(dataPaths.rootDirectory, 'Chromium'))
app.setAppLogsPath(join(dataPaths.rootDirectory, 'logs'))

let mainWindow: BrowserWindow | null = null
let disposeRuntime: (() => Promise<void>) | null = null
let shutdownStarted = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void startApplication().catch(async (error) => {
    console.error('[Main] Fatal startup error', error)
    await writeStartupDiagnostic('fatal', error)
    app.exit(1)
  })
}

async function startApplication(): Promise<void> {
  await writeStartupDiagnostic('starting')

  const sessions = new JsonSessionRepository(dataPaths)
  const settings = new JsonSettingsRepository(dataPaths)
  const persistedSettings = await settings.load()
  await app.whenReady()

  const appearance = new NativeAppearanceService(
    nativeTheme,
    persistedSettings?.themeMode ?? 'system',
    applyWindowAppearance
  )
  appearance.start()
  const bridge = new NavisworksBridgeClient()
  const tools = new ToolCatalog()
  const ollamaDefaults = {
    bridgeClient: bridge,
    model: persistedSettings?.selectedModel,
    think: persistedSettings?.reasoningMode === 'deep',
    contextWindow: persistedSettings?.contextWindowTokens,
    numPredict: persistedSettings?.numPredict
  }
  const rawOllama = new OllamaAgent(ollamaDefaults)
  const ollama = adaptOllamaAgent(rawOllama, (input) => new OllamaAgent({
    ...ollamaDefaults,
    ...ollamaDefaults,
    model: input.model?.trim() || ollamaDefaults.model,
    think: input.reasoningMode === undefined
      ? ollamaDefaults.think
      : input.reasoningMode === 'deep',
    ...(input.disabledTools === undefined ? {} : { disabledTools: input.disabledTools }),
    ...(input.providerBaseUrl ? { baseUrl: input.providerBaseUrl } : {}),
    ...(input.providerApiKey ? { apiKey: input.providerApiKey } : {})
  }), ollamaDefaults)
  const senderTrust: SenderTrustOptions = {
    isPackaged: app.isPackaged,
    rendererRoot,
    ...(devServerUrl === undefined ? {} : { devServerUrl })
  }
  const runtimeInfo: RuntimeInfo = {
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    dataDirectory: dataPaths.rootDirectory,
    profile: dataPaths.buildConfiguration
  }

  const disposeIpc = registerDesktopIpc({
    runtimeInfo,
    sessions,
    settings,
    bridge,
    tools,
    ollama,
    appearance,
    senderTrust
  })

  Menu.setApplicationMenu(null)

  mainWindow = createMainWindow()
  const disposePermissions = denyAllPermissions(mainWindow.webContents.session)
  const disposeNavigation = secureWindowNavigation(mainWindow, senderTrust)
  const disposeCsp = app.isPackaged
    ? installProductionContentSecurityPolicy(mainWindow)
    : () => undefined

  disposeRuntime = async () => {
    disposeCsp()
    disposeNavigation()
    disposePermissions()
    appearance.dispose()
    await disposeIpc()
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (app.isPackaged) {
    await mainWindow.loadFile(join(rendererRoot, 'index.html'))
  } else {
    if (!devServerUrl) {
      throw new Error('ELECTRON_RENDERER_URL is required in development mode')
    }
    await mainWindow.loadURL(devServerUrl)
  }

  await writeStartupDiagnostic('ready')
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: 'Navisworks MCP Desktop',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#f7f7f7',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      devTools: !app.isPackaged
    }
  })

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show()
  })
  return window
}

function applyWindowAppearance(state: import('../shared/ipc').AppearanceState): void {
  const backgroundColor = state.effectiveTheme === 'dark' ? '#141414' : '#f7f7f7'
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(backgroundColor)
  }
  broadcastNativeThemeUpdated(state)
}

function adaptOllamaAgent(
  agent: OllamaAgent,
  createRunAgent: (input: OllamaRunInput) => OllamaAgent,
  probeDefaults: OllamaAgentOptions
): OllamaAgentPort {
  // Probe calls honor per-call endpoint overrides so the settings page can
  // test an unsaved address/key; without overrides the shared instance (and
  // its startup defaults) is reused.
  const probeFor = (options?: OllamaEndpointOptions): OllamaAgent => {
    if (!options?.baseUrl && !options?.apiKey) return agent
    return new OllamaAgent({
      ...probeDefaults,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {})
    })
  }
  return {
    listModels: async (options, signal) => {
      const probe = probeFor(options)
      try {
        return await probe.listModels(signal)
      } finally {
        if (probe !== agent) await probe.dispose()
      }
    },
    testConnection: async (options, signal) => {
      const probe = probeFor(options)
      try {
        const result = await probe.testConnection(signal)
        return { connected: result.isSuccess, message: result.message }
      } finally {
        if (probe !== agent) await probe.dispose()
      }
    },
    run: async (input, options) => {
      // Model/reasoning are immutable OllamaAgent constructor options. Create a
      // request-scoped instance so the UI selection is honored on every turn
      // without mutating or racing the shared probe/list client.
      const runAgent = createRunAgent(input)
      try {
        return await runOllamaAgent(runAgent, input, options)
      } finally {
        runAgent.dispose()
      }
    },
    dispose: () => agent.dispose()
  }
}

async function runOllamaAgent(
  agent: OllamaAgent,
  input: OllamaRunInput,
  options: { signal: AbortSignal; onEvent: (event: OllamaStreamEvent) => void }
): Promise<OllamaRunResult> {
  const activeToolCalls = new Map<string, string[]>()
  const onToolEvent = (event: AgentRunEvent): void => {
    if (event.phase === 'text') {
      options.onEvent({ kind: 'text', delta: event.delta })
      return
    }
    if (event.phase === 'thinking') {
      options.onEvent({ kind: 'thinking', delta: event.delta })
      return
    }
    if (event.phase === 'started') {
      const toolCallId = randomUUID()
      const ids = activeToolCalls.get(event.tool) ?? []
      ids.push(toolCallId)
      activeToolCalls.set(event.tool, ids)
      options.onEvent({
        kind: 'tool-start',
        toolCallId,
        toolName: event.tool,
        arguments: event.arguments
      })
      return
    }

    const ids = activeToolCalls.get(event.tool) ?? []
    const toolCallId = ids.shift() ?? randomUUID()
    if (ids.length === 0) activeToolCalls.delete(event.tool)
    options.onEvent({
      kind: 'tool-result',
      toolCallId,
      toolName: event.tool,
      arguments: event.arguments,
      result: event.result,
      ...(event.error === undefined
        ? {}
        : { error: { code: event.error.code, message: event.error.message } })
    })
  }

  const result = await agent.run(input.text, {
    history: input.history,
    signal: options.signal,
    onEvent: onToolEvent
  })
  if (!result.isSuccess) {
    throw new DesktopIpcError('SERVICE_UNAVAILABLE', result.message, {
      code: result.errorCode,
      contextTokensUsed: result.contextTokensUsed
    })
  }
  return {
    content: result.message,
    ...(result.thinkingText === undefined ? {} : { thinkingText: result.thinkingText })
  }
}

async function writeStartupDiagnostic(phase: string, error?: unknown): Promise<void> {
  try {
    await mkdir(dataPaths.rootDirectory, { recursive: true })
    const record = {
      at: new Date().toISOString(),
      phase,
      executable: process.execPath,
      pid: process.pid,
      isPackaged: app.isPackaged,
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
      logs: app.getPath('logs'),
      profile: dataPaths.buildConfiguration,
      dataSource: dataPaths.sourceDescription,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) })
    }
    await appendFile(dataPaths.startupLogFile, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (diagnosticError) {
    console.error('[Main] Failed to write startup diagnostic', diagnosticError)
  }
}

app.on('window-all-closed', () => app.quit())

app.on('before-quit', (event) => {
  if (shutdownStarted || disposeRuntime === null) return
  event.preventDefault()
  shutdownStarted = true
  void disposeRuntime()
    .catch((error) => console.error('[Main] Shutdown cleanup failed', error))
    .finally(() => app.exit(0))
})
