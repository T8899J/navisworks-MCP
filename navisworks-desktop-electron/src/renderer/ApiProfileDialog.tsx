import { useState } from 'react'
import { SettingsDialog } from './SettingsDialog'

export type ApiProfileAction = 'delete' | 'replace-key' | 'clear-key'

export function ApiProfileDialog({ action, name, error, onCancel, onConfirm }: {
  action: ApiProfileAction
  name: string
  error: string
  onCancel(): void
  onConfirm(apiKey: string): Promise<boolean>
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const replacing = action === 'replace-key'
  const label = action === 'delete' ? '删除 API' : replacing ? '更换 API 密钥' : '清除 API 密钥'
  return <SettingsDialog title={label} alert={!replacing} busy={busy} onClose={onCancel} footer={<>
    <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>取消</button>
    <button className={replacing ? 'primary-button' : 'danger-button'} type="button" disabled={busy || (replacing && !key.trim())} onClick={async () => {
      setBusy(true)
      try { if (await onConfirm(key.trim())) onCancel() } finally { setBusy(false) }
    }}>{busy ? '处理中…' : replacing ? '保存密钥' : '确认' + (action === 'delete' ? '删除' : '清除')}</button>
  </>}>
    <p className="dialog-description">{action === 'delete' ? <>确定删除 API「<strong>{name}</strong>」及其连接配置？</> : replacing ? <>为「<strong>{name}</strong>」设置新的 API 密钥。</> : <>确定清除「<strong>{name}</strong>」已保存的 API 密钥？</>}</p>
    {replacing ? <label className="model-config-field"><span className="model-config-label">新 API 密钥</span><input type="password" value={key} onChange={(event) => setKey(event.currentTarget.value)} autoComplete="new-password" spellCheck={false} disabled={busy} placeholder="输入新密钥" /></label> : null}
    {error ? <p className="model-config-error" role="alert">{error}</p> : null}
  </SettingsDialog>
}
