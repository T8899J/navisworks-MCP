import { describe, expect, it } from 'vitest'

import { NavisworksInstanceSelection } from '../instanceSelection'
import type { NavisworksInstance } from '../instanceTypes'

describe('NavisworksInstanceSelection', () => {
  it('auto-selects the only connected instance', () => {
    const selection = new NavisworksInstanceSelection()
    selection.observe([instance('A')])
    expect(selection.selectedInstanceId).toBe('A')
  })

  it('does not switch from A when B appears later', () => {
    const selection = new NavisworksInstanceSelection()
    selection.observe([instance('A')])
    selection.observe([instance('A'), instance('B')])
    expect(selection.selectedInstanceId).toBe('A')
  })

  it('uses B only after an explicit user selection', () => {
    const selection = new NavisworksInstanceSelection()
    const instances = [instance('A'), instance('B')]
    selection.observe([instance('A')])
    selection.observe(instances)
    selection.select('B', instances)
    expect(selection.selectedInstanceId).toBe('B')
  })

  it('keeps a closed selected A disconnected instead of failing over to B', () => {
    const selection = new NavisworksInstanceSelection()
    selection.observe([instance('A')])
    selection.observe([instance('B')])
    expect(selection.selectedInstanceId).toBe('A')
    expect(selection.selected([instance('B')])).toMatchObject({ instanceId: 'A', connected: false })
  })
})

function instance(instanceId: string): NavisworksInstance {
  return {
    instanceId,
    processId: instanceId === 'A' ? 1 : 2,
    pipeName: `pipe-${instanceId}`,
    bridgeSessionId: `bridge-${instanceId}`,
    documentInstanceId: `doc-${instanceId}`,
    documentName: `Model-${instanceId}.nwf`,
    pluginVersion: '1.0.0',
    hostVersion: '2023',
    startedAtUtc: '2026-09-01T00:00:00Z',
    connected: true,
    lastSeenAt: 1,
  }
}
