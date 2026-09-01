import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../model/types'
import {
  contextFramesToMessages,
  findOrphanToolMessages,
  messagesToContextFrames,
} from '../contextFrames'

const assistantCall = (id: string, name: string): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name, arguments: {} }],
})
const toolResult = (id: string, content: string): ChatMessage => ({
  role: 'tool',
  toolCallId: id,
  content,
})

describe('contextFrames — Invariant D (tool call + result are atomic)', () => {
  it('binds an assistant tool_call with its result into one ToolExchangeFrame', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '查一下' },
      assistantCall('c1', 'navisworks_status'),
      toolResult('c1', 'ok'),
      { role: 'assistant', content: '已连接。' },
    ]
    const frames = messagesToContextFrames(messages)
    expect(frames.map((frame) => frame.type)).toEqual([
      'user',
      'tool-exchange',
      'assistant-text',
    ])
    const exchange = frames[1]
    expect(exchange?.type).toBe('tool-exchange')
    if (exchange?.type === 'tool-exchange') {
      expect(exchange.assistant.toolCalls?.map((call) => call.id)).toEqual(['c1'])
      expect(exchange.results.map((message) => message.toolCallId)).toEqual(['c1'])
    }
  })

  it('keeps every result of a multi-call assistant inside the same frame', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'navisworks_status', arguments: {} },
          { id: 'b', name: 'navisworks_get_document', arguments: {} },
        ],
      },
      toolResult('a', 'A'),
      toolResult('b', 'B'),
    ]
    const frames = messagesToContextFrames(messages)
    expect(frames).toHaveLength(1)
    const frame = frames[0]
    if (frame?.type === 'tool-exchange') {
      expect(frame.toolCallIds).toEqual(['a', 'b'])
      expect(frame.results).toHaveLength(2)
    } else {
      throw new Error('expected a single tool-exchange frame')
    }
  })

  it('round-trips back to the exact provider message array', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      assistantCall('c1', 'navisworks_status'),
      toolResult('c1', 'ok'),
      { role: 'assistant', content: 'done' },
    ]
    // The leading system message is held out of frames by design, so frame the body.
    const [system, ...body] = messages
    const rebuilt = [system!, ...contextFramesToMessages(messagesToContextFrames(body))]
    expect(rebuilt).toEqual(messages)
  })

  it('flags a tool result whose call was dropped (split frame is invalid)', () => {
    const valid = [assistantCall('c1', 'navisworks_status'), toolResult('c1', 'ok')]
    expect(findOrphanToolMessages(valid)).toEqual([])
    // Dropping the assistant call but keeping the result breaks the invariant.
    const broken: ChatMessage[] = [toolResult('c1', 'ok')]
    expect(findOrphanToolMessages(broken)).toEqual(['c1'])
  })

  it('treats a prior compaction summary (mid-array system message) as its own frame', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '压缩摘要' },
      { role: 'user', content: 'x' },
    ]
    const frames = messagesToContextFrames(messages)
    expect(frames[0]?.type).toBe('compact-summary')
  })
})
