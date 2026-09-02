/**
 * WebGL2 minimal vertex shader: a fullscreen triangle whose only attribute is
 * the clip-space position. The fragment shader does all the work, so no
 * per-vertex varyings are needed beyond the interpolated position itself.
 */
export const FLOW_VERTEX_SHADER = /* glsl */ `#version 300 es
void main() {
  vec2 clip = vec2(
    float((gl_VertexID << 1) & 2),
    float(gl_VertexID & 2)
  );
  gl_Position = vec4(clip * 2.0 - 1.0, 0.0, 1.0);
}
`

/**
 * Effort-bar flow shader. The bar is a straight rounded rectangle (the pill
 * host clips this canvas with its own border-radius), so the shader only
 * draws a horizontal light band inside the fill mask [0, u_head]:
 *
 *  1. value-noise fbm bands drift over time — the drift RATE is baked into
 *     u_time by the host (tier speed x eased scrub energy), so changing tier
 *     re-times the drift instead of teleporting the field;
 *  2. the band is lit by a head glow — the brightest point sits right at
 *     u_head and falls off leftward, which is why the bar reads as "light
 *     flowing from the head" instead of a flat gradient fill;
 *  3. a low-alpha white sheen sweeps from the handle toward the left edge;
 *     its phase (u_sheen, 0…1) wraps host-side so the sweep repeats forever.
 *
 * Color follows an aurora "curiosity → creation" ramp: u_from/u_to are the
 * current tier's endpoints, shifting from cool cyan (low effort — curiosity)
 * through indigo toward warm fuchsia-pink (high effort — creation), and the
 * head glow mixes toward a bright tint of the tier colour (bounded — never
 * additive white, which clipped to a flat white plateau and erased the tier
 * palette at the head).
 */
export const FLOW_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

uniform vec2  u_resolution;
uniform float u_time;   // flow phase (seconds-equivalent), host-wrapped
uniform float u_sheen;  // sheen phase in [0,1), one sweep per wrap
uniform float u_head;   // eased fill fraction 0…1
uniform vec3  u_from;
uniform vec3  u_to;

out vec4 fragColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  fp = fp * fp * (3.0 - 2.0 * fp);
  float a = hash12(ip);
  float b = hash12(ip + vec2(1.0, 0.0));
  float c = hash12(ip + vec2(0.0, 1.0));
  float d = hash12(ip + vec2(1.0, 1.0));
  return mix(mix(a, b, fp.x), mix(c, d, fp.x), fp.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  v += 0.5000 * vnoise(p);
  p = p * 2.02 + vec2(17.3, 9.2);
  v += 0.2500 * vnoise(p);
  p = p * 2.03 + vec2(4.7, 21.9);
  v += 0.1250 * vnoise(p);
  return v / 0.875;
}

void main() {
  // Aspect-corrected UV. The bar is ~15x wider than tall, so one unit of
  // uv.x spans far more pixels than one unit of uv.y: the WIDE axis is the
  // one that must be scaled up (uv.x * aspect) for the noise to be isotropic
  // in pixel space. Scaling uv.y instead over-corrects into ~60:1 vertical
  // striping — sub-pixel detail that reads as shimmering noise.
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 warpP = vec2(uv.x * aspect, uv.y);

  if (uv.x > u_head) {
    fragColor = vec4(0.0);
    return;
  }

  // Domain-warped fbm: the extra 4.0 * offset pass stretches the bands along
  // y (the bar's cross axis) so they read as light streaks, not cloud blobs.
  float q = fbm(warpP * 3.1 + vec2(0.0, u_time));
  float r = fbm(warpP * 3.1 + vec2(5.2, 1.3) + 4.0 * q);
  float band = fbm(warpP * 6.2 + vec2(u_time * 1.35, 0.0) + 4.0 * r);

  // Energy follows the band: brighter streaks inside the flow, softer gaps
  // between them, so the bar reads as "moving light" rather than a gradient.
  float energy = 0.35 + 0.65 * band;
  // Soft fade over the first ~12% of the bar so a thin sliver at low effort
  // reads as a glow beginning, not as a hard neon wall at x=0.
  float leftFade = smoothstep(0.0, 0.12, uv.x);

  // Base fill gradient (from → to) as a positional ramp across the fill:
  // every point reads its colour from where it sits, never from the head.
  float baseT = u_head > 1e-5 ? uv.x / u_head : 0.0;
  vec3 base = mix(u_from, u_to, clamp(baseT, 0.0, 1.0));

  // Head glow: peak at the head, falloff to the left. The distance is
  // clamped to 0 — a negative distance would make exp() explode and burn
  // the whole left half of the bar white.
  float headDist = max(u_head - uv.x, 0.0);
  float glow = exp(-headDist * 6.0);

  // Head bloom MIXES toward a bright tint of the tier colour instead of
  // ADDING white. The old additive form reached ~2.0 at the head, which the
  // 8-bit drawing buffer hard-clips to the same pure white on every tier.
  // A mix is bounded by construction, so the tier tint survives exactly
  // where the eye is looking.
  vec3 color = base + (u_to - u_from) * 0.35 * energy;
  vec3 bloomCol = mix(u_to, vec3(1.0), 0.5);
  color = mix(color, bloomCol, glow * 0.8);

  // Moving specular sheen: a narrow bright line that sweeps from the handle
  // toward the left edge, one sweep per u_sheen wrap. dx*dx avoids pow(x,2)
  // on negative x, which is undefined once the sweep drifts past the edge.
  float sheenX = u_head - u_sheen * u_head;
  float sheenDx = (uv.x - sheenX) * 18.0;
  float sheen = exp(-sheenDx * sheenDx);
  color += vec3(0.30) * sheen * (0.35 + 0.65 * energy);

  // Bounded light: only the sheen core may kiss 1.0; nothing plateaus there.
  color = min(color, vec3(1.0));

  // Premultiplied output: near the left edge the shader fades to transparent
  // so the CSS fallback's transparent→from gradient shows through, giving
  // the same soft fade-in the static fill always had.
  fragColor = vec4(color * leftFade, leftFade);
}
`

/**
 * The five effort tiers' fill colours (from/to) and their glow, matching the
 * `[data-level]` ramp in styles.css. Shader and CSS share this palette so a
 * tier change re-tints both the WebGL flow and the CSS handle halo in step.
 * `speed` is consumed by the host: it scales how fast the flow/sheen phases
 * advance, so a tier change re-times the drift without teleporting it.
 */
export const FLOW_TIERS: ReadonlyArray<{
  name: string
  from: string
  to: string
  glow: string
  speed: number
}> = [
  { name: 'l0', from: '#a5f3fc', to: '#67e8f9', glow: 'rgba(103,232,249,0.45)', speed: 0.5 },
  { name: 'l1', from: '#67e8f9', to: '#7dd3fc', glow: 'rgba(125,211,252,0.45)', speed: 0.7 },
  { name: 'l2', from: '#7dd3fc', to: '#818cf8', glow: 'rgba(129,140,248,0.5)', speed: 1.0 },
  { name: 'l3', from: '#a78bfa', to: '#e879f9', glow: 'rgba(232,121,249,0.55)', speed: 1.25 },
  { name: 'l4', from: '#e879f9', to: '#f9a8d4', glow: 'rgba(249,168,212,0.6)', speed: 1.5 }
]

/** Interpolates a tier index (0…4, fractional allowed) into the palette. */
export function flowTierColors(level: number): { from: string; to: string; speed: number } {
  // NaN-safe: level arrives as `Math.round((value / max) * 4)`, which is NaN
  // whenever max === 0 — clamp that to tier 0 instead of indexing [NaN].
  const t = Number.isFinite(level)
    ? Math.max(0, Math.min(FLOW_TIERS.length - 1, level))
    : 0
  const i = Math.floor(t)
  const f = t - i
  const a = FLOW_TIERS[i] ?? FLOW_TIERS[0]!
  const b = FLOW_TIERS[Math.min(i + 1, FLOW_TIERS.length - 1)]!
  return {
    from: mixHex(a.from, b.from, f),
    to: mixHex(a.to, b.to, f),
    speed: a.speed + (b.speed - a.speed) * f
  }
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t)
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t)
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t)
  return `#${[r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return [0, 0, 0]
  const v = m[1]!
  return [
    Number.parseInt(v.slice(0, 2), 16),
    Number.parseInt(v.slice(2, 4), 16),
    Number.parseInt(v.slice(4, 6), 16)
  ]
}
