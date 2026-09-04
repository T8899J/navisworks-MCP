import type { NavisworksConnectionState } from '../shared/ipc'

/**
 * Stale-target rebind UX state derived from the connection snapshot.
 * Discovery never switches the target itself (see NavisworksInstanceSelection);
 * this only describes what the UI should tell the user:
 * "the old target is gone, and here is what is available instead".
 * A candidate is NOT assumed to be a restart of the stale instance — the
 * current data cannot prove that.
 */
export type NavisworksRebindState =
  | { kind: 'none' }
  | {
      kind: 'single-replacement'
      staleInstanceId: string
      candidateInstanceId: string
    }
  | {
      kind: 'multiple-replacements'
      staleInstanceId: string
      candidateInstanceIds: string[]
    }
  | {
      kind: 'disconnected'
      staleInstanceId: string
    }

export function deriveNavisworksRebindState(
  state: NavisworksConnectionState,
): NavisworksRebindState {
  const { selectedInstanceId } = state
  if (selectedInstanceId === undefined) return { kind: 'none' }
  const selected = state.instances.find(
    (instance) => instance.instanceId === selectedInstanceId,
  )
  if (selected !== undefined && selected.connected) return { kind: 'none' }
  const candidates = state.instances
    .filter((instance) => instance.connected && instance.instanceId !== selectedInstanceId)
    .map((instance) => instance.instanceId)
  if (candidates.length === 0) return { kind: 'disconnected', staleInstanceId: selectedInstanceId }
  if (candidates.length === 1) {
    return {
      kind: 'single-replacement',
      staleInstanceId: selectedInstanceId,
      candidateInstanceId: candidates[0]!,
    }
  }
  return {
    kind: 'multiple-replacements',
    staleInstanceId: selectedInstanceId,
    candidateInstanceIds: candidates,
  }
}

/**
 * Stable identity of a rebind state, so the App only notifies/open the menu
 * when the state actually changes, not on every poll refresh.
 */
export function navisworksRebindStateKey(state: NavisworksRebindState): string {
  switch (state.kind) {
    case 'none':
      return 'none'
    case 'disconnected':
      return `disconnected:${state.staleInstanceId}`
    case 'single-replacement':
      return `single:${state.staleInstanceId}:${state.candidateInstanceId}`
    case 'multiple-replacements':
      return `multiple:${state.staleInstanceId}:${[...state.candidateInstanceIds].sort().join(',')}`
  }
}
