import { describe, expect, it } from 'vitest'
import {
  FLOW_FRAGMENT_SHADER,
  FLOW_STOPS,
  FLOW_TIERS,
  FLOW_VERTEX_SHADER,
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
    expect(FLOW_FRAGMENT_SHADER).toContain('if (uv.x > u_head)')
    expect(FLOW_FRAGMENT_SHADER).toContain('fragColor = vec4(0.0)')
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
