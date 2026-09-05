import { describe, expect, it } from 'vitest'

import type { NavisworksConnectionState, NavisworksInstanceSummary } from '../../shared/ipc'
import {
  deriveNavisworksRebindState,
  navisworksRebindStateKey,
} from '../navisworksConnection'
import {
  formatNavisworksDocumentName,
  navisworksInstanceDisplay,
  navisworksStatusBadge,
} from '../chatTypes'

describe('deriveNavisworksRebindState', () => {
  it('returns none when no instance is selected', () => {
    expect(deriveNavisworksRebindState(connection({ instances: [connected('B')] })))
      .toEqual({ kind: 'none' })
  })

  it('returns none while the selected instance stays connected', () => {
    const state = connection({
      instances: [connected('A'), connected('B')],
      selectedInstanceId: 'A',
    })
    expect(deriveNavisworksRebindState(state)).toEqual({ kind: 'none' })
  })

  it('returns disconnected when the selected instance is stale with no other connected instances', () => {
    const state = connection({
      instances: [disconnected('A')],
      selectedInstanceId: 'A',
    })
    expect(deriveNavisworksRebindState(state)).toEqual({
      kind: 'disconnected',
      staleInstanceId: 'A',
    })
  })

  it('returns single-replacement when the selected instance is stale and exactly one other instance is connected', () => {
    const state = connection({
      instances: [disconnected('A'), connected('B')],
      selectedInstanceId: 'A',
    })
    expect(deriveNavisworksRebindState(state)).toEqual({
      kind: 'single-replacement',
      staleInstanceId: 'A',
      candidateInstanceId: 'B',
    })
  })

  it('returns multiple-replacements when the selected instance is stale and several instances are connected', () => {
    const state = connection({
      instances: [disconnected('A'), connected('B'), connected('C')],
      selectedInstanceId: 'A',
    })
    expect(deriveNavisworksRebindState(state)).toEqual({
      kind: 'multiple-replacements',
      staleInstanceId: 'A',
      candidateInstanceIds: ['B', 'C'],
    })
  })

  it('ignores disconnected non-selected instances when counting candidates', () => {
    const state = connection({
      instances: [disconnected('A'), disconnected('B')],
      selectedInstanceId: 'A',
    })
    expect(deriveNavisworksRebindState(state)).toEqual({
      kind: 'disconnected',
      staleInstanceId: 'A',
    })
  })

  it('treats a selected instance missing from the list as disconnected', () => {
    const state = connection({
      instances: [connected('B')],
      selectedInstanceId: 'A',
    })
    expect(deriveNavisworksRebindState(state)).toEqual({
      kind: 'single-replacement',
      staleInstanceId: 'A',
      candidateInstanceId: 'B',
    })
  })
})

describe('navisworksRebindStateKey', () => {
  it('is stable across equal states and distinct across different stale states', () => {
    expect(navisworksRebindStateKey({ kind: 'none' })).toBe('none')
    expect(navisworksRebindStateKey({ kind: 'disconnected', staleInstanceId: 'A' }))
      .toBe(navisworksRebindStateKey({ kind: 'disconnected', staleInstanceId: 'A' }))
    expect(navisworksRebindStateKey({ kind: 'disconnected', staleInstanceId: 'A' }))
      .not.toBe(navisworksRebindStateKey({ kind: 'single-replacement', staleInstanceId: 'A', candidateInstanceId: 'B' }))
    expect(navisworksRebindStateKey({
      kind: 'multiple-replacements',
      staleInstanceId: 'A',
      candidateInstanceIds: ['B', 'C'],
    })).toBe(navisworksRebindStateKey({
      kind: 'multiple-replacements',
      staleInstanceId: 'A',
      candidateInstanceIds: ['C', 'B'],
    }))
  })
})

describe('navisworksStatusBadge', () => {
  it('shows the bare product name while disconnected, detail in the title', () => {
    const badge = navisworksStatusBadge({ connected: false, status: '未连接' })
    expect(badge.label).toBe('Navisworks')
    expect(badge.label).not.toContain('未连接')
    expect(badge.title).toBe('Navisworks 未连接')
  })

  it('keeps the connected prominence', () => {
    expect(navisworksStatusBadge({ connected: true, status: '已连接' }))
      .toEqual({ label: 'Navisworks 已连接', title: 'Navisworks 已连接' })
    expect(navisworksStatusBadge({ connected: true, status: 'a.nwf', documentName: 'a.nwf' }))
      .toEqual({ label: 'a.nwf', title: 'a.nwf' })
  })
})

describe('formatNavisworksDocumentName', () => {
  it('keeps the base name and strips the Navisworks extension, case-insensitively', () => {
    expect(formatNavisworksDocumentName('TS-M128.31(版检).nwd')).toBe('TS-M128.31(版检)')
    expect(formatNavisworksDocumentName('plant.NWF')).toBe('plant')
    expect(formatNavisworksDocumentName('view.nwc')).toBe('view')
    // Only the LAST extension goes; dots inside names survive.
    expect(formatNavisworksDocumentName('a.b.c.nwd')).toBe('a.b.c')
    expect(formatNavisworksDocumentName('notes.txt')).toBe('notes.txt')
  })

  it('falls back to 未命名文档 for missing or extension-only names', () => {
    expect(formatNavisworksDocumentName(undefined)).toBe('未命名文档')
    expect(formatNavisworksDocumentName('')).toBe('未命名文档')
    expect(formatNavisworksDocumentName('.nwd')).toBe('未命名文档')
  })
})

describe('navisworksInstanceDisplay', () => {
  const instance = (
    overrides: Partial<NavisworksInstanceSummary> & Pick<NavisworksInstanceSummary, 'instanceId'>,
  ): NavisworksInstanceSummary => ({
    processId: 11940,
    connected: true,
    hostVersion: '20.0',
    pluginVersion: '1.0',
    ...overrides,
  })

  it('hides PID and version from the row label by default', () => {
    const a = instance({ instanceId: 'A', documentName: 'TS-M128.31(版检).nwd' })
    const display = navisworksInstanceDisplay(a, [a])
    expect(display.name).toBe('TS-M128.31(版检)')
    expect(display.label).toBe('TS-M128.31(版检)')
    expect(display.label).not.toContain('11940')
  })

  it('adds the PID only when another connected instance shares the same display name', () => {
    const a = instance({ instanceId: 'A', processId: 11940, documentName: '模型.nwd' })
    const b = instance({ instanceId: 'B', processId: 13288, documentName: '模型.NWF' })
    expect(navisworksInstanceDisplay(a, [a, b]).label).toBe('模型 · 11940')
    expect(navisworksInstanceDisplay(b, [a, b]).label).toBe('模型 · 13288')
  })

  it('does not count a disconnected same-name instance toward the collision', () => {
    const live = instance({ instanceId: 'A', processId: 11940, documentName: '模型.nwd' })
    const stale = instance({
      instanceId: 'B',
      processId: 43672,
      connected: false,
      documentName: '模型.nwd',
    })
    expect(navisworksInstanceDisplay(live, [live, stale]).label).toBe('模型')
    // The stale row keeps its own name; PID stays in the row's title, not the label.
    expect(navisworksInstanceDisplay(stale, [live, stale]).label).toBe('模型')
  })
})

function connected(instanceId: string): NavisworksConnectionState['instances'][number] {
  return summary(instanceId, true)
}

function disconnected(instanceId: string): NavisworksConnectionState['instances'][number] {
  return summary(instanceId, false)
}

function summary(
  instanceId: string,
  connected: boolean,
): NavisworksConnectionState['instances'][number] {
  return {
    instanceId,
    processId: 1,
    connected,
    documentName: `Model-${instanceId}.nwf`,
    hostVersion: '2023',
    pluginVersion: '1.0.0',
  }
}

function connection(
  state: Pick<NavisworksConnectionState, 'instances'> & Partial<Pick<NavisworksConnectionState, 'selectedInstanceId'>>,
): NavisworksConnectionState {
  return {
    instances: state.instances,
    ...(state.selectedInstanceId === undefined ? {} : { selectedInstanceId: state.selectedInstanceId }),
  }
}
