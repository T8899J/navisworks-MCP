/**
 * Global tooltip controller. One body-level fixed node serves EVERY element
 * that carries `data-tip` (set by the React side instead of the native `title`,
 * which the OS renders as an unstyleable square bubble). Because the node is
 * `position: fixed` and appended to <body>, it is not clipped by ancestor
 * `overflow:hidden` (sidebar, .model-display, …) — the whole point of replacing
 * the old CSS `::after` approach.
 *
 * Install once (App mount). Elements opt in with:
 *   data-tip="文本"            hover/focus shows the tooltip
 *   data-tip-below="true"      force it under the control (top-edge controls)
 */

const GAP = 8
const VIEWPORT_MARGIN = 8

let node: HTMLDivElement | null = null
let current: HTMLElement | null = null
let installed = false

function ensureNode(): HTMLDivElement {
  if (node !== null && document.body.contains(node)) return node
  node = document.createElement('div')
  node.className = 'app-tooltip'
  node.setAttribute('role', 'tooltip')
  node.setAttribute('aria-hidden', 'true')
  node.dataset['visible'] = 'false'
  document.body.appendChild(node)
  return node
}

function tipTarget(element: EventTarget | null): HTMLElement | null {
  if (!(element instanceof Element)) return null
  const host = element.closest<HTMLElement>('[data-tip], button[aria-label], svg[aria-label]')
  if (host === null) return null
  // Text already labels a control. Only standalone icons need hover help.
  if (host.textContent?.trim() || !(host.matches('svg') || host.querySelector('svg'))) return null
  // Treat an empty/whitespace label as "no tooltip" so a bound-but-blank
  // data-tip (e.g. a not-yet-loaded name) shows nothing instead of a dot.
  const text = (host.getAttribute('data-tip') ?? host.getAttribute('aria-label'))?.trim()
  return text ? host : null
}

function hide(): void {
  current = null
  if (node !== null) node.dataset['visible'] = 'false'
}

function showFor(target: HTMLElement): void {
  const tip = ensureNode()
  const text = (target.getAttribute('data-tip') ?? target.getAttribute('aria-label'))?.trim() ?? ''
  if (!text) {
    hide()
    return
  }
  tip.textContent = text
  current = target

  // Measure with the node laid out (it's visibility:hidden, not display:none,
  // so width/height are real), then place relative to the control's rect.
  const rect = target.getBoundingClientRect()
  const bubbleW = tip.offsetWidth
  const bubbleH = tip.offsetHeight
  const wantBelow = target.getAttribute('data-tip-below') === 'true'
  const roomAbove = rect.top - GAP - bubbleH >= VIEWPORT_MARGIN
  const placement = wantBelow ? 'bottom' : roomAbove ? 'top' : 'bottom'
  tip.dataset['placement'] = placement

  let left = rect.left + rect.width / 2 - bubbleW / 2
  left = Math.min(Math.max(VIEWPORT_MARGIN, left), window.innerWidth - bubbleW - VIEWPORT_MARGIN)
  const top = placement === 'top'
    ? rect.top - GAP - bubbleH
    : rect.bottom + GAP
  tip.style.left = `${Math.round(left)}px`
  tip.style.top = `${Math.round(top)}px`
  tip.dataset['visible'] = 'true'
}

const onPointerOver = (event: PointerEvent): void => {
  if (event.pointerType === 'touch') return
  const target = tipTarget(event.target)
  if (target === null) { hide(); return }
  if (target === current) return
  showFor(target)
}

const onPointerOut = (event: PointerEvent): void => {
  const target = tipTarget(event.target)
  if (target === null) return
  // Moving within the same host (e.g. onto its icon child) keeps the tooltip.
  if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return
  if (current === target) hide()
}

const onFocusIn = (event: FocusEvent): void => {
  const target = tipTarget(event.target)
  if (target !== null) showFor(target)
}

const onFocusOut = (event: FocusEvent): void => {
  if (event.relatedTarget instanceof Node && current?.contains(event.relatedTarget)) return
  hide()
}

// A scroll/resize would leave the fixed bubble stranded away from its (now
// moved) control — hide until the next hover.
const dismiss = (): void => { hide() }

export function installAppTooltip(): () => void {
  if (installed) return () => undefined
  installed = true
  ensureNode()
  document.addEventListener('pointerover', onPointerOver)
  document.addEventListener('pointerout', onPointerOut)
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
  document.addEventListener('pointerdown', dismiss)
  window.addEventListener('scroll', dismiss, true)
  window.addEventListener('resize', dismiss)
  return () => {
    installed = false
    document.removeEventListener('pointerover', onPointerOver)
    document.removeEventListener('pointerout', onPointerOut)
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('focusout', onFocusOut)
    document.removeEventListener('pointerdown', dismiss)
    window.removeEventListener('scroll', dismiss, true)
    window.removeEventListener('resize', dismiss)
    node?.remove()
    node = null
    current = null
  }
}
