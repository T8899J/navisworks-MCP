import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
  useState
} from 'react'
import { FlowLightCanvas } from './FlowLightCanvas'

interface EffortSliderProps {
  /** Current slider index (0…max). */
  value: number
  /** Largest legal index; minimum count is 2 (Low/Max for the local daemon). */
  max: number
  /** Called whenever the index changes via drag, click, or keyboard. */
  onChange(value: number): void
  /** Accessible name for the slider; rendered as `aria-label`. */
  ariaLabel?: string
}

interface Particle {
  id: number
  x: number
  y: number
  tx: number
  ty: number
  dur: number
  size: number
  color: string
  opacity: number
}

  // Monotonic id is fine because particles are filtered out on `onAnimationEnd`.
  let particleId = 0

/**
 * Particle palette follows the same aurora cyan→fuchsia ramp as the fill so
 * the bursts blend with it instead of looking like white sparks on top of it.
 */
const PARTICLE_COLORS = ['#67e8f9', '#7dd3fc', '#a5b4fc', '#e879f9', '#fdf4ff']

/** Cap on simultaneously-live particles; dragging always feels alive without
 *  risking layout thrash on rapid gestures. */
const MAX_PARTICLES = 140

/** One burst per animation frame, max — pointermove fires far faster than
 *  the display refreshes on high-polling mice. */
const SPAWN_INTERVAL_MS = 16

function intensityLevel(value: number, max: number): number {
  if (max <= 0) return 0
  return Math.max(0, Math.min(1, value / max))
}

/**
 * A rectangular aurora-lit bar that hosts the underlying value track, a
 * square handle, and a soft matching particle burst at the handle while
 * dragging. No on-bar tick markers — the user reads effort from the fill
 * width plus the handle position.
 *
 * The bar itself owns the drag gesture so any press anywhere on it updates
 * the value; the model/mode label lives in a separate row above this slider
 * rather than floating above the track.
 */
export function EffortSlider({
  value,
  max,
  onChange,
  ariaLabel
}: EffortSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  // Captured pointer id gates moves/up; null means we're not dragging.
  const activePointer = useRef<number | null>(null)
  // Timestamp of the last particle burst (one per frame, see SPAWN_INTERVAL_MS).
  const lastSpawn = useRef(-Infinity)
  const reducedMotion = useRef(
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
  const [particles, setParticles] = useState<Particle[]>([])
  /** Shader flow-energy bump: 1 while dragging, ramps back to 0 on release. */
  const [scrubEnergy, setScrubEnergy] = useState(0)
  /** WebGL2 linked: the canvas is drawing, so the CSS fill becomes fallback. */
  const [flowReady, setFlowReady] = useState(false)
  const flowReadyRef = useRef(false)

  const markFlowReady = useCallback(() => {
    if (!flowReadyRef.current) {
      flowReadyRef.current = true
      setFlowReady(true)
    }
  }, [])

  const markFlowLost = useCallback(() => {
    // GPU/context gone: remount the CSS gradient fill while the canvas is out.
    if (flowReadyRef.current) {
      flowReadyRef.current = false
      setFlowReady(false)
    }
  }, [])

  const boundedValue = Math.max(0, Math.min(max, value))
  const pct = max <= 0
    ? 0
    : Math.max(0, Math.min(100, (boundedValue / max) * 100))
  // Moving the thumb left by the same percentage of its own width makes its
  // left edge travel exactly through trackWidth - thumbWidth: 0 stays flush
  // left and 100 stays flush right without measuring the rendered track.
  const thumbTransform = `translate(${-pct}%, -50%)`

  const spawn = useCallback((x: number, y: number, level: number, now: number) => {
    // Reduced motion: the CSS kill-switch flattens the burst to an instant
    // flash — skip the React churn entirely instead.
    if (reducedMotion.current) return
    // Frame-gated: pointermove can fire 100+ times per second on high-polling
    // mice; without this gate a fast drag saturates MAX_PARTICLES and
    // re-renders the whole burst layer on every event.
    if (now - lastSpawn.current < SPAWN_INTERVAL_MS) return
    lastSpawn.current = now
    // Non-linear burst size: 1, 2, 4, 9, 17 across the five tiers.
    const count = Math.max(1, Math.round(1 + Math.pow(level, 1.4) * level * 4))
    const isHigh = level >= 0.6
    const colorIndex = Math.min(
      PARTICLE_COLORS.length - 1,
      Math.max(0, Math.floor(level * PARTICLE_COLORS.length))
    )
    const baseColor: string = PARTICLE_COLORS[colorIndex] ?? '#7dd3fc'
    const fresh: Particle[] = []
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2
      // Distance from the handle: bigger when level is higher.
      const dist = 12 + Math.random() * (14 + level * 30)
      const tx = Math.cos(angle) * dist
      // Slight upward bias so the burst looks like a soft puff, not a sphere.
      const ty = Math.sin(angle) * dist - (isHigh ? 6 : 2)
      const dur = 420 + Math.random() * (480 + level * 220)
      const size = 2 + Math.random() * (1 + level * 1.6)
      const opacity = 0.28 + level * 0.32
      fresh.push({
        id: ++particleId,
        x,
        y,
        tx,
        ty,
        dur,
        size,
        color: baseColor,
        opacity
      })
    }
    setParticles((prev) => {
      const merged = [...prev, ...fresh]
      // Drop the oldest if we're past the cap so a long drag never piles up.
      if (merged.length > MAX_PARTICLES) merged.splice(0, merged.length - MAX_PARTICLES)
      return merged
    })
  }, [])

  const setIndexFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
    const next = Math.round((x / rect.width) * max)
    if (next !== boundedValue) onChange(next)
  }, [boundedValue, max, onChange])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (max <= 0 || event.button !== 0) return
    const el = trackRef.current
    if (!el) return
    el.setPointerCapture(event.pointerId)
    activePointer.current = event.pointerId
    setScrubEnergy(1)
    setIndexFromClientX(event.clientX)
    const rect = el.getBoundingClientRect()
    const localX = event.clientX - rect.left
    const localY = rect.height / 2
    const snapped = Math.max(0, Math.min(rect.width, localX))
    const level = intensityLevel(Math.round((snapped / rect.width) * max), max)
    spawn(snapped, localY, level, event.timeStamp)
  }, [max, setIndexFromClientX, spawn])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const localX = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
    setIndexFromClientX(event.clientX)
    const level = intensityLevel(Math.round((localX / rect.width) * max), max)
    spawn(localX, rect.height / 2, level, event.timeStamp)
  }, [max, setIndexFromClientX, spawn])

  const releasePointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return
    activePointer.current = null
    setScrubEnergy(0)
    trackRef.current?.releasePointerCapture(event.pointerId)
  }, [])

  const removeParticle = useCallback((id: number) => {
    setParticles((prev) => prev.filter((p) => p.id !== id))
  }, [])

  // Keyboard parity with the native range input it replaces.
  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'
        && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    let next = boundedValue
    if (event.key === 'ArrowLeft') next = Math.max(0, boundedValue - 1)
    else if (event.key === 'ArrowRight') next = Math.min(max, boundedValue + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = max
    if (next !== boundedValue) onChange(next)
  }, [boundedValue, max, onChange])

  return (
    <div
      ref={trackRef}
      className="composer-pill"
      /* Bucketed 0…4 so CSS can pick a per-tier aurora colour for the fill;
         the bar itself carries no background of its own. */
      data-level={max > 0 ? Math.round((boundedValue / max) * 4) : 0}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={boundedValue}
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={releasePointer}
      onPointerCancel={releasePointer}
      onKeyDown={handleKeyDown}
    >
      <FlowLightCanvas
        progress={pct / 100}
        /* Guarded like data-level below: level is NaN when max is 0, which
           used to crash flowTierColors inside the render loop every frame. */
        level={max > 0 ? Math.round((boundedValue / max) * 4) : 0}
        scrub={scrubEnergy}
        onReady={markFlowReady}
        onLost={markFlowLost}
      />
      {/* No-WebGL fallback: the same tier gradient as a plain CSS layer.
          Unmounted once the WebGL2 program links (`onReady`); until then it
          keeps the bar readable and stands in for the shader below. */}
      {!flowReady && (
        <div className="composer-pill-fill" aria-hidden="true" style={{ width: `${pct}%` }} />
      )}
      <div
        className="composer-pill-handle"
        aria-hidden="true"
        style={{ left: `${pct}%`, transform: thumbTransform }}
      />
      <div className="composer-pill-particles" aria-hidden="true">
        {particles.map((p) => (
          <span
            key={p.id}
            className="effort-particle"
            style={
              {
                left: `${p.x}px`,
                top: `${p.y}px`,
                width: `${p.size}px`,
                height: `${p.size}px`,
                background: p.color,
                opacity: p.opacity,
                '--tx': `${p.tx}px`,
                '--ty': `${p.ty}px`,
                '--dur': `${p.dur}ms`
              } as CSSProperties
            }
            onAnimationEnd={() => removeParticle(p.id)}
          />
        ))}
      </div>
    </div>
  )
}
