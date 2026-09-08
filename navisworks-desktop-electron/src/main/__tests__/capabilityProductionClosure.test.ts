import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../agentRuntime'
import { CapabilityRegistry } from '../capability/capabilityRegistry'
import { createToolRegistry } from '../tool/registry'
import { applyLegacyNavisworksRunState } from '../agent/legacyNavisworksAdapter'
import { NavisworksCapabilityProvider } from '../navisworks/capability'
import { ContextState } from '../agent/contextState'
import { createContextRegistry } from '../context/contextRegistry'
import { ContextEngine } from '../context/contextEngine'
import type { ContextSource, ContextSourceEnvironment } from '../context/types'
import type { CapabilityContextFragment } from '../capability/types'
import type {
  CapabilityPreparedRun,
  CapabilityProvider,
  CapabilityRunSet,
  CapabilityToolExecutionInput,
} from '../capability/types'
import type { AgentToolDefinition } from '../tool/registry'

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

function fakeTool(name: string): AgentToolDefinition {
  return {
    name,
    label: name,
    description: `fake ${name}`,
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    category: 'internal',
    origin: { kind: 'capability', capabilityId: 'fake' },
    impact: 'read-only',
    defaultPermission: 'allow',
    contract: {
      type: 'function',
      function: { name, description: `fake ${name}`, parameters: { type: 'object', properties: {} } },
      impact: 'read-only',
    },
  }
}

function fakeProvider(captureState: unknown[]): CapabilityProvider {
  return {
    manifest: { id: 'fake', name: 'Fake', description: 'fake', version: 1, firstParty: false },
    tools: () => [fakeTool('fake_echo')],
    contextSources: () => [],
    ownsTool: (name) => name === 'fake_echo',
    normalizeArguments: (_n, args) => args,
    prepareRun: async (): Promise<CapabilityPreparedRun> => ({ capabilityId: 'fake', state: { ready: true } }),
    executeTool: async (input: CapabilityToolExecutionInput) => {
      captureState.push(input.state)
      return { result: { ok: true } }
    },
  }
}

const LEGACY_BINDING = {
  instanceId: 'bridge-a',
  bridgeSessionId: 'bridge-a',
  documentInstanceId: 'doc-a',
  documentName: 'Model-A.nwf',
}

describe('P30.4 legacy Navisworks fields never pollute other capabilities (§26/§27/§87)', () => {
  it('applyLegacyNavisworksRunState folds flat fields into the navisworks entry ONLY', () => {
    const registry = new CapabilityRegistry([
      fakeProvider([]),
      new NavisworksCapabilityProvider({ bridge: { async call<T>() { return {} as T } } as never }),
    ])
    const base: CapabilityRunSet = new Map([
      ['fake', { capabilityId: 'fake', state: { ready: true } }],
      ['navisworks', { capabilityId: 'navisworks', state: {} }],
    ])
    const merged = applyLegacyNavisworksRunState(registry, base, {
      binding: LEGACY_BINDING,
      currentDocument: { connected: true },
    })
    // Fake capability state is byte-for-byte untouched.
    expect(merged.get('fake')?.state).toEqual({ ready: true })
    // Navisworks state carries the legacy fields.
    expect(merged.get('navisworks')?.state).toMatchObject({ binding: LEGACY_BINDING })
  })

  it('with NO Navisworks capability registered the merge is a total no-op (§26)', () => {
    const registry = new CapabilityRegistry([fakeProvider([])])
    const base: CapabilityRunSet = new Map([
      ['fake', { capabilityId: 'fake', state: { ready: true } }],
    ])
    const merged = applyLegacyNavisworksRunState(registry, base, {
      binding: LEGACY_BINDING,
      unavailable: { code: 'TARGET_INSTANCE_DISCONNECTED', message: 'x' },
      currentDocument: { connected: true },
    })
    expect(merged.get('fake')?.state).toEqual({ ready: true })
    expect(merged.size).toBe(1)
  })

  it('an end-to-end legacy run hands the Fake provider NO binding/currentDocument/unavailable', async () => {
    const states: unknown[] = []
    const capabilities = new CapabilityRegistry([fakeProvider(states)])
    let turn = 0
    const fetchImpl = vi.fn(async () => {
      turn += 1
      return turn === 1
        ? ndjson([{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'c1', function: { index: 0, name: 'fake_echo', arguments: { text: 'hi' } } },
        ] } }])
        : ndjson([{ message: { role: 'assistant', content: '完成。' } }])
    }) as unknown as typeof fetch
    const runtime = new AgentRuntime({
      capabilities,
      tools: createToolRegistry({ capabilities }),
      fetchImpl,
    })
    const result = await runtime.run({
      sessionId: 's1',
      text: 'say hi',
      // @deprecated legacy fields — a legacy test sets them; they must stay out
      // of the Fake provider's state entirely.
      navisworksBinding: LEGACY_BINDING,
      navisworksUnavailable: { code: 'TARGET_INSTANCE_DISCONNECTED', message: 'x' },
      currentDocument: { connected: true, documentName: 'Model-A.nwf' },
    })
    expect(result.isSuccess).toBe(true)
    expect(states).toHaveLength(1)
    const fakeState = states[0] as Record<string, unknown>
    expect(fakeState).not.toHaveProperty('binding')
    expect(fakeState).not.toHaveProperty('currentDocument')
    expect(fakeState).not.toHaveProperty('unavailable')
    expect(fakeState).toMatchObject({ ready: true })
  })
})

describe('P30.5 run outcome reaches finishRun correctly (§88/§72)', () => {
  function runFinisher(outcomes: string[]): { capabilities: CapabilityRegistry; tools: ReturnType<typeof createToolRegistry> } {
    const provider: CapabilityProvider = {
      manifest: { id: 'fake', name: 'Fake', description: 'fake', version: 1, firstParty: false },
      tools: () => [fakeTool('fake_echo')],
      contextSources: () => [],
      ownsTool: (name) => name === 'fake_echo',
      normalizeArguments: (_n, args) => args,
      prepareRun: async () => ({ capabilityId: 'fake', state: { ready: true } }),
      executeTool: async () => ({ result: { ok: true } }),
      finishRun: (input) => { outcomes.push(input.outcome) },
    }
    const capabilities = new CapabilityRegistry([provider])
    return { capabilities, tools: createToolRegistry({ capabilities }) }
  }

  it('a successful run finalizes with outcome=completed', async () => {
    const outcomes: string[] = []
    const { capabilities, tools } = runFinisher(outcomes)
    const fetchImpl = vi.fn(async () => ndjson([{ message: { role: 'assistant', content: '完成。' } }])) as unknown as typeof fetch
    const runtime = new AgentRuntime({ capabilities, tools, fetchImpl })
    const result = await runtime.run({ sessionId: 's1', text: 'hi' })
    expect(result.isSuccess).toBe(true)
    expect(outcomes).toEqual(['completed'])
  })

  it('a model failure finalizes with outcome=failed (never overwrites the error) (§32)', async () => {
    const outcomes: string[] = []
    const { capabilities, tools } = runFinisher(outcomes)
    const fetchImpl = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
    const runtime = new AgentRuntime({ capabilities, tools, fetchImpl })
    const result = await runtime.run({ sessionId: 's1', text: 'hi' })
    expect(result.isSuccess).toBe(false)
    expect(outcomes).toEqual(['failed'])
  })

  it('an aborted run finalizes with outcome=aborted; the finish error never masks CANCELLED (§72)', async () => {
    const outcomes: string[] = []
    const provider: CapabilityProvider = {
      manifest: { id: 'fake', name: 'Fake', description: 'fake', version: 1, firstParty: false },
      tools: () => [fakeTool('fake_echo')],
      contextSources: () => [],
      ownsTool: (name) => name === 'fake_echo',
      normalizeArguments: (_n, args) => args,
      prepareRun: async () => ({ capabilityId: 'fake', state: { ready: true } }),
      executeTool: async () => ({ result: { ok: true } }),
      // finishRun throwing must NOT override the abort (registry isolates).
      finishRun: (input) => { outcomes.push(input.outcome); throw new Error('finish exploded') },
    }
    const capabilities = new CapabilityRegistry([provider])
    const tools = createToolRegistry({ capabilities })
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))
    const fetchImpl = vi.fn(async () => ndjson([{ message: { role: 'assistant', content: 'x' } }])) as unknown as typeof fetch
    const runtime = new AgentRuntime({ capabilities, tools, fetchImpl })
    await expect(
      runtime.run({ sessionId: 's1', text: 'hi' }, { signal: controller.signal }),
    ).rejects.toThrow()
    expect(outcomes).toEqual(['aborted'])
  })
})

describe('P30.5 Navisworks finishRun migrates markDocumentSeen (§28/§31)', () => {
  function providerWithSeen(sessionId: string): { provider: NavisworksCapabilityProvider; contextState: ContextState; revision: number } {
    const contextState = new ContextState()
    contextState.observe({ connected: true, documentInstanceId: 'doc-A', bridgeSessionId: 'b1' })
    // Establish the session has SEEN the current revision, then switch docs so a
    // transition becomes pending.
    contextState.markDocumentSeen(sessionId, contextState.documentRevision)
    contextState.observe({ connected: true, documentInstanceId: 'doc-B', bridgeSessionId: 'b1' })
    const revision = contextState.documentRevision
    const provider = new NavisworksCapabilityProvider({
      bridge: { async call<T>() { return {} as T } } as unknown as never,
      contextState,
    })
    return { provider, contextState, revision }
  }

  it('completed advances the seen marker (notice consumed)', () => {
    const sessionId = 's1'
    const { provider, contextState, revision } = providerWithSeen(sessionId)
    expect(contextState.documentNoticeForSession(sessionId)).toBeDefined()
    provider.finishRun({ outcome: 'completed', sessionId, state: { observedDocumentRevision: revision } })
    expect(contextState.documentNoticeForSession(sessionId)).toBeUndefined()
  })

  it('failed / aborted leave the transition pending (re-shown next run)', () => {
    for (const outcome of ['failed', 'aborted'] as const) {
      const sessionId = `s-${outcome}`
      const { provider, contextState, revision } = providerWithSeen(sessionId)
      provider.finishRun({ outcome, sessionId, state: { observedDocumentRevision: revision } })
      expect(contextState.documentNoticeForSession(sessionId)).toBeDefined()
    }
  })

  it('no sessionId / no revision in state → no-op', () => {
    const { provider, contextState, revision } = providerWithSeen('s9')
    provider.finishRun({ outcome: 'completed', state: {} })
    expect(contextState.documentNoticeForSession('s9')).toBeDefined()
    provider.finishRun({ outcome: 'completed', sessionId: 's9', state: { observedDocumentRevision: revision } })
    expect(contextState.documentNoticeForSession('s9')).toBeUndefined()
  })
})

describe('P30.8 namespaced capability context (§44/§45/§50/§91)', () => {
  it('contributeContext returns fragments keyed by capability id, never flattened', async () => {
    const fakeProvider: CapabilityProvider = {
      manifest: { id: 'fake', name: 'Fake', description: 'fake', version: 1, firstParty: false },
      tools: () => [],
      contextSources: () => [],
      ownsTool: () => false,
      normalizeArguments: (_n, args) => args,
      prepareRun: async () => ({ capabilityId: 'fake', state: { ready: true } }),
      contributeContext: (): CapabilityContextFragment => ({ workspace: 'fake-ws', cwd: '/tmp' }),
      executeTool: async () => ({ result: {} }),
    }
    const navisworks: CapabilityProvider = {
      manifest: { id: 'navisworks', name: 'N', description: 'n', version: 1, firstParty: true },
      tools: () => [],
      contextSources: () => [],
      ownsTool: () => false,
      normalizeArguments: (_n, args) => args,
      prepareRun: async () => ({ capabilityId: 'navisworks', state: {} }),
      contributeContext: (): CapabilityContextFragment => ({ document: { connected: true }, contextState: 'handle' }),
      executeTool: async () => ({ result: {} }),
    }
    const registry = new CapabilityRegistry([fakeProvider, navisworks])
    const states = await registry.prepareRuns({ runId: 'r1' })
    const namespaced = registry.contributeContext(states, { sessionId: 's1' })
    // Two capabilities both contributing their OWN keys, kept separate.
    expect(Object.keys(namespaced).sort()).toEqual(['fake', 'navisworks'])
    expect(namespaced.fake).toEqual({ workspace: 'fake-ws', cwd: '/tmp' })
    expect(namespaced.navisworks).toMatchObject({ document: { connected: true } })
  })

  it('a fake capability source reads env.capabilities.fake with NO new core field (§50/§91)', async () => {
    // The ONLY way this source gets its value is the generic namespaced
    // `capabilities` environment field — ContextSourceEnvironment was NOT
    // extended with a `workspace` field, proving the engine serves new
    // capabilities without core changes.
    let sawWorkspace: unknown = 'UNSET'
    const fakeSource: ContextSource<string> = {
      key: 'fake/workspace',
      version: 1,
      mode: 'baseline',
      load(env: ContextSourceEnvironment) {
        const slice = (env.capabilities as Record<string, { workspace?: unknown }> | undefined)?.fake
        sawWorkspace = slice?.workspace
        return slice?.workspace === undefined ? undefined : `WORKSPACE=${String(slice.workspace)}`
      },
      fingerprint: (value) => String(value),
      render: (value) => value,
    }
    const provider: CapabilityProvider = {
      manifest: { id: 'fake', name: 'Fake', description: 'fake', version: 1, firstParty: false },
      tools: () => [],
      contextSources: () => [fakeSource],
      ownsTool: () => false,
      normalizeArguments: (_n, args) => args,
      prepareRun: async () => ({ capabilityId: 'fake', state: { ready: true } }),
      contributeContext: (): CapabilityContextFragment => ({ workspace: 'fake-root' }),
      executeTool: async () => ({ result: {} }),
    }
    const capabilities = new CapabilityRegistry([provider])
    const engine = new ContextEngine(createContextRegistry(capabilities), undefined)
    const states = await capabilities.prepareRuns({ runId: 'r1' })
    const assembly = await engine.prepare('s1', {
      sessionId: 's1',
      capabilities: capabilities.contributeContext(states, { sessionId: 's1' }),
    })
    expect(sawWorkspace).toBe('fake-root')
    expect(assembly.baseline).toContain('WORKSPACE=fake-root')
  })
})
