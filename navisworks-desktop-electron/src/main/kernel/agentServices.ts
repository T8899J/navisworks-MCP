import { ContextState } from '../agent/contextState'
import {
  DocumentOperationCoordinator,
  ExecutionLedgerRepository,
  ToolExecutionLedger,
} from '../agent/executionLedger'
import type { DesktopDataPaths } from '../dataPaths'
import { token, type Scope, type ServiceToken } from './kernel'
import { AgentScopeManager } from './agentScopes'

/** App-scope service tokens (typed DI keys). Consumers resolve these, never singletons. */
export const ContextStateToken = token<ContextState>('agent.contextState')
export const ExecutionLedgerToken = token<ToolExecutionLedger>('agent.executionLedger')
export const OperationCoordinatorToken = token<DocumentOperationCoordinator>('agent.operationCoordinator')
export const AgentScopeManagerToken = token<AgentScopeManager>('agent.scopeManager')

export interface InstalledAgentServices {
  contextState: ContextState
  executionLedger: ToolExecutionLedger
  operationCoordinator: DocumentOperationCoordinator
  scopeManager: AgentScopeManager
}

/**
 * Register the long-lived agent services on the App scope. Returns the same singletons the
 * runtime consumes, now owned by the container so app shutdown disposes them (and, once
 * document-scoped services exist, `appScope.createChild('document', id)` gives them a
 * deterministic teardown alongside the facts / reference-set invalidation the ContextState
 * already performs). The Document/Conversation/Run scopes are provided by the kernel's
 * `createChild` + cascade `dispose` (see kernel.test.ts).
 */
export async function installAgentServices(
  appScope: Scope,
  paths?: Pick<DesktopDataPaths, 'executionLedgerFile' | 'executionLedgerBackupFile'>,
): Promise<InstalledAgentServices> {
  const contextState = new ContextState()
  const executionLedger = new ToolExecutionLedger(paths === undefined
    ? undefined
    : new ExecutionLedgerRepository(paths.executionLedgerFile, paths.executionLedgerBackupFile))
  await executionLedger.initialize()
  const operationCoordinator = new DocumentOperationCoordinator()
  const scopeManager = new AgentScopeManager(appScope)
  contextState.registry.onInvalidate((previous) => {
    if (previous.documentInstanceId !== undefined) {
      void scopeManager.forgetDocument(previous.documentInstanceId)
    }
  })
  appScope
    .register(ContextStateToken, contextState)
    .register(ExecutionLedgerToken, executionLedger)
    .register(OperationCoordinatorToken, operationCoordinator)
    .register(AgentScopeManagerToken, scopeManager)
  return { contextState, executionLedger, operationCoordinator, scopeManager }
}

export type { ServiceToken }
