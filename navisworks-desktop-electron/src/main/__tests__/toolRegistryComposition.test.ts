import { describe, expect, it } from 'vitest'
import { AgentRuntime } from '../agentRuntime'
import { CapabilityRegistry } from '../capability/capabilityRegistry'
import type {
  CapabilityProvider,
  CapabilityPreparedRun,
  CapabilityToolExecutionInput,
} from '../capability/types'
import { createToolRegistry } from '../tool/registry'
import type { AgentToolDefinition } from '../tool/registry'
import type { ContextSource } from '../context/types'
import { NavisworksCapabilityProvider } from '../navisworks/capability'
import { NAVISWORKS_TOOL_NAMES } from '../navisworks/toolDefinitions'
import type { NavisworksBridgeClient } from '../bridgeClient'

function fakeTool(name: string, capabilityId: string): AgentToolDefinition {
  return {
    name,
    label: name,
    description: `fake tool ${name}`,
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
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

function fakeCapability(toolNames: string[]): CapabilityProvider {
  return {
    manifest: { id: 'fake', name: 'Fake', description: 'test capability', version: 1, firstParty: false },
    tools: () => toolNames.map((name) => fakeTool(name, 'fake')),
    contextSources: (): readonly ContextSource<unknown>[] => [],
    ownsTool: (name) => toolNames.includes(name),
    normalizeArguments: (_name, args) => args,
    prepareRun: async (): Promise<CapabilityPreparedRun> => ({ capabilityId: 'fake', state: { ready: true } }),
    executeTool: async (input: CapabilityToolExecutionInput) => ({ result: { echo: input.toolName } }),
  }
}

describe('P30.1 single ToolRegistry truth (§9/§101)', () => {
  it('the runtime and the tools.list IPC read the ONE composed registry instance (§61)', () => {
    const capabilities = new CapabilityRegistry([fakeCapability(['fake_echo'])])
    // Production composition: create the registry ONCE and hand the same
    // instance to both the runtime and the IPC dependency.
    const agentTools = createToolRegistry({ capabilities })
    const runtime = new AgentRuntime({ capabilities, tools: agentTools })

    // Same object identity, not two independently-composed copies.
    expect(runtime.toolInventory).toBe(agentTools)
  })

  it('a capability tool appears to BOTH the model and tools.list; internals only to the model (§9)', () => {
    const capabilities = new CapabilityRegistry([fakeCapability(['fake_echo'])])
    const agentTools = createToolRegistry({ capabilities })

    // Model materialization carries the capability tool.
    const offered = agentTools.materialize().map((contract) => contract.function.name)
    expect(offered).toContain('fake_echo')
    // The UI inventory carries it too, with capability identity resolved.
    const ui = agentTools.listUiTools()
    const fakeEntry = ui.find((summary) => summary.name === 'fake_echo')
    expect(fakeEntry).toBeDefined()
    expect(fakeEntry?.capabilityId).toBe('fake')
    expect(fakeEntry?.capabilityName).toBe('Fake')
    // Set equality modulo the internal tools the UI hides (§9 last line).
    const internal = agentTools.list().filter((d) => d.origin.kind === 'internal').map((d) => d.name)
    const uiNames = ui.map((summary) => summary.name)
    const modelCapabilityNames = offered.filter((name) => !internal.includes(name))
    expect([...uiNames].sort()).toEqual([...modelCapabilityNames].sort())
  })

  it('internal tools never surface in the UI inventory (§10)', () => {
    const capabilities = new CapabilityRegistry([fakeCapability(['fake_echo'])])
    const ui = createToolRegistry({ capabilities }).listUiTools().map((entry) => entry.name)
    expect(ui).not.toContain('read_tool_result')
    expect(ui).not.toContain('question')
    expect(ui).not.toContain('skill')
  })

  it('the tools.list registry exposes EVERY user-configurable Navisworks tool (§10 regression)', () => {
    // A production-like composition with the real Navisworks capability.
    const bridge = { async call<T>() { return {} as T } } as unknown as NavisworksBridgeClient
    const capabilities = new CapabilityRegistry([
      new NavisworksCapabilityProvider({ bridge }),
    ])
    const ui = createToolRegistry({ capabilities }).listUiTools().map((entry) => entry.name)
    for (const toolName of NAVISWORKS_TOOL_NAMES) {
      expect(ui).toContain(toolName)
    }
    // Every Navisworks tool carries its capability identity for future grouping.
    for (const entry of createToolRegistry({ capabilities }).listUiTools()) {
      expect(entry.capabilityId).toBe('navisworks')
      expect(entry.capabilityName).toBe('Navisworks')
    }
  })
})
