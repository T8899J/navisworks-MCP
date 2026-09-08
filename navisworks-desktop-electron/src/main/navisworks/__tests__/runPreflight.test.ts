import { describe, expect, it, vi } from 'vitest'
import { NavisworksRunPreflight } from '../runPreflight'
import { NavisworksCapabilityProvider } from '../capability'
import { NavisworksInstanceSelection } from '../instanceSelection'
import { ContextState } from '../../agent/contextState'
import type { NavisworksInstanceRegistry } from '../instanceRegistry'
import type { NavisworksBridgeClient } from '../../bridgeClient'
import type { DiscoveredNavisworksInstance } from '../instanceTypes'

function discovered(processId: number, connected: boolean): DiscoveredNavisworksInstance {
  return {
    instanceId: `instance-${processId}`,
    processId,
    pipeName: `pipe-${processId}`,
    bridgeSessionId: `bridge-${processId}`,
    documentInstanceId: `doc-${processId}`,
    documentName: `Model-${processId}.nwf`,
    pluginVersion: '1.0.0',
    hostVersion: '2023',
    startedAtUtc: '2026-09-01T00:00:00Z',
    connected,
    lastSeenAt: 0,
    endpoint: {
      ProtocolVersion: 1,
      PipeName: `pipe-${processId}`,
      ProcessId: processId,
      PluginVersion: '1.0.0',
      HostVersion: '2023',
      StartedAtUtc: '2026-09-01T00:00:00Z',
    },
  }
}

function fakeRegistry(instances: DiscoveredNavisworksInstance[]): NavisworksInstanceRegistry {
  return {
    get instances() { return instances.map((instance) => ({ ...instance })) },
    refresh: vi.fn(async () => instances.map((instance) => ({ ...instance }))),
    get(instanceId: string) { return instances.find((instance) => instance.instanceId === instanceId) },
  } as unknown as NavisworksInstanceRegistry
}

function statusBridge(): NavisworksBridgeClient {
  return {
    async callToEndpoint<T>(): Promise<T> {
      return {
        connected: true,
        bridgeSessionId: 'bridge-1',
        documentInstanceId: 'doc-1',
        documentTitle: 'Model-1.nwf',
      } as T
    },
  } as unknown as NavisworksBridgeClient
}

describe('NavisworksRunPreflight (§17/§18/§19/§20/§21)', () => {
  it('no selection → unavailable TARGET_INSTANCE_DISCONNECTED, observes disconnected, does not throw (§19/§64)', async () => {
    const contextState = new ContextState()
    const observe = vi.spyOn(contextState, 'observe')
    const preflight = new NavisworksRunPreflight({
      instanceRegistry: fakeRegistry([]),
      instanceSelection: new NavisworksInstanceSelection(),
      bridge: statusBridge(),
      contextState,
    })
    const state = await preflight.prepare({ runId: 'r1' })
    expect(state.unavailable).toEqual({
      code: 'TARGET_INSTANCE_DISCONNECTED',
      message: '当前没有选择 Navisworks 实例，请先选择一个实例。',
    })
    expect(state.binding).toBeUndefined()
    // The chat run MUST still start with this state available — it is data, not an error.
    expect(observe).toHaveBeenCalledWith({ connected: false })
  })

  it('a connected selection binds the run and ingests identity into ContextState (§18/§21)', async () => {
    const contextState = new ContextState()
    const selection = new NavisworksInstanceSelection()
    const instance = discovered(1, true)
    const preflight = new NavisworksRunPreflight({
      instanceRegistry: fakeRegistry([instance]),
      instanceSelection: selection,
      bridge: statusBridge(),
      contextState,
    })
    const state = await preflight.prepare({ runId: 'r1' })
    // A single connected instance auto-selects (InstanceSelection semantics).
    expect(state.binding).toMatchObject({
      instanceId: 'instance-1',
      bridgeSessionId: 'bridge-1',
      documentInstanceId: 'doc-1',
    })
    expect(state.currentDocument).toMatchObject({ connected: true, documentName: 'Model-1.nwf' })
    expect(typeof state.observedDocumentRevision).toBe('number')
    expect(state.unavailable).toBeUndefined()
  })

  it('a previously-selected instance that disconnected keeps its message (§20)', async () => {
    const selection = new NavisworksInstanceSelection()
    selection.observe([discovered(1, true)]) // auto-selects instance-1
    selection.select('instance-1', [discovered(1, true)])
    const preflight = new NavisworksRunPreflight({
      // instance-1 is now disconnected in discovery.
      instanceRegistry: fakeRegistry([discovered(1, false)]),
      instanceSelection: selection,
      bridge: statusBridge(),
      contextState: new ContextState(),
    })
    const state = await preflight.prepare({ runId: 'r1' })
    expect(state.unavailable).toMatchObject({
      code: 'TARGET_INSTANCE_DISCONNECTED',
      message: '之前选择的 Navisworks 已断开，请从实例菜单重新选择一个可用实例。',
    })
  })
})

describe('NavisworksCapabilityProvider.prepareRun is the single preflight seam (§16/§86)', () => {
  it('delegates to the injected preflight and namespaces the result by capability id', async () => {
    const prepare = vi.fn(async () => ({ binding: undefined, unavailable: { code: 'TARGET_INSTANCE_DISCONNECTED' as const, message: 'x' } }))
    const provider = new NavisworksCapabilityProvider({
      bridge: statusBridge(),
      preflight: { prepare },
    })
    const run = await provider.prepareRun({ runId: 'r1', sessionId: 's1' })
    expect(prepare).toHaveBeenCalledWith({ runId: 'r1', sessionId: 's1' })
    expect(run.capabilityId).toBe('navisworks')
    expect((run.state as { unavailable?: { code: string } }).unavailable?.code).toBe('TARGET_INSTANCE_DISCONNECTED')
  })

  it('no preflight seam → empty prepared state, never a thrown failure (§64)', async () => {
    const provider = new NavisworksCapabilityProvider({ bridge: statusBridge() })
    const run = await provider.prepareRun({ runId: 'r1' })
    expect(run.state).toEqual({})
  })
})
