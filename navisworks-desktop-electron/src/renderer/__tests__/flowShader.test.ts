import { describe, expect, it } from 'vitest'
import {
  FLOW_FRAGMENT_SHADER,
  FLOW_STOPS,
  FLOW_TIERS,
  FLOW_VERTEX_SHADER,
  advanceFlowHead,
  advanceFlowTrail,
  flowTierColors
} from '../flowShader'

describe('flowShader GLSL sources', () => {
  it('declares every uniform the host binds', () => {
    // Keep these two files from drifting: every name FlowLightCanvas asks
    // `getUniformLocation` for must appear in the fragment source.
    const uniforms = [
      'u_resolution',
      'u_time',
      'u_sheen',
      'u_bubble_time',
      'u_max_burst',
      'u_head',
      'u_trail',
      'u_level',
      'u_from',
      'u_to',
      'u_palette'
    ]
    for (const name of uniforms) {
      expect(FLOW_FRAGMENT_SHADER).toContain(`uniform `)
      expect(FLOW_FRAGMENT_SHADER).toContain(name)
    }
  })

  it('no longer multiplies time by speed in the shader', () => {
    // The host bakes tier speed + eased scrub into the phase advance, so
    // `u_time * u_speed` (which teleported the field on tier change) must
    // stay gone.
    expect(FLOW_FRAGMENT_SHADER).not.toContain('u_time * u_speed')
  })

  it('is a WebGL2 fragment shader with a single output', () => {
    expect(FLOW_FRAGMENT_SHADER).toContain('#version 300 es')
    expect(FLOW_FRAGMENT_SHADER).toContain('out vec4 fragColor')
  })

  it('declares highp precision — mediump collapses fbm detail within a minute', () => {
    expect(FLOW_FRAGMENT_SHADER).toContain('precision highp float')
  })

  it('corrects the aspect on the wide axis (uv.x * aspect, not uv.y)', () => {
    // Scaling uv.y over-corrects into ~60:1 vertical striping.
    expect(FLOW_FRAGMENT_SHADER).toContain('vec2(uv.x * aspect, uv.y)')
    expect(FLOW_FRAGMENT_SHADER).not.toContain('uv.y * aspect')
  })

  it('vertex shader needs no attributes (gl_VertexID only)', () => {
    expect(FLOW_VERTEX_SHADER).toContain('gl_VertexID')
    expect(FLOW_VERTEX_SHADER).toContain('#version 300 es')
  })

  it('bands stay inside [0, u_head] — the region past the head is transparent', () => {
    // The hard cut became a mask alpha: full inside the fill, fading over
    // u_trail past it (backward motion), fully transparent beyond the trail.
    expect(FLOW_FRAGMENT_SHADER).toContain('maskAlpha = uv.x <= u_head')
    expect(FLOW_FRAGMENT_SHADER).toContain('if (maskAlpha <= 0.0)')
    expect(FLOW_FRAGMENT_SHADER).toContain('fragColor = vec4(0.0)')
  })

  it('backward trail fades with u_trail and degenerates to a hard cut at 0', () => {
    expect(FLOW_FRAGMENT_SHADER).toContain('uniform float u_trail')
    // Zero trail must be an exact cut: no epsilon-wide tail may peek past
    // the handle on forward motion.
    expect(FLOW_FRAGMENT_SHADER).toContain('1.0 - smoothstep(0.0, u_trail, uv.x - u_head)')
    expect(FLOW_FRAGMENT_SHADER).toContain('(u_trail > 0.0 ? trailFade : 0.0)')
  })

  it('head bloom mixes instead of adding white (no clipped plateau)', () => {
    // Additive bloom hit ~2.0 at the head and hard-clipped every tier to
    // the same pure white; the mix form is bounded by construction.
    expect(FLOW_FRAGMENT_SHADER).toContain('color = min(color, vec3(1.0))')
    expect(FLOW_FRAGMENT_SHADER).toContain('mix(color, bloomCol')
  })

  it('sheen phase comes pre-wrapped from the host so the sweep repeats', () => {
    expect(FLOW_FRAGMENT_SHADER).toContain('u_head - u_sheen * u_head')
  })

  it('keeps the flowing bubble layer exclusive to the Max tier', () => {
    expect(FLOW_FRAGMENT_SHADER).toContain('smoothstep(0.90, 0.99, u_level)')
    expect(FLOW_FRAGMENT_SHADER).toContain('for (int i = 0; i < 12; i++)')
    expect(FLOW_FRAGMENT_SHADER).toContain('i < 5 ? 1.0 : u_max_burst')
    expect(FLOW_FRAGMENT_SHADER).toContain('u_bubble_time')
    expect(FLOW_FRAGMENT_SHADER).toContain('u_max_burst')
  })

  it('reveals more of the cumulative palette as the effort level rises', () => {
    expect(FLOW_FRAGMENT_SHADER).toContain('cumulativePalette(baseT, 1.0 + u_level * 4.0)')
    expect(FLOW_FRAGMENT_SHADER).toContain('u_palette[5]')
  })
})

describe('flowTierColors', () => {
  it('returns the exact tier palette at integer levels', () => {
    expect(flowTierColors(0)).toEqual({ from: '#a5f3fc', to: '#67e8f9', speed: 0.5 })
    expect(flowTierColors(4)).toEqual({ from: '#8b5cf6', to: '#6d28d9', speed: 1.5 })
  })

  it('interpolates between adjacent tiers at fractional levels', () => {
    const mid = flowTierColors(2.5)
    // midpoint between l2 (#7dd3fc→#818cf8) and l3 (#818cf8→#8b5cf6)
    expect(mid.from).toBe('#7fb0fa')
    expect(mid.to).toBe('#8674f7')
    expect(mid.speed).toBeCloseTo(1.125, 5)
  })

  it('chains every tier endpoint into the next tier without a color jump', () => {
    for (let index = 1; index < FLOW_TIERS.length; index += 1) {
      expect(FLOW_TIERS[index]!.from).toBe(FLOW_TIERS[index - 1]!.to)
    }
  })

  it('keeps the complete cyan-to-violet sequence in one shared palette', () => {
    expect(FLOW_STOPS).toEqual([
      '#a5f3fc',
      '#67e8f9',
      '#7dd3fc',
      '#818cf8',
      '#8b5cf6',
      '#6d28d9'
    ])
  })

  it('clamps out-of-range levels instead of throwing', () => {
    expect(flowTierColors(-1)).toEqual(flowTierColors(0))
    expect(flowTierColors(99)).toEqual(flowTierColors(4))
  })

  it('returns tier 0 for NaN instead of throwing', () => {
    // level = Math.round((value / max) * 4) is NaN whenever max === 0;
    // this used to dereference FLOW_TIERS[NaN] inside the render loop.
    expect(() => flowTierColors(NaN)).not.toThrow()
    expect(flowTierColors(NaN)).toEqual(flowTierColors(0))
  })

  it('keeps five tiers, one per effort step', () => {
    expect(FLOW_TIERS).toHaveLength(5)
  })
})

describe('advanceFlowHead', () => {
  it('tracks the target 1:1 while dragging — no trailing gap at the handle', () => {
    // A fast Low→Medium drag moves the target far ahead of the eased head;
    // the head must snap instead of lagging behind the handle.
    expect(advanceFlowHead(0.25, 0.5, 1 / 60, true, false)).toBe(0.5)
    expect(advanceFlowHead(0.25, 0.5, 0, true, false)).toBe(0.5)
  })

  it('tracks the target 1:1 under reduced motion (dt is frozen at 0)', () => {
    // dt stays 0 with prefers-reduced-motion, so the old ease could never
    // move the head at all and the bar froze at its mount value.
    expect(advanceFlowHead(0.25, 0.5, 0, false, true)).toBe(0.5)
  })

  it('eases toward the target without overshooting when idle', () => {
    let head = 0.25
    for (let frame = 0; frame < 120; frame += 1) {
      const next = advanceFlowHead(head, 0.5, 1 / 60, false, false)
      // Monotonic approach; the final frame snaps via the epsilon and holds.
      expect(next).toBeGreaterThanOrEqual(head)
      expect(next).toBeLessThanOrEqual(0.5)
      head = next
    }
    expect(head).toBeCloseTo(0.5, 5)
  })

  it('keeps easing continuous across a mid-drag release', () => {
    // Release mid-travel: scrub goes 0, and the ease resumes from the value
    // the drag had already reached — no jump backward or forward.
    const atRelease = advanceFlowHead(0.3, 0.5, 1 / 60, true, false)
    const afterRelease = advanceFlowHead(atRelease, 0.5, 1 / 60, false, false)
    expect(afterRelease).toBeGreaterThanOrEqual(atRelease)
    expect(afterRelease).toBeLessThanOrEqual(0.5)
  })

  it('clamps out-of-range targets into 0…1', () => {
    expect(advanceFlowHead(0.5, -2, 1 / 60, true, false)).toBe(0)
    expect(advanceFlowHead(0.5, 7, 1 / 60, true, false)).toBe(1)
  })

  it('holds the current head for a NaN target instead of moving', () => {
    expect(advanceFlowHead(0.4, NaN, 1 / 60, false, false)).toBe(0.4)
  })
})

describe('advanceFlowTrail', () => {
  it('grows the trail from head retreat so lowered light fades instead of cutting', () => {
    // A one-frame retreat of 0.05 stretches the fade band just behind it.
    expect(advanceFlowTrail(0, 0.5, 0.45, 1 / 60)).toBeCloseTo(0.045, 6)
  })

  it('keeps the trail at zero for forward motion and stillness', () => {
    expect(advanceFlowTrail(0, 0.3, 0.5, 1 / 60)).toBe(0)
    expect(advanceFlowTrail(0, 0.4, 0.4, 1 / 60)).toBe(0)
  })

  it('never draws the fade past an advancing head', () => {
    // Forward motion kills the trail outright: a lingering band would draw
    // light past the handle and the fill would outrun the slider.
    expect(advanceFlowTrail(0.3, 0.2, 0.5, 1 / 60)).toBe(0)
  })

  it('tracks recent retreat, not the gesture high-water mark', () => {
    // Half a second after a Max→XHigh jump the wake must be fully gone —
    // a slower decay read as the light lagging the handle at the new tier.
    let trail = advanceFlowTrail(0, 1.0, 0.75, 1 / 60)
    for (let frame = 1; frame < 30; frame += 1) {
      trail = advanceFlowTrail(trail, 0.75, 0.75, 1 / 60)
    }
    expect(trail).toBe(0)
  })

  it('decays to zero once the head stops retreating', () => {
    let trail = 0.1
    for (let frame = 0; frame < 120; frame += 1) {
      trail = advanceFlowTrail(trail, 0.4, 0.4, 1 / 60)
      expect(trail).toBeGreaterThanOrEqual(0)
    }
    expect(trail).toBe(0)
  })

  it('clamps the trail so a huge jump backward fades over a bounded band', () => {
    // A whole-bar retreat grows the band, capped at 0.35, then decays.
    const grown = advanceFlowTrail(0, 1.0, 0.0, 1 / 60)
    expect(grown).toBeLessThanOrEqual(0.35)
    expect(grown).toBeGreaterThan(0.3)
  })
})
