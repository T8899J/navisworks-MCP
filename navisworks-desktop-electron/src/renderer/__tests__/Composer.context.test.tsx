import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, vi } from 'vitest'
vi.mock('../FlowLightCanvas', () => ({ FlowLightCanvas: () => null }))
import { Composer } from '../Composer'
import { normalizeSettings } from '../chatTypes'
import type { ContextUsage } from '../../shared/ipc'

const noop = () => undefined
function render(contextUsage?: ContextUsage) {
  return renderToStaticMarkup(<Composer dockRef={{ current: null }} draft="" busy={false} settings={normalizeSettings({})} serviceAvailable contextUsage={contextUsage} onDraftChange={noop} onSend={noop} onStop={noop} onResolveApproval={noop} onModelChange={noop} onApiModelPick={noop} onSlashCommand={noop} onReasoningChange={noop} />)
}
describe('context popover completion visibility', () => {
  it('omits round statistics before the first completion and removes source information', () => {
    expect(render()).not.toContain('本轮使用')
    expect(render()).not.toContain('窗口来源')
  })
  it('shows persisted completed usage, preserving unreported fields', () => {
    const html = render({ used: 120, usage: { inputTokens: 100, outputTokens: 20 } })
    expect(html).toContain('本轮使用')
    expect(html).toContain('未报告')
    expect(html).not.toContain('窗口来源')
  })
})
