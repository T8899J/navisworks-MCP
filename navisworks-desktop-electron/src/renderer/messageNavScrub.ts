/**
 * Pure geometry and gesture decisions for the conversation navigation rail.
 *
 * The rail is an ANCHOR scrubber, not a document scrollbar: each bar maps to
 * its turn's real scroll position (measured from the DOM when the gesture
 * starts), so a drag begins at the pressed turn and interpolates piecewise
 * between the measured stops — traveling halfway between two bars moves the
 * conversation halfway between THOSE turns' positions, never to a whole-
 * document percentage. All of it lives here — DOM-free and unit-testable —
 * so the interaction contract can be verified without a browser.
 */

/** Presses that move no further than this release as a click; beyond it a scrub begins. */
export const NAV_DRAG_THRESHOLD_PX = 4

/** Viewport gap kept above a turn's anchor message when the conversation jumps to it (px). */
export const NAV_ANCHOR_OFFSET_PX = 12

/** One turn's scrub anchor: the bar's center on screen and the real scroll position of its turn. */
export interface NavScrubStop {
  index: number
  anchorId: string
  /** The bar's center Y in client coordinates, measured when the gesture starts. */
  railY: number
  /** The conversation scrollTop that brings this turn's anchor message into view. */
  scrollTop: number
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Index of the bar whose center is nearest to clientY — presses on padding
 * or gaps resolve to the same bar that hover and click would mean. Ties go
 * to the earlier bar; an empty rail resolves to the first bar.
 */
export function nearestStopIndexFromClientY(clientY: number, stops: ReadonlyArray<{ railY: number }>): number {
  const first = stops[0]
  if (first == null) return 0
  let nearest = 0
  let nearestDistance = Math.abs(clientY - first.railY)
  for (let index = 1; index < stops.length; index += 1) {
    const stop = stops[index]
    if (stop == null) break
    const distance = Math.abs(clientY - stop.railY)
    if (distance < nearestDistance) {
      nearest = index
      nearestDistance = distance
    }
  }
  return nearest
}

/**
 * Piecewise-linear scroll position for a rail position: between two adjacent
 * bars, travel proportionally between THEIR measured scroll positions — the
 * conversation's turns are unevenly sized, so these stops are never evenly
 * spaced in scroll space. Beyond the ends clamps to the first/last turn.
 */
export function interpolateScrollTop(railY: number, stops: ReadonlyArray<NavScrubStop>): number {
  const first = stops[0]
  if (first == null) return 0
  if (railY <= first.railY) return first.scrollTop
  const last = stops[stops.length - 1] ?? first
  if (railY >= last.railY) return last.scrollTop
  for (let index = 1; index < stops.length; index += 1) {
    const upper = stops[index]
    const lower = stops[index - 1]
    if (upper == null || lower == null) break
    if (railY <= upper.railY) {
      const span = upper.railY - lower.railY
      if (span <= 0) return lower.scrollTop
      const t = clamp01((railY - lower.railY) / span)
      return lower.scrollTop + (upper.scrollTop - lower.scrollTop) * t
    }
  }
  return last.scrollTop
}

export interface NavDragState {
  pointerId: number
  startY: number
  dragging: boolean
  /** Turn the gesture is anchored to: drag-start snaps the conversation to it. */
  anchorIndex: number
  /** PointerDown clientY minus the anchor bar's center, so the grab point rides along. */
  pointerOffsetY: number
}

export type NavDragEvent =
  | { kind: 'pointerdown'; pointerId: number; clientY: number; anchorIndex: number; pointerOffsetY: number }
  | { kind: 'pointermove'; clientY: number }
  | { kind: 'pointerup' }
  | { kind: 'pointercancel' }

export type NavDragOutcome =
  /** Nothing to apply: a pending press, a press without capture, a bare release. */
  | { kind: 'none' }
  /** Release without a drag: jump to the turn the press anchored onto. */
  | { kind: 'click' }
  /** First move past the threshold: snap the conversation to the anchor turn before scrubbing. */
  | { kind: 'drag-start' }
  /** Track the pointer: the receiver interpolates the scroll position from the stops. */
  | { kind: 'scroll'; clientY: number }

/**
 * Press → (move past threshold → snap to anchor → scrub) → release/cancel.
 *
 * A pointerdown never scrolls (the user may just be holding to aim) and —
 * deliberately — records nothing about the viewport's current position: the
 * drag's origin is ONLY the pressed bar's turn. The first move beyond
 * NAV_DRAG_THRESHOLD_PX emits 'drag-start' (the receiver snaps straight to
 * the anchor turn's real scrollTop), later moves emit 'scroll', and both
 * pointerup and pointercancel clear the session.
 */
export function navDragReducer(
  state: NavDragState | null,
  event: NavDragEvent,
): { state: NavDragState | null; outcome: NavDragOutcome } {
  switch (event.kind) {
    case 'pointerdown':
      return {
        state: {
          pointerId: event.pointerId,
          startY: event.clientY,
          dragging: false,
          anchorIndex: event.anchorIndex,
          pointerOffsetY: event.pointerOffsetY,
        },
        outcome: { kind: 'none' },
      }
    case 'pointermove': {
      if (state == null) return { state: null, outcome: { kind: 'none' } }
      if (!state.dragging) {
        if (Math.abs(event.clientY - state.startY) <= NAV_DRAG_THRESHOLD_PX) {
          return { state, outcome: { kind: 'none' } }
        }
        return { state: { ...state, dragging: true }, outcome: { kind: 'drag-start' } }
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
