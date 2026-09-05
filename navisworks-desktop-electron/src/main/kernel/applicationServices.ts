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
import { localThinkForEffort, normalizeReasoningEffort } from '../../shared/reasoning'
import { NavisworksInstanceRegistry } from '../navisworks/instanceRegistry'
import { NavisworksInstanceSelection } from '../navisworks/instanceSelection'
import {
  ContextStateToken,
  ExecutionLedgerToken,
  OperationCoordinatorToken,
  TaskManagerToken,
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
export const NavisworksInstanceRegistryToken = token<NavisworksInstanceRegistry>('app.navisworksInstances')
export const NavisworksInstanceSelectionToken = token<NavisworksInstanceSelection>('app.navisworksSelection')

/** Composition root: instantiate once, register once, and resolve everywhere else. */
export async function installApplicationServices(
  appScope: Scope,
  paths: DesktopDataPaths,
): Promise<AppSettings | null> {
  const sessions = new JsonSessionRepository(paths)
  const settings = new JsonSettingsRepository(paths)
  const persistedSettings = await settings.load()
  const bridge = new NavisworksBridgeClient()
  const instanceRegistry = new NavisworksInstanceRegistry({ bridge })
  const instanceSelection = new NavisworksInstanceSelection()
  const tools = new ToolCatalog()
  const modelRouter = new ModelRouter()
  const approvals = new ToolApprovalRegistry()
  await installAgentServices(appScope, paths)
  const runtime = new AgentRuntime({
    bridgeClient: bridge,
    model: persistedSettings?.selectedModel,
    think: localThinkForEffort(normalizeReasoningEffort(persistedSettings?.reasoningMode)),
    contextWindow: persistedSettings?.contextWindowTokens,
    numPredict: persistedSettings?.numPredict,
    contextState: appScope.require(ContextStateToken),
    executionLedger: appScope.require(ExecutionLedgerToken),
    operationCoordinator: appScope.require(OperationCoordinatorToken),
    taskManager: appScope.require(TaskManagerToken),
    resolveToolResult: (value) => resolveResult(paths.toolResultsDirectory, value),
  })

  appScope
    .register(SessionStoreToken, sessions)
    .register(SettingsStoreToken, settings)
    .register(BridgeClientToken, bridge)
    .register(NavisworksInstanceRegistryToken, instanceRegistry)
    .register(NavisworksInstanceSelectionToken, instanceSelection)
    .register(ToolCatalogToken, tools)
    .register(ModelRouterToken, modelRouter)
    .register(AgentRuntimeToken, runtime)
    .register(CompactionServiceToken, runtime)
    .register(ApprovalServiceToken, approvals)
  appScope.onDispose(() => runtime.dispose())
  return persistedSettings
}
