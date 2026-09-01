import { AgentRuntime } from '../agentRuntime'
import { resolveResult } from '../agent/toolResultStore'
import { NavisworksBridgeClient } from '../bridgeClient'
import type { DesktopDataPaths } from '../dataPaths'
import { ToolApprovalRegistry } from '../ipc'
import { ModelRouter } from '../model/modelRouter'
import {
  JsonSessionRepository,
  JsonSettingsRepository,
  type AppSettings,
} from '../sessionRepository'
import { ToolCatalog } from '../toolCatalog'
import {
  ContextStateToken,
  ExecutionLedgerToken,
  OperationCoordinatorToken,
  installAgentServices,
} from './agentServices'
import { token, type Scope } from './kernel'

export const BridgeClientToken = token<NavisworksBridgeClient>('app.navisworks')
export const ToolCatalogToken = token<ToolCatalog>('app.tools')
export const ModelRouterToken = token<ModelRouter>('app.models')
export const SessionStoreToken = token<JsonSessionRepository>('app.sessions')
export const SettingsStoreToken = token<JsonSettingsRepository>('app.settings')
export const AgentRuntimeToken = token<AgentRuntime>('app.agentRuntime')
export const CompactionServiceToken = token<Pick<AgentRuntime, 'compactConversation'>>('app.compaction')
export const ApprovalServiceToken = token<ToolApprovalRegistry>('app.approvals')

/** Composition root: instantiate once, register once, and resolve everywhere else. */
export async function installApplicationServices(
  appScope: Scope,
  paths: DesktopDataPaths,
): Promise<AppSettings | null> {
  const sessions = new JsonSessionRepository(paths)
  const settings = new JsonSettingsRepository(paths)
  const persistedSettings = await settings.load()
  const bridge = new NavisworksBridgeClient()
  const tools = new ToolCatalog()
  const modelRouter = new ModelRouter()
  const approvals = new ToolApprovalRegistry()
  await installAgentServices(appScope, paths)
  const removeApprovalInvalidation = appScope.require(ContextStateToken).registry.onInvalidate(
    (previous) => {
      if (previous.documentInstanceId !== undefined) {
        approvals.cancelForDocument(previous.documentInstanceId)
      }
    },
  )
  const runtime = new AgentRuntime({
    bridgeClient: bridge,
    model: persistedSettings?.selectedModel,
    think: persistedSettings?.reasoningMode === 'deep',
    contextWindow: persistedSettings?.contextWindowTokens,
    numPredict: persistedSettings?.numPredict,
    contextState: appScope.require(ContextStateToken),
    executionLedger: appScope.require(ExecutionLedgerToken),
    operationCoordinator: appScope.require(OperationCoordinatorToken),
    resolveToolResult: (value) => resolveResult(paths.toolResultsDirectory, value),
  })

  appScope
    .register(SessionStoreToken, sessions)
    .register(SettingsStoreToken, settings)
    .register(BridgeClientToken, bridge)
    .register(ToolCatalogToken, tools)
    .register(ModelRouterToken, modelRouter)
    .register(AgentRuntimeToken, runtime)
    .register(CompactionServiceToken, runtime)
    .register(ApprovalServiceToken, approvals)
  appScope.onDispose(() => runtime.dispose())
  appScope.onDispose(removeApprovalInvalidation)
  return persistedSettings
}
