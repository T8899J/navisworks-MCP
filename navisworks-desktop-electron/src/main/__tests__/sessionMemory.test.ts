import { describe, expect, it } from 'vitest'
import {
  updateSemanticMemory,
  updateSessionMemory,
  renderSemanticMemory,
  type SessionMemory,
} from '../agent/semanticMemory'

const EMPTY: SessionMemory = {
  goals: [],
  constraints: [],
  decisions: [],
  notes: [],
  updatedAt: 0,
}

function update(userText: string, previous?: SessionMemory): SessionMemory {
  return updateSessionMemory(previous ?? { ...EMPTY }, userText)
}

describe('session memory extraction rules (§94)', () => {
  it('must/不要 → constraint', () => {
    const memory = update('必须只读取，不要隐藏任何构件。')
    expect(memory.constraints).toEqual(['必须只读取，不要隐藏任何构件'])
    expect(memory.goals).toEqual([])
  })

  it('接下来都/以…为准 → decision (not constraint, not goal)', () => {
    const memory = update('接下来都以 M12 模型为范围。')
    expect(memory.decisions).toHaveLength(1)
    expect(memory.goals).toHaveLength(0)
    expect(memory.constraints).toHaveLength(0)
  })

  it('goal phrasing → goal', () => {
    const memory = update('我的目标是找出所有缺失编码的支架。')
    expect(memory.goals).toEqual(['我的目标是找出所有缺失编码的支架'])
  })

  it('Invariant K: follow-up 第三个呢 enters NOTHING', () => {
    const memory = update('第三个呢')
    expect(memory.goals).toHaveLength(0)
    expect(memory.constraints).toHaveLength(0)
    expect(memory.decisions).toHaveLength(0)
    expect(memory.notes).toHaveLength(0)
  })

  it('继续 enters NOTHING (§66)', () => {
    expect(update('继续')).toEqual(expect.objectContaining({
      goals: [],
      constraints: [],
      decisions: [],
      notes: [],
    }))
  })

  it('“帮我…” without goal phrasing is NOT recorded as a goal (§66)', () => {
    const memory = update('帮我把这些构件按楼层分组统计一下')
    expect(memory.goals).toHaveLength(0)
  })

  it('plain conversation (为什么/这个呢/再看看) never enters', () => {
    for (const text of ['为什么', '这个呢', '再看看', '现在呢', '它呢']) {
      const memory = update(text)
      expect([memory.goals.length, memory.constraints.length, memory.decisions.length, memory.notes.length])
        .toEqual([0, 0, 0, 0])
    }
  })

  it('explicit 记住 → note', () => {
    const memory = update('需要记住的是：本项目以 IFC4 导出为准。')
    expect(memory.notes).toHaveLength(1)
  })
})

describe('memory size / dedupe / redaction (§95)', () => {
  it('buckets stay capped after a flood of entries (goals 6, constraints 8)', () => {
    let memory = { ...EMPTY }
    for (let index = 0; index < 20; index += 1) {
      memory = update(`目标是目标${index}`, memory)
    }
    for (let index = 0; index < 20; index += 1) {
      memory = update(`不要做事情${index}`, memory)
    }
    expect(memory.goals.length).toBeLessThanOrEqual(6)
    expect(memory.constraints.length).toBeLessThanOrEqual(8)
    // the most RECENT ones survive (bounded queue):
    expect(memory.goals.at(-1)).toBe('目标是目标19')
  })

  it('over-long entries are truncated at 400 chars, never 2000-char prompts', () => {
    const memory = update(`目标是${'很长的目标描述'.repeat(100)}`)
    expect(memory.goals[0]!.length).toBeLessThanOrEqual(400)
  })

  it('normalized dedupe (§67): whitespace/punctuation variants stored once', () => {
    const first = update('必须只读取。', { ...EMPTY })
    const second = update('必须  只读取', first)
    expect(second.constraints).toHaveLength(1)
    const third = update('必须只读取。', second)
    expect(third.constraints).toHaveLength(1)
  })

  it('exact identifiers keep being redacted (§69)', () => {
    const guid = 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d'
    const memory = update(`目标是统计 id=${guid} 的构件数量`)
    expect(memory.goals[0]).not.toContain(guid)
    expect(memory.goals[0]).toContain('[精确ID]')
  })

  it('P20 aliases exist and the disk shape is unchanged', () => {
    expect(updateSessionMemory).toBe(updateSemanticMemory)
    const memory = updateSemanticMemory(undefined, '目标是完成检查')
    expect(Object.keys(memory).sort()).toEqual(['constraints', 'decisions', 'goals', 'notes', 'updatedAt'])
    expect(renderSemanticMemory(memory)).toContain('当前目标')
    // render gate: an all-empty memory renders nothing (no phantom block)
    expect(renderSemanticMemory({ ...EMPTY })).toBe('')
  })
})
