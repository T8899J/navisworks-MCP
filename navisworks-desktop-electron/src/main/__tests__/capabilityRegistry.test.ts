import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../capability/capabilityRegistry'
import type {
  CapabilityManifest,
  CapabilityPreparedRun,
  CapabilityProvider,
  CapabilityToolExecutionInput,
  CapabilityToolExecutionResult,
} from '../capability/types'
import type { AgentToolDefinition } from '../tool/registry'
import type { ContextSource } from '../context/types'
import { createToolRegistry } from '../tool/registry'
import { createContextRegistry } from '../context/contextRegistry'

function manifest(over: Partial<CapabilityManifest> & { id: string }): CapabilityManifest {
  return { name: over.id, description: 'test capability', version: 1, firstParty: false, ...over }
}

function toolDef(name: string, capabilityId: string): AgentToolDefinition {
  return {
    name,
    label: name,
    description: `fake tool ${name}`,
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    category: 'internal',
    origin: { kind: 'capability', capabilityId },
    impact: 'read-only',
    defaultPermission: 'allow',
    contract: {
      type: 'function',
      function: { name, description: `fake tool ${name}`, parameters: { type: 'object', properties: { text: { type: 'string' } } } },
      impact: 'read-only',
    },
  }
}

function stringSource(key: string, mode: ContextSource<unknown>['mode'], text: string): ContextSource<unknown> {
  return {
    key,
    version: 1,
    mode,
    load: () => text,
    fingerprint: (value) => String(value),
    render: (value) => String(value),
  }
}

interface FakeProviderOptions {
  id: string
  tools?: string[]
  sources?: ContextSource<unknown>[]
  failPrepare?: boolean
  throwOnExecute?: boolean
  startSpy?: () => void
  disposeSpy?: () => void
  throwOnDispose?: boolean
  scope?: Record<string, string | number | null>
  normalizeSpy?: (name: string, args: Record<string, unknown>) => Record<string, unknown>
  finishSpy?: (outcome: string, state: unknown) => void
  throwOnFinish?: boolean
}

function fakeProvider(options: FakeProviderOptions): CapabilityProvider {
  const id = options.id
  return {
    manifest: manifest({ id }),
    tools: () => (options.tools ?? ['fake_echo']).map((name) => toolDef(name, id)),
    contextSources: () => options.sources ?? [],
    ownsTool: (name) => (options.tools ?? ['fake_echo']).includes(name),
    normalizeArguments: options.normalizeSpy ?? ((_name, args) => args),
    prepareRun: async (): Promise<CapabilityPreparedRun> => {
      if (options.failPrepare) throw new Error('preflight exploded')
      return { capabilityId: id, state: { preparedBy: id } }
    },
    executionScope: () => options.scope ?? {},
    executeTool: async (input: CapabilityToolExecutionInput): Promise<CapabilityToolExecutionResult> => {
      if (options.throwOnExecute) throw new Error('provider exploded')
      return { result: { echo: String((input.arguments as { text?: string }).text ?? '') } }
    },
    finishRun: options.finishSpy
      ? (input) => {
        if (options.throwOnFinish) throw new Error('finish exploded')
        options.finishSpy!(input.outcome, input.state)
      }
      : undefined,
    start: options.startSpy,
    dispose: options.disposeSpy
      ?? (options.throwOnDispose ? () => { throw new Error('dispose exploded') } : undefined),
  }
}

describe('CapabilityRegistry invariants (§15/§76/§77/§112)', () => {
  it('duplicate capability id refuses startup', () => {
    const registry = new CapabilityRegistry()
    registry.register(fakeProvider({ id: 'alpha' }))
    expect(() => registry.register(fakeProvider({ id: 'alpha' }))).toThrow(/重复的 Capability id/)
  })

  it('duplicate tool name across two capabilities refuses startup — never last-write-wins', () => {
    const registry = new CapabilityRegistry()
    registry.register(fakeProvider({ id: 'alpha', tools: ['same_tool'] }))
    expect(() => registry.register(fakeProvider({ id: 'beta', tools: ['same_tool'] })))
      .toThrow(/重复的 Tool name.*same_tool/)
  })

  it('duplicate context source key across capabilities refuses startup (§112)', () => {
    const registry = new CapabilityRegistry()
    // Distinct tool names so ONLY the context-source key collides.
    registry.register(fakeProvider({ id: 'alpha', tools: ['a_tool'], sources: [stringSource('dup/key', 'baseline', 'a')] }))
    expect(() => registry.register(fakeProvider({ id: 'beta', tools: ['b_tool'], sources: [stringSource('dup/key', 'baseline', 'b')] })))
      .toThrow(/重复的 Context Source key/)
  })

  it('routing is by registration map, not prefixes (§98)', () => {
    const registry = new CapabilityRegistry()
    const alpha = fakeProvider({ id: 'alpha', tools: ['navisworks_forged'] })
    const beta = fakeProvider({ id: 'beta', tools: ['beta_tool'] })
    registry.register(alpha)
    registry.register(beta)
    expect(registry.ownerForTool('navisworks_forged')).toBe(alpha)
    expect(registry.ownerForTool('beta_tool')).toBe(beta)
    expect(registry.ownerForTool('unknown_tool')).toBeUndefined()
  })
})

describe('Capability lifecycle (§109)', () => {
  it('startAll reaches every provider once; a failing start never blocks the others', async () => {
    const startA = vi.fn(() => { throw new Error('start exploded') })
    const startB = vi.fn()
    const registry = new CapabilityRegistry([
      fakeProvider({ id: 'a', tools: ['a_tool'], startSpy: startA }),
      fakeProvider({ id: 'b', tools: ['b_tool'], startSpy: startB }),
    ])
    await registry.startAll()
    expect(startA).toHaveBeenCalledTimes(1)
    expect(startB).toHaveBeenCalledTimes(1)
  })

  it('a throwing dispose still lets every other provider clean up (§63)', async () => {
    const disposeB = vi.fn()
    const registry = new CapabilityRegistry([
      fakeProvider({ id: 'a', tools: ['a_tool'], throwOnDispose: true }),
      fakeProvider({ id: 'b', tools: ['b_tool'], disposeSpy: disposeB }),
    ])
    await expect(registry.disposeAll()).resolves.toBeUndefined()
    expect(disposeB).toHaveBeenCalledTimes(1)
  })

  it('prepareRuns: one provider failing preflight skips ONLY that capability (§105)', async () => {
    const registry = new CapabilityRegistry([
      fakeProvider({ id: 'good', tools: ['good_tool'] }),
      fakeProvider({ id: 'broken', tools: ['broken_tool'], failPrepare: true }),
    ])
    const states = await registry.prepareRuns({ runId: 'r1' })
    expect(states.has('good')).toBe(true)
    expect(states.has('broken')).toBe(false)
  })
})

describe('P30.5 finishRuns lifecycle (§30/§32/§88)', () => {
  it('reaches every prepared provider with the run outcome + its own state', async () => {
    const seen: Array<{ id: string; outcome: string; state: unknown }> = []
    const registry = new CapabilityRegistry([
      fakeProvider({ id: 'a', tools: ['a_tool'], finishSpy: (o, s) => seen.push({ id: 'a', outcome: o, state: s }) }),
      fakeProvider({ id: 'b', tools: ['b_tool'], finishSpy: (o, s) => seen.push({ id: 'b', outcome: o, state: s }) }),
    ])
    const states = await registry.prepareRuns({ runId: 'r1' })
    await registry.finishRuns(states, 'completed', { runId: 'r1', sessionId: 's1' })
    expect(seen).toHaveLength(2)
    expect(seen.map((entry) => entry.id).sort()).toEqual(['a', 'b'])
    expect(seen.every((entry) => entry.outcome === 'completed')).toBe(true)
    expect(seen[0]?.state).toEqual({ preparedBy: seen[0]?.id })
  })

  it('a provider with no prepared state is skipped; no hook means no call (§30)', async () => {
    const finishSpy = vi.fn()
    const registry = new CapabilityRegistry([
      fakeProvider({ id: 'ok', tools: ['ok_tool'], finishSpy }),
      fakeProvider({ id: 'willfail', tools: ['f_tool'], failPrepare: true, finishSpy }),
    ])
    const states = await registry.prepareRuns({ runId: 'r1' })
    await registry.finishRuns(states, 'failed', { runId: 'r1' })
    // 'willfail' never prepared → finishRun is NOT invoked for it; only 'ok'.
    expect(finishSpy).toHaveBeenCalledTimes(1)
  })

  it('one provider throwing in finishRun never blocks the others (§30/§72)', async () => {
    const finishB = vi.fn()
    const registry = new CapabilityRegistry([
      fakeProvider({ id: 'a', tools: ['a_tool'], throwOnFinish: true }),
      fakeProvider({ id: 'b', tools: ['b_tool'], finishSpy: finishB }),
    ])
    const states = await registry.prepareRuns({ runId: 'r1' })
    await expect(registry.finishRuns(states, 'aborted', { runId: 'r1' })).resolves.toBeUndefined()
    expect(finishB).toHaveBeenCalledTimes(1)
  })
})

describe('ToolRegistry composition (§15 internal/capability collision)', () => {
  it('a capability trying to shadow an internal tool name refuses startup', () => {
    const registry = new CapabilityRegistry([
      fakeProvider({ id: 'evil', tools: ['question'] }),
    ])
    expect(() => createToolRegistry({ capabilities: registry })).toThrow(/question/)
  })
})

describe('P30.2 argument normalization routes through the owning provider (§12/§85)', () => {
  it('a capability tool is normalized by ITS provider, not a hardcoded catalog', () => {
    const normalizeSpy = vi.fn((name: string, args: Record<string, unknown>) => ({
      ...args,
      normalizedBy: name,
    }))
    const registry = new CapabilityRegistry([
      fakeProvider({ id: 'fake', tools: ['fake_echo'], normalizeSpy }),
    ])
    const tools = createToolRegistry({ capabilities: registry })

    const out = tools.normalizeArguments('fake_echo', { text: 'hi' })
    // The FAKE provider ran normalization — proving the core does not only
    // support Navisworks and keys off origin.capabilityId, never category.
    expect(out).toEqual({ text: 'hi', normalizedBy: 'fake_echo' })
    expect(normalizeSpy).toHaveBeenCalledWith('fake_echo', { text: 'hi' })
  })

  it('internal tools pass through normalization unchanged (§12)', () => {
    const tools = createToolRegistry({})
    expect(tools.normalizeArguments('question', { questions: [] })).toEqual({ questions: [] })
  })

  it('assertAllowed checks registration + args-object only, never a Navisworks category (§13)', () => {
    const registry = new CapabilityRegistry([fakeProvider({ id: 'fake', tools: ['fake_echo'] })])
    const tools = createToolRegistry({ capabilities: registry })
    expect(() => tools.assertAllowed('fake_echo', {})).not.toThrow()
    expect(() => tools.assertAllowed('nope', {})).toThrow(/工具不在允许列表中/)
    expect(() => tools.assertAllowed('fake_echo', [])).toThrow(/arguments 必须是对象/)
  })
})

describe('ContextRegistry composition (§37/§78/§79/§80)', () => {
  it('core-only registry baseline excludes capability sources entirely (§37/§78)', async () => {
    const coreOnly = createContextRegistry()
    const baseline = coreOnly.listByMode('baseline').map((source) => source.key)
    expect(baseline).not.toContain('policy/navisworks')
    expect(baseline).not.toContain('navisworks/document')
    expect(coreOnly.listByMode('durable')).toHaveLength(0)
    expect(coreOnly.list().map((source) => source.key)).not.toContain('document/verified-facts')
  })

  it('registered capability sources interleave into the FIXED global order (§79)', () => {
    const registry = new CapabilityRegistry([
      fakeProvider({
        id: 'fake',
        sources: [
          stringSource('fake/policy', 'baseline', 'p'),
          stringSource('fake/durable', 'durable', 'd'),
          stringSource('fake/volatile', 'volatile', 'v'),
        ],
      }),
    ])
    const composed = createContextRegistry(registry)
    expect(composed.list().map((source) => source.key)).toEqual([
      'core/identity',
      'fake/policy',
      'skills/manifest',
      'fake/durable',
      'session/compact-summary',
      'task/state',
      'session/semantic-memory',
      'fake/volatile',
    ])
  })

  it('same capability set twice → identical ordered sources (§80 stability)', () => {
    const build = () => createContextRegistry(new CapabilityRegistry([
      fakeProvider({ id: 'fake', sources: [stringSource('fake/x', 'volatile', 'v')] }),
    ])).list().map((source) => source.key)
    expect(build()).toEqual(build())
  })
})
