import { describe, expect, it } from 'vitest'
import {
  ACTUAL_BOTTOM_EPSILON_PX,
  BOTTOM_INVARIANT_FAILED_HINT,
  BottomFollowController,
  FOLLOW_REENGAGE_THRESHOLD_PX,
  checkBottomInvariant,
  distanceFromBottom,
  isAtBottom,
} from '../bottomFollow'

// A stable viewport: clientHeight 400. "At bottom" ⇔ scrollTop === scrollHeight - 400.
const CLIENT_HEIGHT = 400

function position(scrollTop: number, scrollHeight: number) {
  return { scrollTop, scrollHeight, clientHeight: CLIENT_HEIGHT }
}

/** One streaming tick: content grows, the runtime anchors instantly to the
 * exact true bottom, then the browser delivers the echo scroll event. */
function streamTick(follow: BottomFollowController, scrollHeight: number, grownAgain = 0): void {
  const top = scrollHeight - CLIENT_HEIGHT
  follow.recordInstantAnchor(top)
  // The echo may observe content that grew AGAIN after the write — the exact
  // race that used to kill follow when this path was smooth.
  follow.onScroll(position(top, scrollHeight + grownAgain))
}

describe('distanceFromBottom — DOM geometry is the scroll truth (Cases A–C)', () => {
  it('Case A: at the exact bottom → distance 0', () => {
    expect(distanceFromBottom(position(600, 1000))).toBe(0)
  })

  it('Case B: 50px above the bottom → distance 50', () => {
    expect(distanceFromBottom(position(550, 1000))).toBe(50)
  })

  it('Case C: near-bottom (≤64) is NOT actual-bottom (≤2)', () => {
    // 40px away: near-bottom says following, actual-bottom says no.
    expect(distanceFromBottom(position(560, 1000))).toBe(40)
    expect(isAtBottom(position(560, 1000))).toBe(true)
    expect(distanceFromBottom(position(560, 1000)) <= ACTUAL_BOTTOM_EPSILON_PX).toBe(false)
    // The thresholds themselves must never collapse into each other.
    expect(ACTUAL_BOTTOM_EPSILON_PX).toBe(2)
    expect(FOLLOW_REENGAGE_THRESHOLD_PX).toBe(64)
    expect(distanceFromBottom(position(600, 1000)) <= ACTUAL_BOTTOM_EPSILON_PX).toBe(true)
  })

  it('clamps negative distances (overscroll) to 0', () => {
    expect(distanceFromBottom(position(700, 1000))).toBe(0)
  })
})

describe('checkBottomInvariant — following ⇒ distance ≤ epsilon', () => {
  it('passes at the true bottom and fails 86px away', () => {
    expect(checkBottomInvariant(position(600, 1000))).toEqual({ ok: true, distance: 0 })
    const failed = checkBottomInvariant(position(514, 1000))
    expect(failed.ok).toBe(false)
    expect(failed.distance).toBe(86)
  })
})

describe('BottomFollowController — streaming follow (A/B/E/G)', () => {
  it('A: following at the bottom, a new message anchors and the echo keeps follow on', () => {
    const follow = new BottomFollowController()
    expect(follow.following).toBe(true)
    streamTick(follow, 1000)
    expect(follow.following).toBe(true)
    streamTick(follow, 1400)
    expect(follow.following).toBe(true)
  })

  it('B: ten consecutive growth ticks keep follow true and end at the true bottom', () => {
    const follow = new BottomFollowController()
    let scrollHeight = 800
    for (let tick = 0; tick < 10; tick += 1) {
      scrollHeight += 120
      streamTick(follow, scrollHeight)
      expect(follow.following).toBe(true)
    }
    // Final anchor landed on the newest scrollHeight: distance ≈ 0.
    expect(distanceFromBottom(position(scrollHeight - CLIENT_HEIGHT, scrollHeight))).toBe(0)
  })

  it('B (race): echoes that see content grown again are ours, not "user left"', () => {
    const follow = new BottomFollowController()
    // 120px of content arrives between the anchor write and its echo —
    // enough to make the echo position NOT at-bottom under the threshold.
    for (let tick = 0; tick < 10; tick += 1) {
      streamTick(follow, 800 + tick * 120, 120)
      expect(follow.following).toBe(true)
    }
  })

  it('double-anchor race: a stale echo of the FIRST anchor never kills follow', () => {
    // The old failure mode: anchor→write(T1), growth, anchor→write(T2) which
    // overwrites the pending top, then T1's echo arrives late and looked like
    // a user scroll away from the new bottom. Follow must survive.
    const follow = new BottomFollowController()
    follow.recordInstantAnchor(600) // anchor 1 at content height 1000
    follow.recordInstantAnchor(1000) // anchor 2 after growth to height 1400
    follow.onScroll(position(600, 1000)) // stale echo of anchor 1
    expect(follow.following).toBe(true)
    follow.onScroll(position(1000, 1400)) // echo of anchor 2 confirms
    expect(follow.following).toBe(true)
  })

  it('E: composer growth (clientHeight shrink) re-anchors and stays following', () => {
    const follow = new BottomFollowController()
    const top = 1000 - CLIENT_HEIGHT
    follow.recordInstantAnchor(top)
    follow.onScroll(position(top, 1000))
    // Composer grows by 36px → the same scrollTop now sits 36px "above" bottom;
    // the runtime anchors instantly to the new bottom and its echo keeps follow.
    follow.recordInstantAnchor(1000 - (CLIENT_HEIGHT - 36))
    follow.onScroll(position(1000 - (CLIENT_HEIGHT - 36), 1000))
    expect(follow.following).toBe(true)
  })

  it('G: a resize-driven re-anchor while following keeps the bottom pinned', () => {
    const follow = new BottomFollowController()
    streamTick(follow, 1600, 300)
    expect(follow.following).toBe(true)
    follow.recordInstantAnchor(1900 - CLIENT_HEIGHT)
    follow.onScroll(position(1900 - CLIENT_HEIGHT, 1900))
    expect(follow.following).toBe(true)
  })
})

describe('BottomFollowController — user takes over (C/D/H)', () => {
  it('C: real user input stops follow, and growth never drags the user back', () => {
    const follow = new BottomFollowController()
    streamTick(follow, 1000)
    // The user grabs the wheel (or touches / presses on the scroller):
    follow.userInterrupted()
    expect(follow.onScroll(position(120, 2000))).toBe(false)
    // More content arrives; no anchor is performed while not following, and
    // every scroll event keeps reporting "not following".
    expect(follow.onScroll(position(120, 2400))).toBe(false)
    expect(follow.following).toBe(false)
  })

  it('D: scrolling back to the bottom re-engages follow', () => {
    const follow = new BottomFollowController()
    follow.userInterrupted()
    expect(follow.onScroll(position(120, 2000))).toBe(false)
    expect(follow.onScroll(position(2000 - CLIENT_HEIGHT, 2000))).toBe(true)
    expect(follow.following).toBe(true)
  })

  it('H: while not following, resize-driven events never flip follow back on', () => {
    const follow = new BottomFollowController()
    follow.userInterrupted()
    expect(follow.onScroll(position(80, 2000))).toBe(false)
    for (let tick = 0; tick < 5; tick += 1) {
      expect(follow.onScroll(position(80, 2000 + tick * 150))).toBe(false)
    }
    expect(follow.following).toBe(false)
  })

  it('a stale in-flight anchor echo cannot resurrect or veto a real user scroll', () => {
    const follow = new BottomFollowController()
    follow.recordInstantAnchor(600)
    // The user wheel-interrupts BEFORE the echo: all guards clear…
    follow.userInterrupted()
    // …so this position is EVALUATED (content grew → not at bottom → false),
    // whereas with the guard armed it would have been suppressed.
    expect(follow.onScroll(position(600, 1400))).toBe(false)
    expect(follow.following).toBe(false)
  })
})

describe('BottomFollowController — session switch and smooth bottom button (F/13)', () => {
  it('F: switching sessions forces follow back on from any state', () => {
    const follow = new BottomFollowController()
    follow.userInterrupted()
    expect(follow.onScroll(position(120, 2000))).toBe(false)
    follow.resetToFollowing()
    expect(follow.following).toBe(true)
    follow.recordInstantAnchor(2400 - CLIENT_HEIGHT)
    follow.onScroll(position(2400 - CLIENT_HEIGHT, 2400))
    expect(follow.following).toBe(true)
  })

  it('smooth bottom-button travel ignores intermediate events and re-engages on arrival', () => {
    const follow = new BottomFollowController()
    follow.userInterrupted()
    expect(follow.onScroll(position(120, 2000))).toBe(false)
    follow.beginSmoothTravel()
    expect(follow.onScroll(position(600, 2000))).toBe(false)
    expect(follow.onScroll(position(1300, 2000))).toBe(false)
    expect(follow.onScroll(position(2000 - CLIENT_HEIGHT, 2000))).toBe(true)
    expect(follow.following).toBe(true)
  })

  it('user input during a smooth travel cancels the latch immediately', () => {
    const follow = new BottomFollowController()
    follow.beginSmoothTravel()
    follow.userInterrupted()
    expect(follow.onScroll(position(700, 2000))).toBe(false)
  })
})

describe('diagnostics wiring', () => {
  it('exports the invariant-failure log tag for MessageList', () => {
    expect(BOTTOM_INVARIANT_FAILED_HINT).toBe('BOTTOM_INVARIANT_FAILED')
  })
})

describe('layout changes after reading expanded details', () => {
  it('reengages follow when collapse reaches the bottom without a scroll event', () => {
    const controller = new BottomFollowController()
    controller.userInterrupted()
    controller.onScroll({ scrollTop: 100, scrollHeight: 1400, clientHeight: 400 })
    expect(controller.following).toBe(false)
    controller.onLayout({ scrollTop: 100, scrollHeight: 500, clientHeight: 400 })
    expect(controller.following).toBe(true)
  })
  it('keeps the reader in history if content still remains below', () => {
    const controller = new BottomFollowController()
    controller.onScroll({ scrollTop: 100, scrollHeight: 1400, clientHeight: 400 })
    controller.onLayout({ scrollTop: 100, scrollHeight: 900, clientHeight: 400 })
    expect(controller.following).toBe(false)
  })
})
