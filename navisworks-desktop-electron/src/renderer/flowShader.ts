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
 * When the head moves backward (effort lowered), [0, u_head] shrinks and the
 * hard mask would evaporate the whole revealed region in one frame — a
 * visible gap. u_trail extends a fading band past the head instead: light
 * that the head just abandoned keeps drawing from the same fbm field and
 * alpha-fades over u_trail, so lowering the effort reads as the light
 * flowing back, not being chopped off. u_trail is host-driven (it stretches
 * with the retreat speed) and is 0 whenever the head is still or advancing.
 *
 * Color follows a cumulative aurora "curiosity → creation" ramp. u_palette
 * contains the full cyan-to-violet chain and u_level reveals one additional
 * stop per tier, so higher effort retains every earlier colour. u_from/u_to
 * remain the current tier's endpoints for the head glow and Max bubbles.
 */
export const FLOW_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

uniform vec2  u_resolution;
uniform float u_time;   // flow phase (seconds-equivalent), host-wrapped
uniform float u_sheen;  // sheen phase in [0,1), one sweep per wrap
uniform float u_bubble_time;  // independent bubble phase, host-wrapped
uniform float u_max_burst;    // transient 0…1 burst when entering Max
uniform float u_head;   // eased fill fraction 0…1
uniform float u_trail;  // backward-fade width past the head, 0…0.35
uniform float u_level;  // normalized effort tier 0…1; Max is exactly 1
uniform vec3  u_from;
uniform vec3  u_to;
uniform vec3  u_palette[6];

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

vec3 cumulativePalette(float t, float lastStop) {
  float p = clamp(t, 0.0, 1.0) * clamp(lastStop, 1.0, 5.0);
  if (p < 1.0) return mix(u_palette[0], u_palette[1], p);
  if (p < 2.0) return mix(u_palette[1], u_palette[2], p - 1.0);
  if (p < 3.0) return mix(u_palette[2], u_palette[3], p - 2.0);
  if (p < 4.0) return mix(u_palette[3], u_palette[4], p - 3.0);
  return mix(u_palette[4], u_palette[5], clamp(p - 4.0, 0.0, 1.0));
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

  // Mask: full light inside [0, u_head]; past the head, a fading trail of
  // width u_trail keeps the just-abandoned light flowing back instead of
  // evaporating in one frame. u_trail = 0 (forward / idle) must be an exact
  // hard cut: any epsilon-wide tail would let the light peek past the handle.
  float trailFade = 1.0 - smoothstep(0.0, u_trail, uv.x - u_head);
  float maskAlpha = uv.x <= u_head
    ? 1.0
    : (u_trail > 0.0 ? trailFade : 0.0);
  if (maskAlpha <= 0.0) {
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

  // Cumulative base gradient. Level 0 exposes palette stops 0→1; every
  // higher level adds one stop until Max shows the complete 0→5 chain.
  // Inside the backward trail (uv.x > u_head) the normalized position pins
  // to 1.0 so the fading band keeps the head colour instead of sampling
  // past the palette's last stop.
  float baseT = u_head > 1e-5 ? min(uv.x / u_head, 1.0) : 0.0;
  vec3 base = cumulativePalette(baseT, 1.0 + u_level * 4.0);

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
  vec3 color = base * (0.88 + 0.12 * energy);
  vec3 bloomCol = mix(u_to, vec3(1.0), 0.25);
  color = mix(color, bloomCol, glow * 0.58);
  // Max entry boosts the entire coloured fluid, not just the head highlight.
  color *= 1.0 + 0.22 * u_max_burst;

  // Max-tier bubbles: five rings remain during normal Max operation; seven
  // more join only for the entry burst. Their independent phase lets the host
  // accelerate them without teleporting the main flow field.
  float maxTier = smoothstep(0.90, 0.99, u_level);
  float bubbles = 0.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float bubblePhase = fract(
      u_bubble_time * (0.032 + fi * 0.004) + hash12(vec2(fi, 4.2))
    );
    float bubbleX = bubblePhase * (aspect + 0.8) - 0.4;
    float bubbleY = 0.18 + 0.64 * hash12(vec2(fi, 8.7));
    float bubbleRadius = 0.07 + 0.05 * hash12(vec2(fi, 12.4));
    float bubbleDist = length(warpP - vec2(bubbleX, bubbleY));
    float bubbleOuter = 1.0 - smoothstep(
      bubbleRadius,
      bubbleRadius + 0.025,
      bubbleDist
    );
    float bubbleInner = smoothstep(
      bubbleRadius * 0.52,
      bubbleRadius * 0.78,
      bubbleDist
    );
    float bubblePresence = i < 5 ? 1.0 : u_max_burst;
    bubbles += bubbleOuter * bubbleInner * bubblePresence;
  }
  vec3 bubbleCol = mix(u_from, vec3(1.0), 0.32);
  color = mix(
    color,
    bubbleCol,
    clamp(
      bubbles * maxTier * (0.46 + 0.12 * u_max_burst),
      0.0,
      0.62
    )
  );

  // Moving specular sheen: a narrow bright line that sweeps from the handle
  // toward the left edge, one sweep per u_sheen wrap. dx*dx avoids pow(x,2)
  // on negative x, which is undefined once the sweep drifts past the edge.
  float sheenX = u_head - u_sheen * u_head;
  float sheenDx = (uv.x - sheenX) * 18.0;
  float sheen = exp(-sheenDx * sheenDx);
  color += vec3(0.14) * sheen * (0.30 + 0.70 * energy);

  // Bounded light: only the sheen core may kiss 1.0; nothing plateaus there.
  color = min(color, vec3(1.0));

  // Premultiplied output: near the left edge the shader fades to transparent
  // so the CSS fallback's transparent→from gradient shows through, giving
  // the same soft fade-in the static fill always had. The mask alpha carries
  // the backward trail's fade on the way out.
  fragColor = vec4(color * leftFade * maskAlpha, leftFade * maskAlpha);
}
`

/**
 * The shared six-stop palette plus the five tiers' current endpoints/glow,
 * matching the cumulative `[data-level]` gradients in styles.css. A tier
 * change reveals one more stop while the handle and head adopt the new end.
 * `speed` is consumed by the host: it scales how fast the flow/sheen phases
 * advance, so a tier change re-times the drift without teleporting it.
 */
export const FLOW_STOPS = [
  '#a5f3fc',
  '#67e8f9',
  '#7dd3fc',
  '#818cf8',
  '#8b5cf6',
  '#6d28d9'
] as const

export const FLOW_TIERS: ReadonlyArray<{
  name: string
  from: string
  to: string
  glow: string
  speed: number
}> = [
  { name: 'l0', from: FLOW_STOPS[0], to: FLOW_STOPS[1], glow: 'rgba(103,232,249,0.45)', speed: 0.5 },
  { name: 'l1', from: FLOW_STOPS[1], to: FLOW_STOPS[2], glow: 'rgba(125,211,252,0.45)', speed: 0.7 },
  { name: 'l2', from: FLOW_STOPS[2], to: FLOW_STOPS[3], glow: 'rgba(129,140,248,0.5)', speed: 1.0 },
  { name: 'l3', from: FLOW_STOPS[3], to: FLOW_STOPS[4], glow: 'rgba(139,92,246,0.55)', speed: 1.25 },
  { name: 'l4', from: FLOW_STOPS[4], to: FLOW_STOPS[5], glow: 'rgba(109,40,217,0.6)', speed: 1.5 }
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

/** How fast the eased head chases its target while NOT dragging (1/s). */
const FLOW_HEAD_EASE_RATE = 14
/** Below this remaining gap the head snaps to the target and stops easing. */
const FLOW_HEAD_SNAP_EPSILON = 0.0005

/**
 * Advances the flow-light's head toward the slider's fill fraction.
 *
 * While the user is dragging (or motion is reduced), the head tracks the
 * target 1:1: the handle follows the pointer instantly, so an eased head
 * trails a fast drag and opens a visible gap between the handle and the
 * light's front. The exponential ease only shapes discrete jumps (keyboard
 * steps, programmatic changes) when the gesture is idle. Reduced motion also
 * snaps because the host freezes dt at 0 there — an eased head could never
 * move at all, and a static bar must still follow the value instantly.
 */
export function advanceFlowHead(
  current: number,
  target: number,
  dtSeconds: number,
  dragging: boolean,
  reducedMotion: boolean
): number {
  const t = Number.isFinite(target)
    ? Math.max(0, Math.min(1, target))
    : Math.max(0, Math.min(1, current))
  if (dragging || reducedMotion) return t
  const next = current + (t - current) * (1 - Math.exp(-dtSeconds * FLOW_HEAD_EASE_RATE))
  return Math.abs(t - next) < FLOW_HEAD_SNAP_EPSILON ? t : next
}

/** Widest the backward trail may grow, as a fraction of the bar. */
const FLOW_TRAIL_MAX = 0.35
/** How fast the trail fades once the head stops retreating (1/s). The
 *  afterglow must read as a quick flow-back (~150 ms), not linger past the
 *  handle — anything slower reads as the light lagging the slider. */
const FLOW_TRAIL_DECAY_RATE = 20
/** Fraction of one frame's retreat stretched into trail width (0…1 scale). */
const FLOW_TRAIL_GAIN = 0.9

/**
 * Advances the backward trail width that keeps lowered-effort light from
 * evaporating in one frame.
 *
 * The trail accumulates each frame's head retreat (scaled by FLOW_TRAIL_GAIN)
 * on top of the decaying remainder, so its width tracks the RECENT retreat —
 * a wake behind the handle, not the gesture's high-water mark. Forward motion
 * kills it outright: a lingering band would draw light past the handle and
 * the fill's leading edge would outrun the slider.
 */
export function advanceFlowTrail(
  currentTrail: number,
  previousHead: number,
  currentHead: number,
  dtSeconds: number
): number {
  const retreat = previousHead - currentHead
  if (retreat < 0) return 0
  let next = currentTrail * Math.exp(-dtSeconds * FLOW_TRAIL_DECAY_RATE)
  next = Math.min(next + retreat * FLOW_TRAIL_GAIN, FLOW_TRAIL_MAX)
  if (next < 1e-4) next = 0
  return next
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
