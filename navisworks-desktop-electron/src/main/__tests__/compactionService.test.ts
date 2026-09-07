import { describe, expect, it } from 'vitest'
import {
  COMPACT_SYSTEM_PROMPT,
  renderConversationTranscript,
} from '../context/compactionService'
import { COMPACT_SYSTEM_PROMPT as CANON } from '../context/compactPrompt'
import { ContextManager } from '../agent/contextManager'

describe('P14 unified compaction seam (§66)', () => {
  it('the compaction service re-exports THE single summary prompt', () => {
    expect(COMPACT_SYSTEM_PROMPT).toBe(CANON)
    expect(COMPACT_SYSTEM_PROMPT).toContain('会话压缩器')
  })

  it('the automatic path defaults to the same prompt the manual path uses', async () => {
    // tryCompact sends [system, user] to summarize(); the default system text
    // must be the shared COMPACT_SYSTEM_PROMPT, not a second rule.
    let seenSystem = ''
    const manager = new ContextManager({ systemPrompt: 'core' })
    for (let index = 0; index < 6; index += 1) {
      manager.addUserTurn({ role: 'user', content: `消息 ${index} ${'填充内容'.repeat(60)}` })
      manager.addToolExchange(
        { role: 'assistant', content: '', toolCalls: [{ id: `c${index}`, name: 'navisworks_status', arguments: {} }] },
        [{ role: 'tool', toolCallId: `c${index}`, content: '{}' }],
      )
    }
    await manager.tryCompact({
      summarizerModel: 'm',
      keepRecentFrames: 1,
      minCompressibleFrames: 1,
      summarize: async (messages) => {
        seenSystem = messages.find((message) => message.role === 'system')?.content ?? ''
        return '摘要内容'
      },
    })
    expect(seenSystem).toBe(COMPACT_SYSTEM_PROMPT)
  })

  it('manual transcript is [role] content joined by a blank line', () => {
    expect(renderConversationTranscript([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在的' },
    ])).toBe('[user] 你好\n\n[assistant] 在的')
  })
})
