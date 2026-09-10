import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
/**
 * Dropdown model picker styled like the composer's model menu. The trigger
 * shows the current value; 获取模型 feeds the option list, picking one fills
 * the row's read-only display.
 */
export function ModelPicker({
  value,
  options,
  placeholder,
  emptyHint,
  disabled,
  onPick
}: {
  value: string
  options: readonly string[]
  placeholder: string
  emptyHint: string
  disabled?: boolean
  onPick(model: string): void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}>
        <span className="model-picker-value">{value.trim() || placeholder}</span>
        <ChevronDown aria-hidden="true" size={13} className={open ? 'flipped' : undefined} />
      </button>
      {open ? (
        <div className="model-picker-list" role="listbox">
          {options.length === 0 ? (
            <div className="model-picker-empty">{emptyHint}</div>
          ) : (
            options.map((model) => (
              <button
                key={model}
                type="button"
                role="option"
                aria-selected={model === value}
                className={`model-picker-option${model === value ? ' selected' : ''}`}
                onClick={() => {
                  setOpen(false)
                  if (model !== value) onPick(model)
                }}>
                <span className="model-picker-option-name">{model}</span>
                {model === value ? <Check aria-hidden="true" size={13} /> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
