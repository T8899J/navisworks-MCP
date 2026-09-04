import { describe, expect, it } from 'vitest'

import type { NavisworksConnectionState } from '../../shared/ipc'
import {
  deriveNavisworksRebindState,
  navisworksRebindStateKey,
} from '../navisworksConnection'

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
