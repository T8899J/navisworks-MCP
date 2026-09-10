import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function SettingsDialog({ title, children, footer, onClose, busy = false, alert = false }: {
  title: string
  children: ReactNode
  footer: ReactNode
  onClose(): void
  busy?: boolean
  alert?: boolean
}) {
  const titleId = useId()
  const root = useRef<HTMLDivElement>(null)
  const latest = useRef({ onClose, busy })
  latest.current = { onClose, busy }
  useEffect(() => {
    const previous = document.activeElement
    const dialog = root.current
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])
    if (!dialog?.contains(document.activeElement)) (dialog?.querySelector<HTMLElement>('input') ?? controls()[0])?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !latest.current.busy) { event.preventDefault(); latest.current.onClose() }
      if (event.key !== 'Tab') return
      const items = controls()
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialog?.addEventListener('keydown', onKeyDown)
    return () => {
      dialog?.removeEventListener('keydown', onKeyDown)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div className="modal-card settings-dialog" ref={root} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-header"><span id={titleId}>{title}</span><button className="modal-close" type="button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={16} aria-hidden="true" /></button></div>
      <div className="modal-body">{children}</div>
      <div className="modal-footer">{footer}</div>
    </div>
  </div>
}
