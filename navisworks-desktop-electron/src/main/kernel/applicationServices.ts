import { AgentRuntime } from '../agentRuntime'
import { resolveResult } from '../agent/toolResultStore'
import { NavisworksBridgeClient } from '../bridgeClient'
import { ToolOutputStore } from '../toolOutputStore'
import type { DesktopDataPaths } from '../dataPaths'
import { ToolApprovalRegistry } from '../ipc'
import { ModelRouter } from '../model/modelRouter'
import { ContextEngine } from '../context/contextEngine'
import { QuestionService } from '../question/questionService'
import { SkillRegistry } from '../skill/skillRegistry'
import { skillRoots } from '../skill/paths'
import { InternalToolExecutor } from '../agent/internalToolExecutor'
import { ContextEpochStore } from '../context/contextEpochStore'
import { contextRegistry } from '../context/contextRegistry'
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
export const ContextEngineToken = token<ContextEngine>('app.contextEngine')
export const QuestionServiceToken = token<QuestionService>('app.questions')

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
  // Context Engine v1: the WHAT of context, durable per-session epochs. One
  // process-level engine shared by the runtime (assembly) and IPC (session
  // cleanup + compaction rollover).
  const contextEngine = new ContextEngine(
    contextRegistry,
    new ContextEpochStore(paths.contextEpochsDirectory),
  )
  // P19 Skills: discover once at startup (no file watching, §50); a broken
  // skill is skipped with a warning, never a failed boot.
  const skillRegistry = new SkillRegistry(skillRoots(paths.rootDirectory))
  try {
    await skillRegistry.discover()
  } catch (error) {
    console.warn(`[skill] discovery failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  // P16 Question service: pending questions are process-memory state; the
  // ChatRunRegistry dispatches `question.requested` to the originating window.
  const questions = new QuestionService()
  const toolOutputStore = new ToolOutputStore(paths.toolOutputDirectory)
  const internalToolExecutor = new InternalToolExecutor(toolOutputStore, skillRegistry)
  const runtime = new AgentRuntime({
    contextEngine,
    internalToolExecutor,
    skillRegistry,
    bridgeClient: bridge,
    model: persistedSettings?.selectedModel,
    think: localThinkForEffort(normalizeReasoningEffort(persistedSettings?.reasoningMode)),
    contextWindow: persistedSettings?.contextWindowTokens,
    numPredict: persistedSettings?.numPredict,
    contextState: appScope.require(ContextStateToken),
    executionLedger: appScope.require(ExecutionLedgerToken),
    operationCoordinator: appScope.require(OperationCoordinatorToken),
    taskManager: appScope.require(TaskManagerToken),
    toolOutputStore,
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
    .register(ContextEngineToken, contextEngine)
    .register(QuestionServiceToken, questions)
    .register(ApprovalServiceToken, approvals)
  appScope.onDispose(() => runtime.dispose())
  return persistedSettings
}
