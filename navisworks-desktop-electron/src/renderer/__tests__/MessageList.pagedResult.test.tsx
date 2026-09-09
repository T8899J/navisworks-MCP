import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageList } from '../MessageList'
import type { ChatMessage } from '../chatTypes'

function assistantWithTool(result: unknown): ChatMessage[] {
  return [{
    id: 'm1',
    role: 'assistant',
    content: '查完了。',
    createdAt: '2026-09-09T00:00:00.000Z',
    tools: [{
      id: 't1',
      name: 'navisworks_find_items',
      status: 'success',
      arguments: { query: '泵' },
      result,
    }],
    parts: [{ type: 'tool-call', toolCallId: 't1', toolName: 'navisworks_find_items', status: 'success', result }],
  } as unknown as ChatMessage]
}

describe('Tool Result Delivery v2 — paged result UI (§44/§45)', () => {
  it('a paged result reads "完整结果已保存 … KB", never 截断', () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={assistantWithTool({
          delivery: 'paged',
          resultRef: 'tor_deadbeef-0000-0000-0000-000000000000',
          totalBytes: 1_500_000,
          estimatedTokens: 900_000,
          message: '完整工具结果已保存。',
        })}
        sessionId="s1"
        composerClearance={0}
      />,
    )
    expect(html).toContain('完整结果已保存')
    expect(html).toContain('1.4 MB')
    expect(html).toContain('分页读取')
    expect(html).toContain('数据未丢失')
    // §44: it must NOT be presented as Curi truncation.
    expect(html).not.toContain('截断')
  })

  it('a full (inline) result still renders its data normally', () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={assistantWithTool({ items: [{ id: 'a1' }], total: 1 })}
        sessionId="s1"
        composerClearance={0}
      />,
    )
    expect(html).toContain('a1')
    expect(html).not.toContain('完整结果已保存')
  })
})
