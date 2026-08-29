export type AgentToolImpact = 'read-only' | 'view-state-change'

export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: readonly string[]
}

export interface AgentToolContract {
  type: 'function'
  function: {
    name: AgentToolName
    description: string
    parameters: JsonSchema
  }
  impact: AgentToolImpact
}

export type AgentToolName =
  | 'navisworks_status'
  | 'navisworks_get_document'
  | 'navisworks_get_selection'
  | 'navisworks_find_items'
  | 'navisworks_get_item_properties'
  | 'navisworks_select_items'
  | 'navisworks_set_visibility'
  | 'navisworks_list_viewpoints'
  | 'navisworks_activate_viewpoint'

export class ToolCatalogError extends Error {
  readonly code = 'TOOL_NOT_ALLOWED'

  constructor(message: string) {
    super(message)
    this.name = 'ToolCatalogError'
  }
}

const definitions = [
  tool('navisworks_status', '检查 Navisworks 插件连接状态和当前文档。', 'read-only', {
    type: 'object',
    properties: {},
  }),
  tool('navisworks_get_document', '读取活动文档、已加载模型、单位和选择数量。', 'read-only', {
    type: 'object',
    properties: {},
  }),
  tool('navisworks_get_selection', '读取当前选择的构件。', 'read-only', {
    type: 'object',
    properties: {
      includeProperties: { type: 'boolean', description: '是否同时返回属性。' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  }),
  tool('navisworks_find_items', '按名称、类别或属性搜索模型构件。大模型会分段扫描：结果 truncated 为 true 时，用完全相同的参数再次调用可从断点继续搜索；多次后仍找不到，请用户在 Navisworks 手动选中后用 navisworks_get_selection。', 'read-only', {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词。', maxLength: 200 },
      scope: { type: 'string', enum: ['names', 'properties', 'all'] },
      category: { type: 'string', description: '类别显示名或内部名。', maxLength: 200 },
      property: { type: 'string', description: '属性显示名或内部名。', maxLength: 200 },
      match: { type: 'string', enum: ['contains', 'equals'] },
      caseSensitive: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['query'],
  }),
  tool('navisworks_get_item_properties', '读取一个或多个构件 ID 的属性。', 'read-only', {
    type: 'object',
    properties: {
      itemIds: {
        type: 'array',
        items: { type: 'string', maxLength: 100 },
        minItems: 1,
        maxItems: 50,
      },
      category: { type: 'string', maxLength: 200 },
      property: { type: 'string', maxLength: 200 },
    },
    required: ['itemIds'],
  }),
  tool('navisworks_select_items', '选中、添加、移除或清空构件选择。', 'view-state-change', {
    type: 'object',
    properties: {
      itemIds: {
        type: 'array',
        items: { type: 'string', maxLength: 100 },
        minItems: 1,
        maxItems: 50,
      },
      mode: { type: 'string', enum: ['replace', 'add', 'remove', 'clear'] },
    },
  }),
  tool('navisworks_set_visibility', '隐藏、显示、隔离构件或重置可见性。', 'view-state-change', {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['hide', 'show', 'isolate', 'reset'] },
      itemIds: {
        type: 'array',
        items: { type: 'string', maxLength: 100 },
        minItems: 1,
        maxItems: 50,
      },
    },
    required: ['action'],
  }),
  tool('navisworks_list_viewpoints', '列出当前文档中的保存视点（含所在文件夹路径）。视点很多时用 limit/offset 分页，结果带 total 总数。', 'read-only', {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 2000 },
      offset: { type: 'integer', minimum: 0 },
    },
  }),
  tool('navisworks_activate_viewpoint', '按 GUID 激活保存视点。', 'view-state-change', {
    type: 'object',
    properties: {
      viewpointId: { type: 'string', description: '保存视点的 GUID。', maxLength: 36 },
    },
    required: ['viewpointId'],
  }),
] as const satisfies readonly AgentToolContract[]

const definitionsByName = new Map<AgentToolName, AgentToolContract>(
  definitions.map((definition) => [definition.function.name, definition]),
)

export const AGENT_TOOL_DEFINITIONS: readonly AgentToolContract[] = definitions
export const AGENT_TOOL_NAMES: readonly AgentToolName[] = definitions.map(
  (definition) => definition.function.name,
)

export class ToolCatalog {
  readonly definitions = AGENT_TOOL_DEFINITIONS

  contains(name: string): name is AgentToolName {
    return definitionsByName.has(name as AgentToolName)
  }

  get(name: string): AgentToolContract | undefined {
    return definitionsByName.get(name as AgentToolName)
  }

  assertAllowed(name: string, argumentsValue: unknown = {}): asserts name is AgentToolName {
    if (!this.contains(name)) {
      throw new ToolCatalogError(`工具不在允许列表中：${name || '(empty)'}`)
    }
    if (
      argumentsValue === null
      || typeof argumentsValue !== 'object'
      || Array.isArray(argumentsValue)
    ) {
      throw new ToolCatalogError(`工具 ${name} 的 arguments 必须是对象。`)
    }
  }

  /**
   * Small local models tend to pass empty strings for optional string
   * parameters instead of omitting them, and downstream validation rejects
   * empty strings as "provided but invalid". Dropping blank values for
   * optional (non-required) string properties makes the call mean "not
   * provided", which is what the model intended. Required keys are left
   * untouched so genuinely missing input still fails loudly.
   */
  normalizeArguments(
    name: string,
    argumentsValue: Record<string, unknown>,
  ): Record<string, unknown> {
    const definition = definitionsByName.get(name as AgentToolName)
    if (!definition) {
      return argumentsValue
    }
    const { properties, required } = definition.function.parameters
    const normalized: Record<string, unknown> = { ...argumentsValue }
    for (const key of Object.keys(normalized)) {
      if (required?.includes(key)) {
        continue
      }
      const propertySchema = properties[key] as { type?: string } | undefined
      if (!propertySchema || propertySchema.type !== 'string') {
        continue
      }
      const value = normalized[key]
      if (typeof value === 'string' && value.trim().length === 0) {
        delete normalized[key]
      }
    }
    return normalized
  }
}

export const toolCatalog: ToolCatalog = new ToolCatalog()

function tool(
  name: AgentToolName,
  description: string,
  impact: AgentToolImpact,
  parameters: JsonSchema,
): AgentToolContract {
  return {
    type: 'function',
    function: { name, description, parameters },
    impact,
  }
}
