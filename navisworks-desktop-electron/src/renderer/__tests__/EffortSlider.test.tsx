import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EffortSlider,
  semanticIndexForKey,
  sliderPositionFromClientX,
  visualPctForExternalValue,
  visualPctForValue,
} from '../EffortSlider'

describe('EffortSlider continuous visual state', () => {
  beforeAll(() => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
    })
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('preserves a continuous 43.7% pointer position instead of rounding it to 50%', () => {
    const position = sliderPositionFromClientX(43.7, 0, 100, 4, 2)

    expect(position.visualPct).toBeCloseTo(43.7, 5)
    expect(position.semanticIndex).toBe(2)
  })

  it('does not report a semantic change while the pointer stays in the same tier', () => {
    const first = sliderPositionFromClientX(30, 0, 100, 4, 1)
    const second = sliderPositionFromClientX(34, 0, 100, 4, first.semanticIndex)

    expect(first.semanticChanged).toBe(false)
    expect(second.semanticChanged).toBe(false)
  })

  it('reports a semantic change only after crossing the next threshold', () => {
    expect(sliderPositionFromClientX(37.4, 0, 100, 4, 1)).toMatchObject({
      semanticIndex: 1,
      semanticChanged: false,
    })
    expect(sliderPositionFromClientX(37.6, 0, 100, 4, 1)).toMatchObject({
      semanticIndex: 2,
      semanticChanged: true,
    })
  })

  it('snaps to the exact position of the selected semantic tier', () => {
    expect(visualPctForValue(2, 4)).toBe(50)
    expect(visualPctForValue(3, 4)).toBe(75)
  })

  it('maps ArrowLeft and ArrowRight to adjacent semantic tiers', () => {
    expect(semanticIndexForKey('ArrowLeft', 2, 4)).toBe(1)
    expect(semanticIndexForKey('ArrowRight', 2, 4)).toBe(3)
  })

  it('maps Home and End to the first and last exact positions', () => {
    expect(visualPctForValue(semanticIndexForKey('Home', 2, 4)!, 4)).toBe(0)
    expect(visualPctForValue(semanticIndexForKey('End', 2, 4)!, 4)).toBe(100)
  })

  it('keeps max=0 finite and pinned to the first semantic tier', () => {
    const position = sliderPositionFromClientX(50, 0, 100, 0, 0)

    expect(position).toEqual({ visualPct: 0, semanticIndex: 0, semanticChanged: false })
    expect(Number.isFinite(visualPctForValue(4, 0))).toBe(true)
  })

  it('renders the business label through aria-valuetext', () => {
    const html = renderToStaticMarkup(
      <EffortSlider
        value={2}
        max={4}
        ariaLabel="推理强度"
        ariaValueText="High"
        onChange={() => {}}
      />,
    )

    expect(html).toContain('aria-valuetext="High"')
  })

  it('synchronizes an external value while idle', () => {
    expect(visualPctForExternalValue(18.25, 3, 4, false)).toBe(75)
  })

  it('does not let an external value steal the pointer position during a drag', () => {
    expect(visualPctForExternalValue(43.7, 3, 4, true)).toBeCloseTo(43.7, 5)
  })

  it('uses the final semantic value for the release snap', () => {
    const drag = sliderPositionFromClientX(81.15, 0, 100, 4, 2)

    expect(drag.visualPct).toBeCloseTo(81.15, 5)
    expect(visualPctForValue(drag.semanticIndex, 4)).toBe(75)
  })
})
