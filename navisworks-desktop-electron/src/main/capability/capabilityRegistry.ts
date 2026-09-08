import type { AgentToolDefinition } from '../tool/registry'
import type { ContextSource, ContextSourceMode } from '../context/types'
import type {
  CapabilityExecutionScope,
  CapabilityPreparedRun,
  CapabilityProvider,
  CapabilityRunFinishInput,
  CapabilityRunOutcome,
  CapabilityRunPrepareInput,
  CapabilityRunSet,
  CapabilityToolExecutionInput,
  CapabilityToolExecutionResult,
} from './types'

/**
 * P22 CapabilityRegistry: the only routing table between the Tool Runtime and
 * capability providers. Invariants enforced AT REGISTRATION (§15):
 *  - capability ids unique            → duplicate refuses startup
 *  - tool names globally unique         → duplicate refuses startup (never last-write-wins)
 *  - context source keys globally unique → duplicate refuses startup (§112)
 * Order is the EXPLICIT registration order (§16) — never filesystem scans,
 * never Object.keys accidents.
 */
export class CapabilityRegistry {
  readonly #providers: CapabilityProvider[] = []
  readonly #byId = new Map<string, CapabilityProvider>()
  readonly #toolOwners = new Map<string, CapabilityProvider>()

  constructor(providers: readonly CapabilityProvider[] = []) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: CapabilityProvider): void {
    const id = provider.manifest.id
    if (!id.trim()) {
      throw new Error('Capability id 不能为空。')
    }
    if (this.#byId.has(id)) {
      throw new Error(`重复的 Capability id: ${id}`)
    }
    for (const definition of provider.tools()) {
      const existing = this.#toolOwners.get(definition.name)
      if (existing !== undefined) {
        throw new Error(
          `重复的 Tool name: ${definition.name}（${existing.manifest.id} 与 ${id} 冲突，拒绝启动）`,
        )
      }
    }
    for (const source of provider.contextSources()) {
      if (this.#contextSourceKeys().has(source.key)) {
        throw new Error(`重复的 Context Source key: ${source.key}（来自 capability ${id}，拒绝启动）`)
      }
    }
    for (const definition of provider.tools()) {
      this.#toolOwners.set(definition.name, provider)
    }
    this.#byId.set(id, provider)
    this.#providers.push(provider)
  }

  list(): readonly CapabilityProvider[] {
    return [...this.#providers]
  }

  get(id: string): CapabilityProvider | undefined {
    return this.#byId.get(id)
  }

  /** Registry-based routing (§98): tool name → owning provider, no prefix sniffing. */
  ownerForTool(toolName: string): CapabilityProvider | undefined {
    return this.#toolOwners.get(toolName)
  }

  toolDefinitions(): readonly AgentToolDefinition[] {
    return this.#providers.flatMap((provider) => [...provider.tools()])
  }

  /** Contributed context sources, grouped by mode, in registration order. */
  contextSourcesByMode(mode: ContextSourceMode): readonly ContextSource<unknown>[] {
    return this.#providers.flatMap((provider) =>
      provider.contextSources().filter((source) => source.mode === mode),
    )
  }

  allContextSources(): readonly ContextSource<unknown>[] {
    return this.#providers.flatMap((provider) => [...provider.contextSources()])
  }

  /** Stable opaque scope contribution for the doom loop (§28): provider-defined,
   *  core never interprets. Unknown tools contribute an empty scope. */
  executionScopeFor(toolName: string, runSet: CapabilityRunSet): CapabilityExecutionScope {
    const owner = this.#toolOwners.get(toolName)
    if (owner === undefined) return {}
    const prepared = runSet.get(owner.manifest.id)
    if (prepared === undefined || owner.executionScope === undefined) return {}
    return owner.executionScope(prepared.state)
  }

  /**
   * Prepare every provider for one run. A provider's preflight failure must
   * never break the chat run (§105): skip that capability's state and keep
   * going — availability is NOT registration.
   */
  async prepareRuns(input: CapabilityRunPrepareInput): Promise<CapabilityRunSet> {
    const states = new Map<string, CapabilityPreparedRun>()
    for (const provider of this.#providers) {
      if (provider.prepareRun === undefined) continue
      try {
        const prepared = await provider.prepareRun(input)
        if (prepared.capabilityId !== provider.manifest.id) {
          throw new Error(`prepareRun 返回了错误的 capabilityId: ${prepared.capabilityId}`)
        }
        states.set(provider.manifest.id, prepared)
      } catch (error) {
        console.debug(
          `[capability] prepare failed id=${provider.manifest.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return states
  }

  async executeTool(input: CapabilityToolExecutionInput): Promise<CapabilityToolExecutionResult> {
    const owner = this.#toolOwners.get(input.toolName)
    if (owner === undefined) {
      // §111: unknown tools never fan out to providers. The core ToolRegistry
      // already rejects them upstream; this is the last defensive gate.
      return { error: { code: 'TOOL_NOT_ALLOWED', message: `工具不在允许列表中：${input.toolName}` } }
    }
    return owner.executeTool(input)
  }

  /** Post-bounding observation fan-out to the owning provider (facts, reference sets). */
  observeModelResult(toolName: string, observation: Parameters<NonNullable<CapabilityProvider['observeModelResult']>>[0]): void {
    this.#toolOwners.get(toolName)?.observeModelResult?.(observation)
  }

  /**
   * P30.5 run finalization for every provider that prepared a run. Mirrors
   * prepareRuns (§32): a single provider's finish failure is logged as a
   * warning and ISOLATED — it can neither block another capability's cleanup
   * nor override the user's already-produced answer (§30). It never throws.
   */
  async finishRuns(
    runSet: CapabilityRunSet,
    outcome: CapabilityRunOutcome,
    input: { runId: string; sessionId?: string },
  ): Promise<void> {
    for (const provider of this.#providers) {
      if (provider.finishRun === undefined) continue
      const prepared = runSet.get(provider.manifest.id)
      if (prepared === undefined) continue
      const finishInput: CapabilityRunFinishInput = {
        runId: input.runId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        state: prepared.state,
        outcome,
      }
      try {
        await provider.finishRun(finishInput)
      } catch (error) {
        console.warn(
          `[capability] finish failed id=${provider.manifest.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * P30.8 (§45): collect every provider's context fragment, NAMESPACED by
   * capability id — `{ navisworks: {…}, files: {…} }` — never flattened into
   * one shared object. That removes the whole class of cross-capability key
   * collisions (two capabilities both contributing `document` / `state` /
   * `revision`), and means adding a capability never requires a new core
   * ContextSourceEnvironment field. The core stores each value opaquely.
   */
  contributeContext(
    runSet: CapabilityRunSet,
    ctx: { sessionId?: string },
  ): Readonly<Record<string, import('./types').CapabilityContextFragment>> {
    const namespaced: Record<string, import('./types').CapabilityContextFragment> = {}
    for (const provider of this.#providers) {
      if (provider.contributeContext === undefined) continue
      const prepared = runSet.get(provider.manifest.id)
      if (prepared === undefined) continue
      const fragment = provider.contributeContext(prepared.state, ctx)
      namespaced[provider.manifest.id] = fragment
    }
    return namespaced
  }

  async startAll(): Promise<void> {
    for (const provider of this.#providers) {
      try {
        await provider.start?.()
        console.debug(`[capability] started id=${provider.manifest.id}`)
      } catch (error) {
        // A failing provider start must not take down the app nor the others.
        console.warn(`[capability] start failed id=${provider.manifest.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async disposeAll(): Promise<void> {
    const failures: string[] = []
    for (const provider of this.#providers) {
      try {
        await provider.dispose?.()
      } catch (error) {
        failures.push(`${provider.manifest.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length > 0) {
      console.warn(`[capability] dispose failures: ${failures.join('; ')}`)
    }
  }

  #contextSourceKeys(): Set<string> {
    const keys = new Set<string>()
    for (const provider of this.#providers) {
      for (const source of provider.contextSources()) keys.add(source.key)
    }
    return keys
  }
}
