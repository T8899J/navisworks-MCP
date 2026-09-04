import { describe, expect, it, vi } from 'vitest'

import type { NavisworksBridgeClient } from '../../bridgeClient'
import {
  callWithNavisworksRunBinding,
  createNavisworksRunBinding,
} from '../runBinding'
import type { DiscoveredNavisworksInstance } from '../instanceTypes'

describe('Navisworks Run binding', () => {
  it('creates an immutable binding from a fresh status read', async () => {
    const bridge = bridgeStub({
      connected: true,
      bridgeSessionId: 'bridge-a',
      documentInstanceId: 'doc-a',
      documentTitle: 'Model-A.nwf',
    })
    const binding = await createNavisworksRunBinding(instanceA(), bridge)
    expect(binding).toMatchObject({
      instanceId: 'bridge-a',
      pipeName: 'pipe-a',
      bridgeSessionId: 'bridge-a',
      documentInstanceId: 'doc-a',
      documentName: 'Model-A.nwf',
    })
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.endpoint)).toBe(true)
  })

  it('fails closed when the bound document changes', async () => {
    const bridge = bridgeStub({
      connected: true,
      bridgeSessionId: 'bridge-a',
      documentInstanceId: 'doc-b',
    })
    await expect(callWithNavisworksRunBinding(
      bridge,
      bindingA(),
      'navisworks_find_items',
      { query: 'x' },
    )).rejects.toMatchObject({ code: 'DOCUMENT_CHANGED' })
  })

  it('fails closed when the bound pipe is unavailable', async () => {
    const bridge = {
      callToEndpoint: vi.fn(async () => { throw new Error('pipe closed') }),
    } as unknown as NavisworksBridgeClient
    await expect(callWithNavisworksRunBinding(
      bridge,
      bindingA(),
      'navisworks_find_items',
      { query: 'x' },
    )).rejects.toMatchObject({ code: 'TARGET_INSTANCE_DISCONNECTED' })
  })

  it('binds a legacy plugin whose status does not report bridgeSessionId', async () => {
    // Status shape of plugins before 2026-09-01: no bridgeSessionId field.
    const bridge = bridgeStub({ connected: true, documentInstanceId: 'doc-a' })
    const binding = await createNavisworksRunBinding(instanceA(), bridge)
    expect(binding).toMatchObject({
      instanceId: 'bridge-a',
      pipeName: 'pipe-a',
      bridgeSessionId: '1:2026-09-01T00:00:00Z',
      documentInstanceId: 'doc-a',
    })
  })

  it('executes calls against a legacy binding without a reported session id', async () => {
    const bridge = bridgeStub({ connected: true })
    const binding = await createNavisworksRunBinding(instanceA(), bridge)
    await expect(callWithNavisworksRunBinding(
      bridge,
      binding,
      'navisworks_get_selection',
      { limit: 5 },
    )).resolves.toMatchObject({ ok: true })
  })

  it('fails closed when a reported session id mismatches the discovered instance', async () => {
    const bridge = bridgeStub({
      connected: true,
      bridgeSessionId: 'bridge-restarted',
    })
    await expect(createNavisworksRunBinding(instanceA(), bridge))
      .rejects.toMatchObject({ code: 'INSTANCE_CHANGED' })
  })
})

function bridgeStub(status: Record<string, unknown>): NavisworksBridgeClient {
  return {
    callToEndpoint: vi.fn(async (_endpoint, method) => {
      if (method === 'navisworks_status') return status
      return { ok: true }
    }),
  } as unknown as NavisworksBridgeClient
}

function instanceA(): DiscoveredNavisworksInstance {
  return {
    instanceId: 'bridge-a',
    processId: 1,
    pipeName: 'pipe-a',
    bridgeSessionId: 'bridge-a',
    documentInstanceId: 'doc-a',
    documentName: 'Model-A.nwf',
    pluginVersion: '1.0.0',
    hostVersion: '2023',
    startedAtUtc: '2026-09-01T00:00:00Z',
    connected: true,
    lastSeenAt: 1,
    endpoint: {
      ProtocolVersion: 1,
      PipeName: 'pipe-a',
      ProcessId: 1,
      PluginVersion: '1.0.0',
      HostVersion: '2023',
      StartedAtUtc: '2026-09-01T00:00:00Z',
    },
  }
}

function bindingA() {
  return Object.freeze({
    instanceId: 'bridge-a',
    processId: 1,
    pipeName: 'pipe-a',
    bridgeSessionId: 'bridge-a',
    documentInstanceId: 'doc-a',
    documentName: 'Model-A.nwf',
    boundAt: 1,
    endpoint: Object.freeze({ ...instanceA().endpoint }),
  })
}
