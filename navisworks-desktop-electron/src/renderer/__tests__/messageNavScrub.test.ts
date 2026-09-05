import { describe, expect, it } from 'vitest'
import {
  NAV_DRAG_THRESHOLD_PX,
  clickTargetTurnIndex,
  navDragReducer,
  navScrubScrollOptions,
  nearestTurnIndex,
  ratioFromClientY,
  type NavDragState,
} from '../messageNavScrub'

const NAV = { top: 100, height: 400 }
const TURN_COUNT = 5

describe('messageNavScrub geometry', () => {
  it('maps pointer positions across the whole rail box to ratios', () => {
    expect(ratioFromClientY(NAV.top, NAV.top, NAV.height)).toBe(0)
    expect(ratioFromClientY(NAV.top + 200, NAV.top, NAV.height)).toBe(0.5)
    expect(ratioFromClientY(NAV.top + NAV.height, NAV.top, NAV.height)).toBe(1)
    // Clamped at both ends so travel past the rail still means the ends.
    expect(ratioFromClientY(-50, NAV.top, NAV.height)).toBe(0)
    expect(ratioFromClientY(9999, NAV.top, NAV.height)).toBe(1)
  })

  it('resolves a ratio to the nearest turn with midpoint rounding', () => {
    expect(nearestTurnIndex(0, TURN_COUNT)).toBe(0)
    expect(nearestTurnIndex(1, TURN_COUNT)).toBe(TURN_COUNT - 1)
    // 0.18 of 4 gaps = 0.72 → nearest turn 1; 0.3 = 1.2 → nearest turn 1;
    // 0.35 = 1.4 → still 1; 0.4 = 1.6 → turn 2.
    expect(nearestTurnIndex(0.18, TURN_COUNT)).toBe(1)
    expect(nearestTurnIndex(0.3, TURN_COUNT)).toBe(1)
    expect(nearestTurnIndex(0.4, TURN_COUNT)).toBe(2)
  })
})

describe('messageNavScrub click resolution', () => {
  it('clicking an actual bar jumps to that turn, ignoring position drift', () => {
    // Pressed bar 3 even though the release ratio would land on 0.
    expect(clickTargetTurnIndex(3, 0.1, TURN_COUNT)).toBe(3)
  })

  it('clicking the blank gap between bars resolves to the nearest turn', () => {
    expect(clickTargetTurnIndex(null, 0.31, TURN_COUNT)).toBe(1)
    expect(clickTargetTurnIndex(null, 0.45, TURN_COUNT)).toBe(2)
    expect(clickTargetTurnIndex(null, 0.98, TURN_COUNT)).toBe(4)
  })

  it('clicking left/right padding still resolves via the y ratio', () => {
    // The x offset never enters this function — padding clicks are valid.
    expect(clickTargetTurnIndex(null, 0.55, TURN_COUNT)).toBe(2)
  })

  it('returns null when there is nothing to jump to', () => {
    expect(clickTargetTurnIndex(null, 0.5, 0)).toBeNull()
    expect(clickTargetTurnIndex(2, 0.5, 0)).toBeNull()
  })
})

describe('messageNavScrub drag state machine', () => {
  const press = (clientY: number): NavDragState | null =>
    navDragReducer(null, { kind: 'pointerdown', pointerId: 1, clientY }).state

  it('pointerdown alone records the anchor and scrolls nothing', () => {
    const result = navDragReducer(null, { kind: 'pointerdown', pointerId: 1, clientY: 250 })
    expect(result.state).toEqual({ pointerId: 1, startY: 250, dragging: false })
    expect(result.outcome).toEqual({ kind: 'none' })
  })

  it('a move within the 4px threshold stays a click, not a drag', () => {
    const moved = navDragReducer(press(250), { kind: 'pointermove', clientY: 250 + NAV_DRAG_THRESHOLD_PX })
    expect(moved.outcome.kind).toBe('none')
    expect(moved.state?.dragging).toBe(false)

    const up = navDragReducer(moved.state, { kind: 'pointerup' })
    expect(up.state).toBeNull()
    expect(up.outcome).toEqual({ kind: 'click' })
  })

  it('a move past the threshold enters dragging and emits scroll', () => {
    const entered = navDragReducer(press(250), { kind: 'pointermove', clientY: 250 + NAV_DRAG_THRESHOLD_PX + 1 })
    expect(entered.outcome.kind).toBe('scroll')
    expect(entered.state?.dragging).toBe(true)

    const up = navDragReducer(entered.state, { kind: 'pointerup' })
    expect(up.state).toBeNull()
    expect(up.outcome.kind).toBe('none')
  })

  it('pointercancel drops the state and never reports a click', () => {
    const cancelled = navDragReducer(press(250), { kind: 'pointercancel' })
    expect(cancelled.state).toBeNull()
    expect(cancelled.outcome.kind).toBe('none')
  })

  it('an absolute scrub maps rail position onto conversation scroll instantly', () => {
    const max = 800
    expect(navScrubScrollOptions(0, max)).toEqual({ top: 0, behavior: 'instant' })
    expect(navScrubScrollOptions(1, max)).toEqual({ top: 800, behavior: 'instant' })
    expect(navScrubScrollOptions(0.25, max).top).toBe(200)
    // No smooth behavior anywhere: scrub travel must be instant.
    expect(navScrubScrollOptions(0.9, max).behavior).toBe('instant')
  })
})
