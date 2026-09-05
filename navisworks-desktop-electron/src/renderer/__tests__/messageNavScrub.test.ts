import { describe, expect, it } from 'vitest'
import {
  NAV_DRAG_THRESHOLD_PX,
  clamp01,
  interpolateScrollTop,
  navDragReducer,
  nearestStopIndexFromClientY,
  type NavDragState,
  type NavScrubStop,
} from '../messageNavScrub'

// Bars sit evenly spaced on the rail but their turns sit at wildly uneven
// scroll positions — the whole point of anchor stops: a rail fraction is NOT
// a document fraction. (Const tuple so bar indexes stay non-optional.)
const stops = [
  { index: 0, anchorId: 'turn-0', railY: 100, scrollTop: 0 },
  { index: 1, anchorId: 'turn-1', railY: 120, scrollTop: 180 },
  { index: 2, anchorId: 'turn-2', railY: 140, scrollTop: 900 },
  { index: 3, anchorId: 'turn-3', railY: 160, scrollTop: 1240 },
  { index: 4, anchorId: 'turn-4', railY: 180, scrollTop: 2600 },
] as const satisfies readonly NavScrubStop[]

// Press + the move that crosses the threshold — the gesture's start.
function dragStart(clientY: number, anchorIndex: number, pointerOffsetY = 0): NavDragState {
  const pressed = navDragReducer(null, {
    kind: 'pointerdown',
    pointerId: 1,
    clientY,
    anchorIndex,
    pointerOffsetY,
  }).state!
  return navDragReducer(pressed, { kind: 'pointermove', clientY: clientY + NAV_DRAG_THRESHOLD_PX + 1 }).state!
}

describe('interpolateScrollTop maps bars onto real turn positions', () => {
  it('each bar resolves exactly to its turn\'s measured scrollTop', () => {
    expect(interpolateScrollTop(100, stops)).toBe(0)
    expect(interpolateScrollTop(120, stops)).toBe(180)
    expect(interpolateScrollTop(140, stops)).toBe(900)
    expect(interpolateScrollTop(160, stops)).toBe(1240)
    expect(interpolateScrollTop(180, stops)).toBe(2600)
  })

  it('between two bars it travels between THEIR positions, not the document\'s', () => {
    // Halfway between turn 1 (180) and turn 2 (900) — a global ratio ×
    // maxScroll would land somewhere entirely different here.
    expect(interpolateScrollTop(130, stops)).toBe((180 + 900) / 2)
    expect(interpolateScrollTop(125, stops)).toBe(180 + (900 - 180) * 0.25)
  })

  it('beyond the rail ends clamps to the first/last turn', () => {
    expect(interpolateScrollTop(50, stops)).toBe(0)
    expect(interpolateScrollTop(9999, stops)).toBe(2600)
  })

  it('returns 0 for an empty rail', () => {
    expect(interpolateScrollTop(130, [])).toBe(0)
  })
})

describe('nearestStopIndexFromClientY resolves presses to bars', () => {
  it('lands on the pressed bar itself', () => {
    expect(nearestStopIndexFromClientY(140, stops)).toBe(2)
  })

  it('presses on gaps or padding pick the bar nearest the pointer', () => {
    expect(nearestStopIndexFromClientY(128, stops)).toBe(1)
    expect(nearestStopIndexFromClientY(133, stops)).toBe(2)
    expect(nearestStopIndexFromClientY(90, stops)).toBe(0)
    expect(nearestStopIndexFromClientY(4000, stops)).toBe(4)
  })

  it('returns the first bar when there is nothing to measure', () => {
    expect(nearestStopIndexFromClientY(100, [])).toBe(0)
  })
})

describe('nav drag state machine (anchor-based)', () => {
  it('pointerdown records the anchor and offset and scrolls nothing', () => {
    // Exact shape: nothing like a startScrollTop may exist — the drag's
    // origin is only the pressed bar's turn, never the viewport.
    const result = navDragReducer(null, {
      kind: 'pointerdown',
      pointerId: 1,
      clientY: 165,
      anchorIndex: 3,
      pointerOffsetY: 5,
    })
    expect(result.state).toEqual({
      pointerId: 1,
      startY: 165,
      dragging: false,
      anchorIndex: 3,
      pointerOffsetY: 5,
    })
    expect(result.outcome).toEqual({ kind: 'none' })
  })

  it('a move within the 4px threshold stays a press; release clicks the anchor turn', () => {
    const pressed = navDragReducer(null, {
      kind: 'pointerdown',
      pointerId: 1,
      clientY: stops[4].railY,
      anchorIndex: 4,
      pointerOffsetY: 0,
    }).state!
    const moved = navDragReducer(pressed, { kind: 'pointermove', clientY: stops[4].railY + NAV_DRAG_THRESHOLD_PX })
    expect(moved.outcome.kind).toBe('none')
    expect(moved.state?.dragging).toBe(false)

    const up = navDragReducer(moved.state, { kind: 'pointerup' })
    expect(up.state).toBeNull()
    expect(up.outcome).toEqual({ kind: 'click' })
  })

  it('drag-start from the last bar anchors there even though the viewport was elsewhere', () => {
    // Viewing turn 0 while pressing the LAST bar: the reducer records only
    // the anchor — the receiver snaps to stops[4].scrollTop (2600), never to
    // anything derived from the old viewport position.
    const entered = navDragReducer(
      navDragReducer(null, {
        kind: 'pointerdown',
        pointerId: 1,
        clientY: stops[4].railY,
        anchorIndex: 4,
        pointerOffsetY: 0,
      }).state!,
      { kind: 'pointermove', clientY: stops[4].railY + NAV_DRAG_THRESHOLD_PX + 1 },
    )
    expect(entered.outcome).toEqual({ kind: 'drag-start' })
    expect(entered.state?.dragging).toBe(true)
    expect(entered.state?.anchorIndex).toBe(4)
  })

  it('drag-start from turn 3 anchors turn 3; from turn 2 anchors turn 2', () => {
    expect(dragStart(stops[2].railY, 2).anchorIndex).toBe(2)
    expect(dragStart(stops[1].railY, 1).anchorIndex).toBe(1)
  })

  it('after drag-start, moving up interpolates toward the previous turn', () => {
    const started = dragStart(stops[4].railY, 4)
    const moved = navDragReducer(started, { kind: 'pointermove', clientY: stops[3].railY })
    expect(moved.outcome).toEqual({ kind: 'scroll', clientY: stops[3].railY })
    // The same math MessageList runs per 'scroll' outcome.
    const effectiveRailY = stops[3].railY - started.pointerOffsetY
    expect(interpolateScrollTop(effectiveRailY, stops)).toBe(1240)
  })

  it('after drag-start, moving down interpolates toward the next turn', () => {
    const started = dragStart(stops[1].railY, 1)
    const moved = navDragReducer(started, { kind: 'pointermove', clientY: stops[2].railY })
    expect(moved.outcome).toEqual({ kind: 'scroll', clientY: stops[2].railY })
    const effectiveRailY = stops[2].railY - started.pointerOffsetY
    expect(interpolateScrollTop(effectiveRailY, stops)).toBe(900)
  })

  it('a grab below the bar center rides along without jumping', () => {
    // Pressed 5px below turn 3's bar: offset 5. Moving back to the press
    // point must read as turn 3's position, not shift by the offset.
    const offsetY = 5
    const started = dragStart(stops[3].railY + offsetY, 3, offsetY)
    const moved = navDragReducer(started, { kind: 'pointermove', clientY: stops[3].railY + offsetY })
    const effectiveRailY = moved.outcome.kind === 'scroll' ? moved.outcome.clientY - started.pointerOffsetY : NaN
    expect(interpolateScrollTop(effectiveRailY, stops)).toBe(1240)
  })

  it('releasing after a drag keeps the position: no snap, no recompute', () => {
    const started = dragStart(stops[2].railY, 2)
    const up = navDragReducer(started, { kind: 'pointerup' })
    expect(up.state).toBeNull()
    expect(up.outcome.kind).toBe('none')
  })

  it('pointercancel clears the session and never reports a click', () => {
    const pressed = navDragReducer(null, {
      kind: 'pointerdown',
      pointerId: 1,
      clientY: stops[2].railY,
      anchorIndex: 2,
      pointerOffsetY: 0,
    }).state!
    const cancelled = navDragReducer(pressed, { kind: 'pointercancel' })
    expect(cancelled.state).toBeNull()
    expect(cancelled.outcome.kind).toBe('none')

    const dragging = dragStart(stops[2].railY, 2)
    const cancelledMidDrag = navDragReducer(dragging, { kind: 'pointercancel' })
    expect(cancelledMidDrag.state).toBeNull()
    expect(cancelledMidDrag.outcome.kind).toBe('none')
  })
})

describe('clamp01', () => {
  it('clamps to the unit range and maps non-finite input to 0', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0.25)).toBe(0.25)
    expect(clamp01(2)).toBe(1)
    expect(clamp01(Number.NaN)).toBe(0)
  })
})
