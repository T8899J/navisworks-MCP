import { AgentRuntime } from '../agentRuntime'
import { resolveResult } from '../agent/toolResultStore'
import { NavisworksBridgeClient } from '../bridgeClient'
import { ToolOutputStore } from '../toolOutputStore'
import type { DesktopDataPaths } from '../dataPaths'
import { ToolApprovalRegistry, startNavisworksInstancesPolling } from '../ipc'
import { ModelRouter } from '../model/modelRouter'
import { ContextEngine } from '../context/contextEngine'
import { QuestionService } from '../question/questionService'
import { SkillRegistry } from '../skill/skillRegistry'
import { skillRoots } from '../skill/paths'
import { InternalToolExecutor } from '../agent/internalToolExecutor'
import { ContextEpochStore } from '../context/contextEpochStore'
import { createContextRegistry } from '../context/contextRegistry'
import { CapabilityRegistry } from '../capability/capabilityRegistry'
import { NavisworksCapabilityProvider } from '../navisworks/capability'
import { NavisworksRunPreflight } from '../navisworks/runPreflight'
import { createToolRegistry } from '../tool/registry'
import type { ToolRegistry } from '../tool/registry'
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
export const CapabilityRegistryToken = token<CapabilityRegistry>('app.capabilities')
/** P30.1: the ONE composed ToolRegistry (internal + capability tools). The
 *  AgentRuntime materializes tools AND the tools.list IPC read this instance
 *  (§7). Production must never reach for the deprecated module singleton. */
export const AgentToolRegistryToken = token<ToolRegistry>('app.agentTools')

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
  // P19 Skills: discover once at startup (no file watching, §50); a broken
  // skill is skipped with a warning, never a failed boot.
  const skillRegistry = new SkillRegistry(skillRoots(paths.rootDirectory))
  try {
    await skillRegistry.discover()
  } catch (error) {
    console.warn(`[skill] discovery failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const contextState = appScope.require(ContextStateToken)
  const executionLedger = appScope.require(ExecutionLedgerToken)
  const operationCoordinator = appScope.require(OperationCoordinatorToken)
  // Capability Architecture v1 (§61): Curi Core is capability-free; the
  // Navisworks professional execution + context + polling are registered as
  // ONE first-party capability provider. Adding Files/Web/Browser later means
  // appending here — never editing AgentRuntime.
  const capabilities = new CapabilityRegistry()
  // P30.3: the run preflight is the capability's OWN — instance discovery,
  // selection, binding and ContextState ingest happen in prepareRun, never in
  // ChatRunRegistry (Invariant B/D). This is the production NavisworksRunPreflight.
  const preflight = new NavisworksRunPreflight({
    instanceRegistry,
    instanceSelection,
    bridge,
    contextState,
  })
  capabilities.register(new NavisworksCapabilityProvider({
    bridge,
    contextState,
    executionLedger,
    operationCoordinator,
    preflight,
    // §18: the Navisworks instance polling is this capability's OWN
    // background work — startAll() starts it, disposeAll() stops it.
    startPolling: () => startNavisworksInstancesPolling(
      instanceRegistry,
      instanceSelection,
      undefined,
      (status) => contextState.observe(status),
    ),
  }))
  await capabilities.startAll()
  // P30.1 single truth: exactly ONE composed ToolRegistry serves model
  // materialization, permission resolution, argument normalization, the
  // tools.list IPC and the Settings UI (§6/§7). The AgentRuntime never
  // builds its own copy and the IPC never reads the legacy singleton.
  const agentTools = createToolRegistry({ capabilities })
  // skills/manifest sits in the fixed baseline slot (core → policy →
  // skills/manifest); when no skills are discovered it contributes NOTHING (§55).
  const contextEngine = new ContextEngine(
    createContextRegistry(capabilities),
    new ContextEpochStore(paths.contextEpochsDirectory),
  )
  // P16 Question service: pending questions are process-memory state; the
  // ChatRunRegistry dispatches `question.requested` to the originating window.
  const questions = new QuestionService()
  const toolOutputStore = new ToolOutputStore(paths.toolOutputDirectory)
  const internalToolExecutor = new InternalToolExecutor(toolOutputStore, skillRegistry)
  const runtime = new AgentRuntime({
    contextEngine,
    internalToolExecutor,
    skillRegistry,
    capabilities,
    // P30.1: the runtime materializes tools from the SAME registry the IPC
    // and Settings UI read (§60/§61).
    tools: agentTools,
    model: persistedSettings?.selectedModel,
    think: localThinkForEffort(normalizeReasoningEffort(persistedSettings?.reasoningMode)),
    contextWindow: persistedSettings?.contextWindowTokens,
    numPredict: persistedSettings?.numPredict,
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
    .register(CapabilityRegistryToken, capabilities)
    .register(AgentToolRegistryToken, agentTools)
    .register(QuestionServiceToken, questions)
    .register(ApprovalServiceToken, approvals)
  appScope.onDispose(() => runtime.dispose())
  return persistedSettings
}
