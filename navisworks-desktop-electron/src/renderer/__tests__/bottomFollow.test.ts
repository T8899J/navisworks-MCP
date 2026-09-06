import { describe, expect, it } from 'vitest'
import { BottomFollowController, isAtBottom } from '../bottomFollow'

// A stable viewport: clientHeight 400. Positions are constructed so
// "at bottom" ⇔ scrollTop === scrollHeight - 400.
const CLIENT_HEIGHT = 400

function position(scrollTop: number, scrollHeight: number) {
  return { scrollTop, scrollHeight, clientHeight: CLIENT_HEIGHT }
}

/** One streaming tick: content grows, the runtime anchors instantly to the
 * new bottom, then the browser delivers the echo scroll event. */
function streamTick(follow: BottomFollowController, scrollHeight: number, grownAgain = 0): void {
  const top = scrollHeight - CLIENT_HEIGHT
  follow.recordInstantAnchor(top)
  // The echo may observe content that grew AGAIN after the write — the exact
  // race that used to kill follow when this path was smooth.
  follow.onScroll(position(top, scrollHeight + grownAgain))
}

describe('BottomFollowController — streaming follow (A/B/E/G)', () => {
  it('A: following at the bottom, a new message anchors and the echo keeps follow on', () => {
    const follow = new BottomFollowController()
    expect(follow.following).toBe(true)
    streamTick(follow, 1000)
    expect(follow.following).toBe(true)
    streamTick(follow, 1400)
    expect(follow.following).toBe(true)
  })

  it('B: ten consecutive growth ticks keep follow true and end at the bottom', () => {
    const follow = new BottomFollowController()
    let scrollHeight = 800
    for (let tick = 0; tick < 10; tick += 1) {
      scrollHeight += 120
      streamTick(follow, scrollHeight)
      expect(follow.following).toBe(true)
    }
    // Final anchor landed on the newest scrollHeight: position IS the bottom.
    expect(isAtBottom(position(scrollHeight - CLIENT_HEIGHT, scrollHeight))).toBe(true)
  })

  it('B (race): an echo that sees content grown again is still an echo, not "user left"', () => {
    const follow = new BottomFollowController()
    // 120px of content arrives between the anchor write and its echo —
    // enough to make the echo position NOT at-bottom under the threshold.
    for (let tick = 0; tick < 10; tick += 1) {
      streamTick(follow, 800 + tick * 120, 120)
      expect(follow.following).toBe(true)
    }
  })

  it('E: composer growth (clientHeight shrink) re-anchors and stays following', () => {
    const follow = new BottomFollowController()
    const top = 1000 - CLIENT_HEIGHT
    follow.recordInstantAnchor(top)
    follow.onScroll(position(top, 1000))
    // Composer grows by 36px → the same scrollTop now sits 36px "above" bottom.
    const afterComposer = follow.onScroll({ scrollTop: top, scrollHeight: 1000, clientHeight: CLIENT_HEIGHT - 36 })
    // The runtime anchored instantly to the new bottom; echo keeps follow on.
    follow.recordInstantAnchor(1000 - (CLIENT_HEIGHT - 36))
    follow.onScroll(position(1000 - (CLIENT_HEIGHT - 36), 1000))
    expect(afterComposer).toBe(true)
    expect(follow.following).toBe(true)
  })

  it('G: a resize-driven re-anchor while following keeps the bottom pinned', () => {
    const follow = new BottomFollowController()
    // Follow=true (user at bottom); tool details expand by 300px.
    streamTick(follow, 1600, 300)
    expect(follow.following).toBe(true)
    // The next anchor writes the new bottom and its echo is suppressed.
    follow.recordInstantAnchor(1900 - CLIENT_HEIGHT)
    follow.onScroll(position(1900 - CLIENT_HEIGHT, 1900))
    expect(follow.following).toBe(true)
  })
})

describe('BottomFollowController — user takes over (C/D/H)', () => {
  it('C: a real upward scroll stops follow, and growth never drags the user back', () => {
    const follow = new BottomFollowController()
    streamTick(follow, 1000)
    // User scrolls up while streaming continues.
    expect(follow.onScroll(position(120, 2000))).toBe(false)
    // More content arrives; no anchor is performed while not following, and
    // every scroll event keeps reporting "not following".
    expect(follow.onScroll(position(120, 2400))).toBe(false)
    expect(follow.following).toBe(false)
  })

  it('D: scrolling back to the bottom re-engages follow', () => {
    const follow = new BottomFollowController()
    expect(follow.onScroll(position(120, 2000))).toBe(false)
    expect(follow.onScroll(position(2000 - CLIENT_HEIGHT, 2000))).toBe(true)
    expect(follow.following).toBe(true)
  })

  it('H: while not following, resize-driven events never flip follow back on', () => {
    const follow = new BottomFollowController()
    expect(follow.onScroll(position(80, 2000))).toBe(false)
    // ResizeObserver fires repeatedly as content grows; the user stays put.
    for (let tick = 0; tick < 5; tick += 1) {
      expect(follow.onScroll(position(80, 2000 + tick * 150))).toBe(false)
    }
    expect(follow.following).toBe(false)
  })

  it('a user scroll between an anchor and its echo wins over the echo', () => {
    const follow = new BottomFollowController()
    const anchorTop = 1000 - CLIENT_HEIGHT
    follow.recordInstantAnchor(anchorTop)
    // The user grabs the wheel BEFORE the anchor's echo is delivered.
    expect(follow.onScroll(position(200, 1000))).toBe(false)
    // Now the echo arrives with the anchored top: suppressed, and it must NOT
    // resurrect follow — the user is reading.
    expect(follow.onScroll(position(anchorTop, 1000))).toBe(false)
    expect(follow.following).toBe(false)
  })
})

describe('BottomFollowController — session switch and smooth bottom button (F/13)', () => {
  it('F: switching sessions forces follow back on from any state', () => {
    const follow = new BottomFollowController()
    expect(follow.onScroll(position(120, 2000))).toBe(false)
    follow.resetToFollowing()
    expect(follow.following).toBe(true)
    // The instant snap's echo is suppressed like any other anchor.
    follow.recordInstantAnchor(2400 - CLIENT_HEIGHT)
    follow.onScroll(position(2400 - CLIENT_HEIGHT, 2400))
    expect(follow.following).toBe(true)
  })

  it('smooth bottom-button travel ignores intermediate events and re-engages on arrival', () => {
    const follow = new BottomFollowController()
    expect(follow.onScroll(position(120, 2000))).toBe(false)
    follow.beginSmoothTravel()
    // Mid-travel positions (smooth scroll in flight) never read as "user left".
    expect(follow.onScroll(position(600, 2000))).toBe(false)
    expect(follow.onScroll(position(1300, 2000))).toBe(false)
    // Arrival clears the latch and re-engages follow.
    expect(follow.onScroll(position(2000 - CLIENT_HEIGHT, 2000))).toBe(true)
    expect(follow.following).toBe(true)
  })

  it('user input during a smooth travel cancels the latch immediately', () => {
    const follow = new BottomFollowController()
    follow.beginSmoothTravel()
    follow.userInterrupted()
    // The latch is gone: a real mid-travel position decides follow normally.
    expect(follow.onScroll(position(700, 2000))).toBe(false)
  })

  it('userInterrupted also drops a pending anchor echo', () => {
    const follow = new BottomFollowController()
    follow.recordInstantAnchor(600)
    follow.userInterrupted()
    // With the echo armed this exact position would be suppressed; with it
    // cleared the event is EVALUATED — content grew, user is not at bottom.
    expect(follow.onScroll(position(600, 1400))).toBe(false)
    expect(follow.following).toBe(false)
  })
})
