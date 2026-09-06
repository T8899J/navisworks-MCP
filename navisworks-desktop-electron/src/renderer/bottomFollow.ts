/**
 * Follow-state machine for the conversation scroller (no DOM — unit-tested).
 *
 * The race it exists to kill: streaming used to smooth-scroll to the bottom,
 * and intermediate scroll events fired BEFORE the travel reached the bottom
 * were read as "the user left the bottom", so auto-follow silently stopped
 * and the last message ended up half-hidden behind the composer.
 *
 * Two mechanisms separate programmatic travel from user intent:
 *
 * - Instant anchors (streaming / session switch / composer growth) record the
 *   exact scrollTop they wrote; an echo event reporting that same position is
 *   our own write, never the user leaving. Any OTHER position is evaluated by
 *   real position, so a user scrolling mid-stream still stops the follow.
 * - Smooth travels (the bottom button) latch: intermediate positions are
 *   ignored, reaching the bottom clears the latch, and any user input
 *   (wheel / touch / pointer / nav scrub) clears it immediately.
 */

export interface ScrollPosition {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Same tolerance the bottom button / follow logic has always used (px). */
export const AT_BOTTOM_THRESHOLD_PX = 64

export function isAtBottom(position: ScrollPosition, threshold = AT_BOTTOM_THRESHOLD_PX): boolean {
  return position.scrollTop + position.clientHeight >= position.scrollHeight - threshold
}

export class BottomFollowController {
  #following = true
  /** Active while a smooth user-requested travel (bottom button) is in flight. */
  #smoothLatch = false
  /** scrollTop written by the last instant anchor; its echo event is suppressed. */
  #anchorEchoTop: number | null = null

  get following(): boolean {
    return this.#following
  }

  /** A smooth user-requested travel to the bottom began. */
  beginSmoothTravel(): void {
    this.#smoothLatch = true
    this.#anchorEchoTop = null
  }

  /** The user took over (wheel / touch / pointer / nav scrub): all guards clear. */
  userInterrupted(): void {
    this.#smoothLatch = false
    this.#anchorEchoTop = null
  }

  /** Session switch (or any forced return): follow unconditionally. */
  resetToFollowing(): void {
    this.#following = true
    this.#smoothLatch = false
    this.#anchorEchoTop = null
  }

  /** Record the scrollTop an instant anchor wrote, so its echo is not misread. */
  recordInstantAnchor(top: number): void {
    this.#anchorEchoTop = top
  }

  /** Evaluate a scroll event; returns the (possibly unchanged) follow state. */
  onScroll(position: ScrollPosition): boolean {
    if (this.#smoothLatch) {
      // Intermediate smooth positions never mean "the user left"; arrival does.
      if (isAtBottom(position)) {
        this.#smoothLatch = false
        this.#following = true
      }
      return this.#following
    }
    if (this.#anchorEchoTop !== null && position.scrollTop === this.#anchorEchoTop) {
      // Echo of our own instant anchor. Content may even have grown between
      // the write and this event — that is the next anchor's job, not "left".
      this.#anchorEchoTop = null
      return this.#following
    }
    this.#following = isAtBottom(position)
    return this.#following
  }
}
