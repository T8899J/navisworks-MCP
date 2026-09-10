/**
 * Follow-intent state machine + scroll-geometry primitives for the
 * conversation scroller (no DOM — unit-tested).
 *
 * Division of responsibility (the "DOM geometry is the only scroll truth"
 * rule): THIS module only tracks whether the USER wants to follow the latest
 * message. The actual position lives in the scroller's scrollTop /
 * scrollHeight / clientHeight — a real in-flow bottom spacer maps the
 * Composer overlay into that geometry, so "anchored" means
 * distanceFromBottom ≈ 0, which by construction leaves the last message
 * above the Composer.
 *
 * Two distinct thresholds — never interchangeable:
 * - ACTUAL_BOTTOM_EPSILON_PX (2): proof that we really are at the bottom.
 * - FOLLOW_REENGAGE_THRESHOLD_PX (64): tolerance for "the user is still near
 *   the bottom, keep auto-following".
 */

export interface ScrollPosition {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Distance still to scroll before the content end reaches the viewport end. */
export function distanceFromBottom(position: ScrollPosition): number {
  return Math.max(0, position.scrollHeight - position.clientHeight - position.scrollTop)
}

export const ACTUAL_BOTTOM_EPSILON_PX = 2
export const FOLLOW_REENGAGE_THRESHOLD_PX = 64

/** Log tag for the failed bottom invariant (see checkBottomInvariant). */
export const BOTTOM_INVARIANT_FAILED_HINT = 'BOTTOM_INVARIANT_FAILED'

/** Near-bottom tolerance: the user hasn't left the latest message. */
export function isAtBottom(position: ScrollPosition, threshold = FOLLOW_REENGAGE_THRESHOLD_PX): boolean {
  return distanceFromBottom(position) <= threshold
}

/**
 * The core invariant: while following, after the layout settles, the scroll
 * must sit at (or within epsilon of) the true bottom. Composer visibility of
 * the last message follows from the real bottom spacer being part of
 * scrollHeight.
 */
export interface BottomInvariantCheck {
  ok: boolean
  distance: number
}

export function checkBottomInvariant(
  position: ScrollPosition,
  epsilon = ACTUAL_BOTTOM_EPSILON_PX,
): BottomInvariantCheck {
  const distance = distanceFromBottom(position)
  return { ok: distance <= epsilon, distance }
}

export class BottomFollowController {
  #following = true
  /** Active while a smooth user-requested travel (bottom button) is in flight. */
  #smoothLatch = false
  /**
   * scrollTop written by the most recent instant anchor. While one is in
   * flight, scroll events are echoes of OUR writes or stale positions from a
   * growth race — never "the user left" (a real user interrupt arrives via
   * wheel/touch/pointer, which clears this).
   */
  #pendingAnchorTop: number | null = null

  get following(): boolean {
    return this.#following
  }

  /** Reconcile a collapsed layout without requiring a browser scroll event. */
  onLayout(position: ScrollPosition): void {
    if (!this.#following && distanceFromBottom(position) <= ACTUAL_BOTTOM_EPSILON_PX) this.resetToFollowing()
  }

  /** A smooth user-requested travel to the bottom began. */
  beginSmoothTravel(): void {
    this.#smoothLatch = true
    this.#pendingAnchorTop = null
  }

  /** The user took over (wheel / touch / pointer / nav scrub): all guards clear. */
  userInterrupted(): void {
    this.#smoothLatch = false
    this.#pendingAnchorTop = null
  }

  /** Session switch (or any forced return): follow unconditionally. */
  resetToFollowing(): void {
    this.#following = true
    this.#smoothLatch = false
    this.#pendingAnchorTop = null
  }

  /** Record the scrollTop an instant anchor wrote while geometry settles. */
  recordInstantAnchor(top: number): void {
    this.#pendingAnchorTop = top
  }

  /**
   * Evaluate a scroll event; returns the (possibly unchanged) follow state.
   * Scroll position alone can silently kill follow during a growth race (a
   * stale echo lands above the NEW bottom right after a second anchor
   * overwrote the pending top) — so while an anchor is pending, position
   * events never decide "the user left". Only real input devices do.
   */
  onScroll(position: ScrollPosition): boolean {
    if (this.#smoothLatch) {
      // Intermediate smooth positions never mean "the user left"; arrival does.
      if (isAtBottom(position)) {
        this.#smoothLatch = false
        this.#following = true
      }
      return this.#following
    }
    if (this.#pendingAnchorTop !== null) {
      if (position.scrollTop === this.#pendingAnchorTop) {
        // Our own write echoed back: anchor confirmed, geometry is trusted again.
        this.#pendingAnchorTop = null
      }
      return this.#following
    }
    this.#following = isAtBottom(position)
    return this.#following
  }
}
