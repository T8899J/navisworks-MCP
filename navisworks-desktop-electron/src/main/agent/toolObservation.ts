import type { AgentToolName } from '../toolCatalog'

/**
 * The Tool Runtime's generic observation shaping (§46): every capability's
 * tool result becomes the same model-visible observation envelope here —
 * the capability providers never build these themselves, so there is exactly
 * ONE observation format regardless of who executed the tool.
 *
 * The navisworks-named branches are DISPLAY summary text (compatibility),
 * not routing/execution logic: the core never decides behavior from them.
 */
export function buildToolSuccessObservation(toolName: AgentToolName, result: unknown): Record<string, unknown> {
  const record = payloadIsRecord(result) ? result : undefined
  return {
    status: 'success',
    tool: toolName,
    summary: summarizeToolSuccess(toolName, record),
    next_actions: toolSuccessNextActions(toolName, record),
    artifacts: collectToolArtifacts(record),
    result,
  }
}

export function buildToolErrorObservation(
  toolName: AgentToolName,
  code: string,
  summary: string,
  ambiguousOutcome?: boolean,
): Record<string, unknown> {
  return {
    status: 'error',
    tool: toolName,
    code,
    summary,
    next_actions: toolErrorNextActions(code),
    artifacts: [],
    ...(ambiguousOutcome === undefined ? {} : { ambiguousOutcome }),
  }
}

export function payloadIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function summarizeToolSuccess(
  toolName: string,
  result: Record<string, unknown> | undefined,
): string {
  if (toolName === 'navisworks_status' && typeof result?.connected === 'boolean') {
    return result.connected ? 'Navisworks 已连接。' : 'Navisworks 未连接。'
  }
  if (toolName === 'navisworks_find_items') {
    const count = Array.isArray(result?.items) ? result.items.length : 0
    const total = typeof result?.total === 'number' ? result.total : undefined
    const totalText = total === undefined ? '' : `，共 ${total} 个`
    const truncatedText = result?.truncated === true ? '，结果尚未完整' : ''
    return `搜索完成：返回 ${count} 个构件${totalText}${truncatedText}。`
  }
  if (toolName === 'navisworks_get_selection') {
    const count = Array.isArray(result?.items)
      ? result.items.length
      : (typeof result?.selectionCount === 'number' ? result.selectionCount : 0)
    return `已读取当前选择：${count} 个构件。`
  }
  if (toolName === 'navisworks_list_viewpoints') {
    const count = Array.isArray(result?.viewpoints) ? result.viewpoints.length : 0
    return `已读取保存视点：返回 ${count} 个。`
  }
  if (toolName === 'navisworks_get_item_properties') {
    const count = Array.isArray(result?.items) ? result.items.length : 0
    return `已读取 ${count} 个构件的属性。`
  }
  return `${toolName} 执行成功。`
}

function toolSuccessNextActions(
  toolName: string,
  result: Record<string, unknown> | undefined,
): string[] {
  if (result?.truncated !== true) return []
  if (toolName === 'navisworks_find_items') {
    return ['如果任务仍需要更多结果，使用完全相同的搜索参数继续调用 navisworks_find_items；否则停止续查并回答。']
  }
  return ['结果未完整；仅在当前任务确实需要更多数据时继续分页。']
}

function collectToolArtifacts(result: Record<string, unknown> | undefined): string[] {
  if (result === undefined) return []
  const artifacts = new Set<string>()
  for (const key of ['items', 'viewpoints', 'results']) {
    const entries = result[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!payloadIsRecord(entry)) continue
      const id = entry.id ?? entry.itemId ?? entry.viewpointId ?? entry.guid
      if (typeof id === 'string' && id.trim()) artifacts.add(id.trim())
      if (artifacts.size >= 20) return [...artifacts]
    }
  }
  return [...artifacts]
}

function toolErrorNextActions(code: string): string[] {
  switch (code) {
    case 'AMBIGUOUS_RETRY_BLOCKED':
      return [
        '先调用只读工具确认当前状态。',
        '除非用户明确确认仍要执行，否则停止并不得自动重试相同修改。',
      ]
    case 'TOOL_CANCELLED':
      return ['停止本次修改，等待用户给出新的明确指令。']
    case 'TARGET_CHANGED':
    case 'DOCUMENT_CHANGED':
    case 'INSTANCE_CHANGED':
      return [
        '重新读取当前 Navisworks 目标和文档状态后再规划。',
        '不得自动重试原修改操作。',
      ]
    case 'ARGUMENTS_CHANGED':
      return ['重新生成稳定参数，并对修改操作重新请求审批。']
    case 'TOOL_NOT_ALLOWED':
    case 'PERMISSION_DENIED':
      return ['改用允许列表中的最小必要工具；不需要实时数据时直接回答。']
    case 'TOOL_OUTPUT_UNAVAILABLE':
      return [
        '该结果已过期或不可用；如仍需要数据，请用相同参数重新调用原工具。',
      ]
    default:
      return [
        '确认 Navisworks Manage 2023 已启动。',
        '确认模型文档已打开，并已加载 Navisworks MCP 插件。',
        '如果条件未变且相同错误再次出现，停止重试并向用户说明。',
      ]
  }
}
