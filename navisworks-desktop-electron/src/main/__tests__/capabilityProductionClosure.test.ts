import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../agentRuntime'
import { CapabilityRegistry } from '../capability/capabilityRegistry'
import { createToolRegistry } from '../tool/registry'
import { applyLegacyNavisworksRunState } from '../agent/legacyNavisworksAdapter'
import { NavisworksCapabilityProvider } from '../navisworks/capability'
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
