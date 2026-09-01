export interface SemanticMemory {
  goals: string[]
  constraints: string[]
  decisions: string[]
  notes: string[]
  updatedAt: number
}

export function updateSemanticMemory(
  previous: SemanticMemory | undefined,
  userInput: string,
): SemanticMemory {
  const safeInput = redactExactIdentifiers(userInput.trim())
  const goals = [...(previous?.goals ?? [])]
  const constraints = [...(previous?.constraints ?? [])]
  for (const sentence of safeInput.split(/[。！？\n]+/)) {
    const value = sentence.trim()
    if (!value || !/(?:不要|不得|必须|只能|只做|不需要)/.test(value)) continue
    if (!constraints.includes(value)) constraints.push(value.slice(0, 300))
  }
  if (safeInput && !/^(?:继续|好的?|可以|确认|执行|开始)[。！!？?]?$/.test(safeInput)
    && !goals.includes(safeInput)) {
    goals.push(safeInput.slice(0, 2_000))
  }
  return {
    goals: goals.slice(-8),
    constraints: constraints.slice(-8),
    decisions: [...(previous?.decisions ?? [])].slice(-8),
    notes: [...(previous?.notes ?? [])].slice(-8),
    updatedAt: Date.now(),
  }
}

function redactExactIdentifiers(value: string): string {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[精确ID]')
    .replace(/\b(?:item|viewpoint|document)?id\s*[:=]\s*[^\s,;，；]+/gi, 'id=[精确ID]')
}

export function renderSemanticMemory(memory: SemanticMemory | undefined): string {
  if (memory === undefined || memory.goals.length === 0) return ''
  const lines = [`- 当前目标：${memory.goals.join('；')}`]
  if (memory.constraints.length > 0) lines.push(`- 已确认约束：${memory.constraints.join('；')}`)
  if (memory.decisions.length > 0) lines.push(`- 已确认决策：${memory.decisions.join('；')}`)
  if (memory.notes.length > 0) lines.push(`- 备注：${memory.notes.join('；')}`)
  return `【会话语义记忆（不包含构件或视点精确 ID）】\n${lines.join('\n')}`
}
