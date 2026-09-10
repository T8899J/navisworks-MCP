import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiProfileDialog, type ApiProfileAction } from '../ApiProfileDialog'

describe('API profile confirmations', () => {
  const render = (action: ApiProfileAction) => renderToStaticMarkup(<ApiProfileDialog action={action} name="工作 API" error="" onCancel={() => undefined} onConfirm={async () => true} />)
  it('identifies the API in destructive confirmation dialogs', () => {
    for (const action of ['delete', 'clear-key'] as const) {
      const html = render(action)
      expect(html).toContain('role="alertdialog"')
      expect(html).toContain('工作 API')
      expect(html).toContain('取消')
      expect(html).toContain(action === 'delete' ? '确认删除' : '确认清除')
    }
  })
  it('requires a new masked key before saving', () => {
    const html = render('replace-key')
    expect(html).toContain('type="password"')
    expect(html).toContain('value=""')
    expect(html).toMatch(/disabled="">保存密钥/)
  })
})
