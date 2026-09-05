/**
 * Pure geometry and gesture decisions for the conversation navigation rail.
 *
 * The rail is a conversation scrubber, not a row of hit targets: any press
 * inside its box resolves a vertical ratio onto (a) the nearest turn for
 * clicks and previews and (b), once dragging, the whole conversation's
 * scroll position. All of it lives here — DOM-free and unit-testable — so
 * the interaction contract can be verified without a browser.
 */

/** Presses that move no further than this release as a click; beyond it a scrub begins. */
export const NAV_DRAG_THRESHOLD_PX = 4

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Vertical position of clientY within [top, top + height], clamped 0…1. */
export function ratioFromClientY(clientY: number, top: number, height: number): number {
  if (height <= 0) return 0
  return clamp01((clientY - top) / height)
}

/** Nearest turn index for a rail ratio — midpoint rounding, both ends inclusive. */
export function nearestTurnIndex(ratio: number, turnCount: number): number {
  if (turnCount <= 0) return 0
  return Math.min(turnCount - 1, Math.max(0, Math.round(clamp01(ratio) * (turnCount - 1))))
}

/**
 * A release resolves to the pressed bar's turn when the press began on one;
 * presses on the rail's padding or gaps resolve to the nearest turn instead
 * of doing nothing. Null means there is nothing to jump to.
 */
export function clickTargetTurnIndex(
  pressedTurnIndex: number | null,
  ratio: number,
  turnCount: number,
): number | null {
  if (turnCount <= 0) return null
  if (pressedTurnIndex != null) {
    return Math.min(turnCount - 1, Math.max(0, pressedTurnIndex))
  }
  return nearestTurnIndex(ratio, turnCount)
}

/**
 * Where a scrub ratio points in the conversation. Always 'instant': the
 * scroller's CSS smooth behavior is for wheel/click travel, while drag
 * must track the pointer with zero travel — and per-frame smooth scrolls
 * would interrupt each other and stall.
 */
export function navScrubScrollOptions(
  ratio: number,
  maxScroll: number,
): { top: number; behavior: 'instant' } {
  const bounded = Math.max(0, maxScroll)
  return {
    top: Math.min(bounded, clamp01(ratio) * bounded),
    behavior: 'instant',
  }
}

export interface NavDragState {
  pointerId: number
  startY: number
  dragging: boolean
}

export type NavDragEvent =
  | { kind: 'pointerdown'; pointerId: number; clientY: number }
  | { kind: 'pointermove'; clientY: number }
  | { kind: 'pointerup' }
  | { kind: 'pointercancel' }

export type NavDragOutcome =
  /** Nothing to apply: a pending press, a press without capture, a bare release. */
  | { kind: 'none' }
  /** Release without a drag: jump to the turn the press resolved onto. */
  | { kind: 'click' }
  /** Apply an absolute scrub for the pointer's current position. */
  | { kind: 'scroll'; clientY: number }

/**
 * Press → (move past threshold → drag) → release/cancel.
 *
 * A pointerdown never scrolls (the user may just be holding to aim); the
 * first move beyond NAV_DRAG_THRESHOLD_PX switches to absolute scrubbing,
 * and both pointerup and pointercancel clear the session.
 */
export function navDragReducer(
  state: NavDragState | null,
  event: NavDragEvent,
): { state: NavDragState | null; outcome: NavDragOutcome } {
  switch (event.kind) {
    case 'pointerdown':
      return { state: { pointerId: event.pointerId, startY: event.clientY, dragging: false }, outcome: { kind: 'none' } }
    case 'pointermove': {
      if (state == null) return { state: null, outcome: { kind: 'none' } }
      if (!state.dragging) {
        if (Math.abs(event.clientY - state.startY) <= NAV_DRAG_THRESHOLD_PX) {
          return { state, outcome: { kind: 'none' } }
        }
        return { state: { ...state, dragging: true }, outcome: { kind: 'scroll', clientY: event.clientY } }
      }
      return { state, outcome: { kind: 'scroll', clientY: event.clientY } }
    }
    case 'pointerup': {
      if (state == null) return { state: null, outcome: { kind: 'none' } }
      return { state: null, outcome: state.dragging ? { kind: 'none' } : { kind: 'click' } }
    }
    case 'pointercancel':
      return { state: null, outcome: { kind: 'none' } }
  }
}
