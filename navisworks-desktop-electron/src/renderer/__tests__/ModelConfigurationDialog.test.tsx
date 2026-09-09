import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ModelConfigurationDialog } from '../ModelConfigurationDialog'
import type { ModelConfiguration } from '../chatTypes'

function render(props: {
  modelIdEditable: boolean
  existing?: ModelConfiguration
}): string {
  return renderToStaticMarkup(
    <ModelConfigurationDialog
      open
      providerId={props.modelIdEditable ? 'api:x' : 'ollama'}
      modelId="qwen3.8-max"
      modelIdEditable={props.modelIdEditable}
      existing={props.existing}
      onCancel={() => undefined}
      onSubmit={() => undefined}
    />,
  )
}

describe('ModelConfigurationDialog (§26/§43)', () => {
  it('renders every reference field: model id, context, output, and both modality groups', () => {
    const html = render({ modelIdEditable: true })
    expect(html).toContain('编辑模型配置')
    expect(html).toContain('模型 ID')
    expect(html).toContain('上下文窗口')
    expect(html).toContain('最大输出 Token')
    expect(html).toContain('输入类型')
    expect(html).toContain('输出类型')
    // Modality options render (§18).
    expect(html).toContain('图片')
    expect(html).toContain('PDF')
    // §43: the metadata-only note is present (§25/Invariant L).
    expect(html).toContain('输入/输出类型用于描述模型能力')
    expect(html).toContain('仍以文本为准')
  })

  it('API model id is editable; Ollama model id is read-only with a hint (§27)', () => {
    expect(render({ modelIdEditable: true })).not.toMatch(/id="mc-model-id"[^>]*disabled/)
    const ollama = render({ modelIdEditable: false })
    expect(ollama).toMatch(/id="mc-model-id"[^>]*disabled/)
    expect(ollama).toContain('只读')
  })

  it('prefills the existing configuration + Auto placeholders on empty (§28)', () => {
    const html = render({
      modelIdEditable: true,
      existing: {
        ref: { providerId: 'api:x', modelId: 'qwen3.8-max' },
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 128_000,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
    })
    expect(html).toContain('value="1000000"')
    expect(html).toContain('value="128000"')
    expect(html).toContain('留空 = Auto')
  })
})
