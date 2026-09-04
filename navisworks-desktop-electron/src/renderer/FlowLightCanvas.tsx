import { useEffect, useRef } from 'react'
import {
  FLOW_FRAGMENT_SHADER,
  FLOW_STOPS,
  FLOW_VERTEX_SHADER,
  advanceFlowHead,
  advanceFlowTrail,
  flowTierColors
} from './flowShader'

interface FlowLightCanvasProps {
  /** Fill fraction 0…1; the head of the light sits at this x. */
  progress: number
  /** Effort tier 0…4, drives the palette + flow speed. */
  level: number
  /**
   * Extra flow energy while the user is dragging/scrubbing the bar. Eased
   * toward 0 (idle) or 1 (active) inside the render loop so the light
   * visibly pulses with the gesture and relaxes afterwards.
   */
  scrub?: number
  /** Called once, after the first frame has actually been drawn. */
  onReady?(): void
  /**
   * Called when the WebGL pipeline becomes unavailable (program failed to
   * link, or the context was lost). The host should fall back to the static
   * CSS fill while the canvas is out.
   */
  onLost?(): void
}

interface DrawState {
  gl: WebGL2RenderingContext
  program: WebGLProgram
  resolution: WebGLUniformLocation
  time: WebGLUniformLocation
  sheen: WebGLUniformLocation
  bubbleTime: WebGLUniformLocation
  maxBurst: WebGLUniformLocation
  head: WebGLUniformLocation
  trail: WebGLUniformLocation
  level: WebGLUniformLocation
  from: WebGLUniformLocation
  to: WebGLUniformLocation
  palette: WebGLUniformLocation
  buf: WebGLBuffer
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('createShader failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Shader compile failed: ${log}`)
  }
  return shader
}

function createState(gl: WebGL2RenderingContext): DrawState {
  const vs = compile(gl, gl.VERTEX_SHADER, FLOW_VERTEX_SHADER)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FLOW_FRAGMENT_SHADER)
  const program = gl.createProgram()
  if (!program) throw new Error('createProgram failed')
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`Program link failed: ${log}`)
  }
  const buf = gl.createBuffer()
  if (!buf) throw new Error('createBuffer failed')

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  return {
    gl,
    program,
    resolution: gl.getUniformLocation(program, 'u_resolution')!,
    time: gl.getUniformLocation(program, 'u_time')!,
    sheen: gl.getUniformLocation(program, 'u_sheen')!,
    bubbleTime: gl.getUniformLocation(program, 'u_bubble_time')!,
    maxBurst: gl.getUniformLocation(program, 'u_max_burst')!,
    head: gl.getUniformLocation(program, 'u_head')!,
    trail: gl.getUniformLocation(program, 'u_trail')!,
    level: gl.getUniformLocation(program, 'u_level')!,
    from: gl.getUniformLocation(program, 'u_from')!,
    to: gl.getUniformLocation(program, 'u_to')!,
    palette: gl.getUniformLocation(program, 'u_palette[0]')!,
    buf
  }
}

function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return [0, 0, 0]
  const v = m[1]!
  return [
    Number.parseInt(v.slice(0, 2), 16) / 255,
    Number.parseInt(v.slice(2, 4), 16) / 255,
    Number.parseInt(v.slice(4, 6), 16) / 255
  ]
}

function setVec3(gl: WebGL2RenderingContext, loc: WebGLUniformLocation | null, hex: string): void {
  if (!loc) return
  const [r, g, b] = hexToRgb01(hex)
  gl.uniform3f(loc, r, g, b)
}

const FLOW_PALETTE_RGB = new Float32Array(FLOW_STOPS.flatMap(hexToRgb01))

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
const MAX_BURST_DURATION_SECONDS = 3
const MAX_BURST_FADE_SECONDS = 0.3

/**
 * A zero-DOM WebGL2 canvas that draws the effort bar's flowing light: an
 * aspect-corrected, domain-warped fbm band whose head glow and specular
 * sheen both travel with the bar's fill fraction. The canvas is clipped by
 * CSS (`.flow-light-canvas` carries the same radius as the bar), so the
 * light never escapes the rounded rectangle — no ellipse anywhere.
 *
 * Time never runs on the wall clock: the host accumulates two phase values
 * (flow + sheen) from per-frame deltas, wraps them, and bakes the tier's
 * speed and the eased scrub energy into the advance rate. That keeps the
 * shader's coordinates small and every transition (tier change, press,
 * release, drag) continuous instead of teleporting the field.
 */
export function FlowLightCanvas({
  progress,
  level,
  scrub = 0,
  onReady,
  onLost
}: FlowLightCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Mirrors of the latest props, read inside the rAF loop without re-renders
  // (the loop runs at display refresh, the React tree updates far slower).
  const progressRef = useRef(progress)
  const levelRef = useRef(level)
  const scrubRef = useRef(scrub)
  // Reduced motion: freeze the phase advance so the shader renders one static
  // frame instead of drifting streaks (matches the css `prefers-reduced-motion`
  // kill-switch that already flattens the DOM particle burst).
  const reducedMotionRef = useRef(
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
  progressRef.current = progress
  levelRef.current = level
  scrubRef.current = scrub

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      // No WebGL2 at all: the CSS gradient fill is the whole effect. Hide the
      // canvas so an inert accelerated surface can never composite as white.
      console.warn('[flow] WebGL2 unavailable — effort bar falls back to the static gradient')
      canvas.style.display = 'none'
      onLost?.()
      return undefined
    }

    let state: DrawState
    try {
      state = createState(gl)
    } catch (error) {
      // A context that cannot compile the program just leaves the bar on its
      // static CSS gradient — the effect degrades, it never blocks the pill.
      // Hide the canvas: a never-drawn (or GPU-dead) accelerated canvas
      // composites as an opaque white block over the panel otherwise.
      // Say why out loud: a silent bail-out here cost a whole debug cycle.
      console.warn('[flow] shader setup failed — falling back to the static gradient:', error)
      canvas.style.display = 'none'
      onLost?.()
      return undefined
    }

    let width = 0
    let height = 0
    let raf = 0
    let running = false
    let visible = false
    let lastMs = 0
    // Host-side phase accumulators (f64, so no precision drift in JS itself).
    let flowPhase = 0
    let sheenPhase = 0
    let bubblePhase = 0
    let maxBurst = 0
    let maxBurstElapsed = MAX_BURST_DURATION_SECONDS
    let headSmooth = clamp01(progressRef.current)
    let trailSmooth = 0
    let scrubSmooth = clamp01(scrubRef.current)
    // Tier palette is cached per level — flowTierColors parses hex strings,
    // which would otherwise allocate on every frame for identical input.
    let cachedLevel = NaN
    let cachedColors = flowTierColors(0)
    let firstFrameDrawn = false

    const applySize = (cssWidth: number, cssHeight: number) => {
      if (cssWidth <= 0 || cssHeight <= 0) return false
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(cssWidth * dpr))
      const h = Math.max(1, Math.round(cssHeight * dpr))
      if (w !== width || h !== height) {
        width = w
        height = h
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
      return true
    }

    const draw = (nowMs: number) => {
      raf = window.requestAnimationFrame(draw)
      if (width === 0 || height === 0) return

      // Clamp dt so a background tab (rAF paused) or a hitch never flings
      // the phases forward — motion resumes where it left off.
      const dt = reducedMotionRef.current
        ? 0
        : Math.min(lastMs === 0 ? 1 / 60 : (nowMs - lastMs) / 1000, 1 / 30)
      lastMs = nowMs

      // Eased head: the light's front travels toward the target value on
      // discrete jumps, but tracks the handle 1:1 while dragging — an eased
      // head trails a fast drag and opens a visible gap at the slider.
      const targetHead = clamp01(progressRef.current)
      const previousHead = headSmooth
      headSmooth = advanceFlowHead(
        headSmooth,
        targetHead,
        dt,
        scrubRef.current > 0,
        reducedMotionRef.current
      )
      // Lowering the effort shrinks [0, head]; without a fade the abandoned
      // region evaporates in one frame (visible gap while dragging back).
      // The trail stretches with the retreat and relaxes when it stops.
      trailSmooth = advanceFlowTrail(trailSmooth, previousHead, headSmooth, dt)

      // Eased scrub energy: press/release ramp instead of a 0→1 step.
      const targetScrub = clamp01(scrubRef.current)
      scrubSmooth += (targetScrub - scrubSmooth) * (1 - Math.exp(-dt * 9))
      if (targetScrub === 0 && scrubSmooth < 0.001) scrubSmooth = 0

      // NaN-safe: level is NaN when the caller's max is 0.
      const level01 = Number.isFinite(levelRef.current)
        ? Math.max(0, Math.min(4, levelRef.current))
        : 0
      if (level01 !== cachedLevel) {
        const previousLevel = cachedLevel
        cachedLevel = level01
        cachedColors = flowTierColors(level01)
        // Only an actual tier transition into Max gets the burst. Mounting an
        // already-Max slider must not replay it whenever the menu is opened.
        if (
          Number.isFinite(previousLevel) &&
          previousLevel < 4 &&
          level01 === 4 &&
          !reducedMotionRef.current
        ) {
          maxBurst = 1
          maxBurstElapsed = 0
        } else if (level01 < 4) {
          maxBurst = 0
          maxBurstElapsed = MAX_BURST_DURATION_SECONDS
        }
      }

      if (maxBurst > 0) {
        maxBurstElapsed = Math.min(MAX_BURST_DURATION_SECONDS, maxBurstElapsed + dt)
        maxBurst = clamp01(
          (MAX_BURST_DURATION_SECONDS - maxBurstElapsed) / MAX_BURST_FADE_SECONDS
        )
      }

      // Tier speed x eased scrub, baked into the phase advance. The shader
      // never multiplies time by speed, so a tier change re-times the drift
      // without the field jumping.
      const speed = cachedColors.speed * (1 + scrubSmooth * 1.6)
      flowPhase = (flowPhase + dt * speed * (1 + maxBurst * 2.4)) % 4096
      sheenPhase = (sheenPhase + dt * speed * 0.18) % 1
      bubblePhase = (bubblePhase + dt * speed * (1 + maxBurst * 17)) % 4096

      gl.useProgram(state.program)
      gl.uniform2f(state.resolution, width, height)
      gl.uniform1f(state.time, flowPhase)
      gl.uniform1f(state.sheen, sheenPhase)
      gl.uniform1f(state.bubbleTime, bubblePhase)
      gl.uniform1f(state.maxBurst, maxBurst)
      gl.uniform1f(state.head, headSmooth)
      gl.uniform1f(state.trail, trailSmooth)
      gl.uniform1f(state.level, level01 / 4)
      setVec3(gl, state.from, cachedColors.from)
      setVec3(gl, state.to, cachedColors.to)
      gl.uniform3fv(state.palette, FLOW_PALETTE_RGB)
      gl.bindBuffer(gl.ARRAY_BUFFER, state.buf)
      // WebGL2 has a default VAO and the vertex shader derives its position
      // from gl_VertexID, so no attributes are enabled anywhere.
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      if (!firstFrameDrawn) {
        firstFrameDrawn = true
        // Real pixels exist — reveal the canvas (CSS keeps it at opacity 0
        // until now, so a GPU-dead white placeholder can never flash).
        canvas.style.opacity = '1'
        // Unmounting the CSS fallback before this point leaves the bar empty
        // for a frame (visible as a flash every time the canvas mounts).
        onReady?.()
      }
    }

    const start = () => {
      if (running || !visible) return
      running = true
      lastMs = 0
      raf = window.requestAnimationFrame(draw)
    }

    const stop = () => {
      if (!running) return
      running = false
      window.cancelAnimationFrame(raf)
    }

    // Size + visibility via ResizeObserver — no per-frame
    // getBoundingClientRect (3,600 forced layout reads/min in the old loop).
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      visible = !!rect && rect.width > 0 && rect.height > 0
      if (visible && rect) {
        applySize(rect.width, rect.height)
        start()
      } else {
        stop()
      }
    })
    ro.observe(canvas)

    const onContextLost = (event: Event) => {
      event.preventDefault()
      stop()
      // Drop the canvas from view: after a GPU process crash Chromium paints
      // lost accelerated content as an opaque white block. The CSS gradient
      // fill takes over until the context (and a first frame) comes back.
      canvas.style.opacity = '0'
      onLost?.()
    }
    const onContextRestored = () => {
      try {
        state = createState(gl)
      } catch {
        canvas.style.display = 'none'
        return
      }
      width = 0
      height = 0
      firstFrameDrawn = false // re-run the opacity reveal after the redraw
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        applySize(rect.width, rect.height)
        start()
      }
    }
    canvas.addEventListener('webglcontextlost', onContextLost)
    canvas.addEventListener('webglcontextrestored', onContextRestored)

    return () => {
      stop()
      ro.disconnect()
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      gl.deleteBuffer(state.buf)
      gl.deleteProgram(state.program)
      // Free the context slot only once the canvas has really left the
      // document: Chromium caps live WebGL contexts (~16) and the effort
      // picker mounts/unmounts this canvas on every open/close.
      //
      // The check has to be deferred by a frame: StrictMode (dev) runs
      // mount → cleanup → mount with the SAME canvas element, and losing the
      // context in between makes the second getContext('webgl2') return null
      // forever — the bar then has no flow light at all.
      requestAnimationFrame(() => {
        if (!canvas.isConnected) {
          gl.getExtension('WEBGL_lose_context')?.loseContext()
        }
      })
    }
    // onReady/onLost are stable useCallbacks in EffortSlider and only flip a
    // boolean there — safe to capture once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <canvas ref={canvasRef} className="flow-light-canvas" aria-hidden="true" />
}
