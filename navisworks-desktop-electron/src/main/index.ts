import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, Menu, nativeTheme, safeStorage } from 'electron'

import { NativeAppearanceService } from './appearance'
import { NavisworksBridgeClient } from './bridgeClient'
import { resolveDesktopDataPaths } from './dataPaths'
import {
  registerDesktopIpc,
  broadcastNativeThemeUpdated,
  startNavisworksStatusPolling,
  type OllamaAgentPort,
  type OllamaEndpointOptions,
  type OllamaRunInput,
  type OllamaRunResult,
  type OllamaStreamEvent
} from './ipc'
import { AgentRuntime, type AgentRunEvent } from './agentRuntime'
import { ModelRouter } from './model/modelRouter'
import { JsonSessionRepository, JsonSettingsRepository } from './sessionRepository'
import { denyAllPermissions, installProductionContentSecurityPolicy, secureWindowNavigation } from './security/windowSecurity'
import type { SenderTrustOptions } from './security/validateSender'
import { ToolCatalog } from './toolCatalog'
import { DesktopIpcError, type RuntimeInfo, type ToolName } from '../shared/ipc'

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
  // One runtime serves every run: model/reasoning/disabled-tools and the
  // active API endpoint all arrive per request instead of per instance.
  const runtime = new AgentRuntime({
    bridgeClient: bridge,
    model: persistedSettings?.selectedModel,
    think: persistedSettings?.reasoningMode === 'deep',
    contextWindow: persistedSettings?.contextWindowTokens,
    numPredict: persistedSettings?.numPredict
  })
  const ollama = adaptModelAgent(runtime, new ModelRouter())
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
    senderTrust,
    secrets: {
      encrypt(value) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage unavailable')
        return safeStorage.encryptString(value).toString('base64')
      },
      decrypt(value) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage unavailable')
        return safeStorage.decryptString(Buffer.from(value, 'base64'))
      }
    }
  })
  // Detect Navisworks appearing/disappearing without a manual refresh.
  const disposeStatusPolling = startNavisworksStatusPolling(bridge)

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
    disposeStatusPolling()
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
    width: 1366,
    height: 828,
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

function adaptModelAgent(runtime: AgentRuntime, router: ModelRouter): OllamaAgentPort {
  return {
    // No overrides → the LOCAL Ollama list (model dropdown). Overrides with a
    // baseUrl → list models from that OpenAI-compatible endpoint (the
    // settings page's API-model fetch).
    listModels: async (options, signal) => {
      const baseUrl = options?.baseUrl?.trim()
      if (!baseUrl) return router.local().listModels(signal)
      const provider = router.forEndpoint({
        kind: 'openai',
        baseUrl,
        ...(options?.apiKey ? { apiKey: options.apiKey } : {})
      })
      return provider.listModels(signal)
    },
    // Connectivity-only check for the API endpoint: verifies the address
    // answers (/models), never validates a specific model name.
    testConnection: async (options, signal) => {
      const baseUrl = options?.baseUrl?.trim()
      if (!baseUrl) {
        return { connected: false, message: '云端 API 地址为空。' }
      }
      const provider = router.forEndpoint({
        kind: 'openai',
        baseUrl,
        ...(options?.apiKey ? { apiKey: options.apiKey } : {})
      })
      try {
        const models = await provider.listModels(signal)
        return { connected: true, message: `端点连接正常，共 ${models.length} 个模型` }
      } catch (error) {
        if (signal?.aborted) throw error
        return {
          connected: false,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    },
    run: (input, options) => runAgent(runtime, input, options),
    // Title summaries stay on the local model; the method itself forces a
    // tiny budget so retitleing never competes with the main reply.
    summarizeTitle: (text, signal) => runtime.summarizeTitle(text, signal),
    // Manual /compact follows the active chat endpoint, or the local model.
    compact: (messages, input, options) =>
      runtime.compactConversation(messages, input, options?.signal),
    dispose: () => runtime.dispose()
  }
}

async function runAgent(
  runtime: AgentRuntime,
  input: OllamaRunInput,
  options: {
    signal: AbortSignal
    onEvent: (event: OllamaStreamEvent) => void
    requestToolApproval: (
      toolName: ToolName,
      argumentsValue: Record<string, unknown>
    ) => Promise<boolean>
  }
): Promise<OllamaRunResult> {
  const activeToolCalls = new Map<string, string[]>()
  const onAgentEvent = (event: AgentRunEvent): void => {
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

  const result = await runtime.run(
    {
      text: input.text,
      history: input.history,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningMode === undefined ? {} : { reasoningMode: input.reasoningMode }),
      ...(input.disabledTools === undefined ? {} : { disabledTools: input.disabledTools }),
      ...(input.api === undefined ? {} : { api: input.api })
    },
    {
      signal: options.signal,
      requestToolApproval: options.requestToolApproval,
      onEvent: onAgentEvent
    }
  )
  if (!result.isSuccess) {
    throw new DesktopIpcError('SERVICE_UNAVAILABLE', result.message, {
      code: result.errorCode,
      contextTokensUsed: result.contextTokensUsed
    })
  }
  return {
    content: result.message,
    ...(result.thinkingText === undefined ? {} : { thinkingText: result.thinkingText }),
    ...(result.cacheHitRate === undefined ? {} : { cacheHitRate: result.cacheHitRate }),
    ...(result.compacted ? { compacted: true } : {}),
    contextTokensUsed: result.contextTokensUsed
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
