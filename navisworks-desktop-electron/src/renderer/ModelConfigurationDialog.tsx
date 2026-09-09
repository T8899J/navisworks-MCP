import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { ModelConfiguration, ModelInputModality, ModelOutputModality, ModelRef } from './chatTypes'

/**
 * Model Configuration v2 (§26): the per-model edit dialog, opened from the
 * model row in 设置 → 模型. Mirrors the reference layout — 模型 ID, 上下文窗口,
 * 最大输出 Token, 输入/输出类型 — in a Modal rather than sprawling fields on the
 * main page (§43). Empty numeric fields mean Auto (no override, §28).
 *
 * IMPORTANT (§25 / Invariant L): the modality checkboxes are model CAPABILITY
 * METADATA. Curi's message channel is text-only this round — checking 图片 here
 * records that the model can accept images, it does NOT wire an image-upload
 * transport and the UI must not pretend otherwise. The hint says so explicitly.
 */
export interface ModelConfigurationDraft {
  /** The ref being edited (its providerId never changes; modelId may, §27). */
  baseRef: ModelRef
  configuration: ModelConfiguration
  /** True when the user retyped a different model id (API only) — the parent
   *  must re-key the stored config + the profile.model and drop the old ref. */
  renamedTo?: string
  /** True → the user cleared this model's overrides entirely. */
  cleared?: boolean
}

const CONTEXT_MIN = 1024
const CONTEXT_MAX = 2_000_000
const OUTPUT_MIN = 128
const OUTPUT_MAX = 1_000_000

const INPUT_OPTIONS: Array<{ value: ModelInputModality; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'pdf', label: 'PDF' },
]
const OUTPUT_OPTIONS: Array<{ value: ModelOutputModality; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
]

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return null
  return Math.trunc(n)
}

interface ModelConfigurationDialogProps {
  open: boolean
  /** Provider identity (never edited): 'ollama' or 'api:<profileId>'. */
  providerId: string
  /** The model id currently in effect. */
  modelId: string
  /** API model ids are editable; Ollama ids come from the daemon's list. */
  modelIdEditable: boolean
  /** The existing stored configuration for this model, if any. */
  existing?: ModelConfiguration
  onCancel(): void
  onSubmit(draft: ModelConfigurationDraft): void
}

export function ModelConfigurationDialog({
  open,
  providerId,
  modelId,
  modelIdEditable,
  existing,
  onCancel,
  onSubmit,
}: ModelConfigurationDialogProps) {
  const [modelText, setModelText] = useState(modelId)
  const [contextText, setContextText] = useState(
    existing?.contextWindowTokens != null ? String(existing.contextWindowTokens) : '',
  )
  const [outputText, setOutputText] = useState(
    existing?.maxOutputTokens != null ? String(existing.maxOutputTokens) : '',
  )
  const [inputs, setInputs] = useState<Set<ModelInputModality>>(
    new Set(existing?.inputModalities ?? ['text']),
  )
  const [outputs, setOutputs] = useState<Set<ModelOutputModality>>(
    new Set(existing?.outputModalities ?? ['text']),
  )

  // Re-seed whenever the dialog opens for a (possibly different) model.
  useEffect(() => {
    if (!open) return
    setModelText(modelId)
    setContextText(existing?.contextWindowTokens != null ? String(existing.contextWindowTokens) : '')
    setOutputText(existing?.maxOutputTokens != null ? String(existing.maxOutputTokens) : '')
    setInputs(new Set(existing?.inputModalities ?? ['text']))
    setOutputs(new Set(existing?.outputModalities ?? ['text']))
  }, [open, modelId, existing])

  if (!open) return null

  const contextValue = parseNumber(contextText)
  const outputValue = parseNumber(outputText)
  // Field-level validity: a non-empty number must sit inside the schema bounds
  // (§28); an empty field is Auto (valid).
  const contextInvalid = contextValue !== null && (contextValue < CONTEXT_MIN || contextValue > CONTEXT_MAX)
  const outputInvalid = outputValue !== null && (outputValue < OUTPUT_MIN || outputValue > OUTPUT_MAX)
  const trimmedModel = modelText.trim()
  const modelInvalid = trimmedModel === ''
  const canSave = !contextInvalid && !outputInvalid && !modelInvalid

  const toggle = <T extends string>(set: Set<T>, value: T, update: (next: Set<T>) => void) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    update(next)
  }

  const save = () => {
    if (!canSave) return
    const targetModelId = trimmedModel
    const renamed = modelIdEditable && targetModelId !== modelId
    onSubmit({
      baseRef: { providerId, modelId },
      configuration: {
        ref: { providerId, modelId: targetModelId },
        ...(contextValue === null ? {} : { contextWindowTokens: contextValue }),
        ...(outputValue === null ? {} : { maxOutputTokens: outputValue }),
        inputModalities: INPUT_OPTIONS.filter((o) => inputs.has(o.value)).map((o) => o.value),
        outputModalities: OUTPUT_OPTIONS.filter((o) => outputs.has(o.value)).map((o) => o.value),
      },
      ...(renamed ? { renamedTo: targetModelId } : {}),
    })
  }

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="编辑模型配置">
        <div className="modal-header">
          <span>编辑模型配置</span>
          <button className="modal-close" type="button" aria-label="关闭" onClick={onCancel}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">
          <label className="model-config-field" htmlFor="mc-model-id">
            <span className="model-config-label">模型 ID</span>
            <input
              id="mc-model-id"
              type="text"
              value={modelText}
              disabled={!modelIdEditable}
              onChange={(event) => setModelText(event.currentTarget.value)}
              placeholder={modelIdEditable ? '如 qwen3.8-max' : modelId}
            />
            {!modelIdEditable && (
              <small className="provider-field-hint">本地 Ollama 模型 ID 来自模型列表，只读。</small>
            )}
            {modelInvalid && <small className="model-config-error">模型 ID 不能为空。</small>}
          </label>

          <label className="model-config-field" htmlFor="mc-context">
            <span className="model-config-label">上下文窗口（tokens）</span>
            <input
              id="mc-context"
              type="number"
              inputMode="numeric"
              min={CONTEXT_MIN}
              max={CONTEXT_MAX}
              value={contextText}
              placeholder="留空 = Auto"
              onChange={(event) => setContextText(event.currentTarget.value)}
            />
            {contextInvalid && <small className="model-config-error">需在 {CONTEXT_MIN}–{CONTEXT_MAX} 之间，或留空用 Auto。</small>}
          </label>

          <label className="model-config-field" htmlFor="mc-output">
            <span className="model-config-label">最大输出 Token</span>
            <input
              id="mc-output"
              type="number"
              inputMode="numeric"
              min={OUTPUT_MIN}
              max={OUTPUT_MAX}
              value={outputText}
              placeholder="留空 = Auto"
              onChange={(event) => setOutputText(event.currentTarget.value)}
            />
            {outputInvalid && <small className="model-config-error">需在 {OUTPUT_MIN}–{OUTPUT_MAX} 之间，或留空用 Auto。</small>}
          </label>

          <fieldset className="model-config-field">
            <legend className="model-config-label">输入类型</legend>
            <div className="model-config-modality">
              {INPUT_OPTIONS.map((option) => (
                <label key={option.value} className="model-config-check">
                  <input
                    type="checkbox"
                    checked={inputs.has(option.value)}
                    onChange={() => toggle(inputs, option.value, setInputs)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="model-config-field">
            <legend className="model-config-label">输出类型</legend>
            <div className="model-config-modality">
              {OUTPUT_OPTIONS.map((option) => (
                <label key={option.value} className="model-config-check">
                  <input
                    type="checkbox"
                    checked={outputs.has(option.value)}
                    onChange={() => toggle(outputs, option.value, setOutputs)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          <p className="provider-field-hint model-config-note">
            输入/输出类型用于描述模型能力；当前 Curi 已接入的消息通道仍以文本为准。
          </p>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
          <button className="primary-button" type="button" disabled={!canSave} onClick={save}>保存</button>
        </div>
      </div>
    </div>
  )
}
