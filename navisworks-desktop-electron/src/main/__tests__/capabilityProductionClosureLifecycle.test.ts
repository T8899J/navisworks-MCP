import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../capability/capabilityRegistry'
import { NavisworksCapabilityProvider } from '../navisworks/capability'
import { ContextState } from '../agent/contextState'
import { createRootScope } from '../kernel/kernel'
import type { NavisworksBridgeClient } from '../bridgeClient'

function stubBridge(): NavisworksBridgeClient {
  return { async call<T>() { return { connected: false } as T } } as unknown as NavisworksBridgeClient
}

describe('P30.6 Capability lifecycle closes through the composition root (§33/§34/§35)', () => {
  it('startAll starts the Navisworks polling once; disposeAll stops it once; repeat dispose is a no-op', async () => {
    const stopPolling = vi.fn()
    const startPolling = vi.fn(() => stopPolling)
    const provider = new NavisworksCapabilityProvider({
      bridge: stubBridge(),
      contextState: new ContextState(),
      startPolling,
    })
    const capabilities = new CapabilityRegistry([provider])

    await capabilities.startAll()
    expect(startPolling).toHaveBeenCalledTimes(1)
    expect(stopPolling).not.toHaveBeenCalled()

    // App shutdown runs disposeAll once → the provider stops its own polling.
    await capabilities.disposeAll()
    expect(stopPolling).toHaveBeenCalledTimes(1)

    // A second dispose must NOT re-invoke the disposer (idempotent, §35).
    await capabilities.disposeAll()
    expect(stopPolling).toHaveBeenCalledTimes(1)
  })

  it('the provider start is itself idempotent (a second startAll re-starts nothing)', async () => {
    const stopPolling = vi.fn()
    const startPolling = vi.fn(() => stopPolling)
    const provider = new NavisworksCapabilityProvider({
      bridge: stubBridge(),
      contextState: new ContextState(),
      startPolling,
    })
    await provider.start?.()
    await provider.start?.()
    expect(startPolling).toHaveBeenCalledTimes(1)
    await provider.dispose?.()
    expect(stopPolling).toHaveBeenCalledTimes(1)
  })

  it('a real Scope onDispose wiring tears the capabilities down with the app', async () => {
    // Mirrors installApplicationServices: register disposeAll as an app-scope
    // effect; disposing the scope must reach the provider exactly once.
    const stopPolling = vi.fn()
    const provider = new NavisworksCapabilityProvider({
      bridge: stubBridge(),
      contextState: new ContextState(),
      startPolling: () => stopPolling,
    })
    const capabilities = new CapabilityRegistry([provider])
    const appScope = await createRootScope('app-test')
    await capabilities.startAll()
    appScope.onDispose(async () => { await capabilities.disposeAll() })

    await appScope.dispose()
    expect(stopPolling).toHaveBeenCalledTimes(1)
    // Disposing again is guarded by the scope (idempotent).
    await appScope.dispose()
    expect(stopPolling).toHaveBeenCalledTimes(1)
  })
})
