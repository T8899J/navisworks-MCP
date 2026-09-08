import type { AgentToolContract, AgentToolImpact, AgentToolName, JsonSchema } from '../toolCatalog'

/**
 * P25: the Navisworks capability's tool contracts live HERE — toolCatalog.ts
 * keeps only the generic AgentToolContract shape and re-exports these for
 * compatibility (legacy imports report in the final doc).
 */
export type NavisworksToolName =
  | 'navisworks_status'
  | 'navisworks_get_document'
  | 'navisworks_get_selection'
  | 'navisworks_find_items'
  | 'navisworks_get_item_properties'
  | 'navisworks_select_items'
  | 'navisworks_set_visibility'
  | 'navisworks_list_viewpoints'
  | 'navisworks_activate_viewpoint'

export const NAVISWORKS_TOOL_NAMES: readonly NavisworksToolName[] = [
  'navisworks_status',
  'navisworks_get_document',
  'navisworks_get_selection',
  'navisworks_find_items',
  'navisworks_get_item_properties',
  'navisworks_select_items',
  'navisworks_set_visibility',
  'navisworks_list_viewpoints',
  'navisworks_activate_viewpoint',
]

function tool(
  name: NavisworksToolName,
  description: string,
  impact: AgentToolImpact,
  parameters: JsonSchema,
): AgentToolContract {
  return {
    type: 'function',
    function: { name: name as AgentToolName, description, parameters },
    impact,
  }
}

export const NAVISWORKS_TOOL_DEFINITIONS: readonly AgentToolContract[] = [
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
      includeProperties: { type: 'boolean', description: '是否同时返回属性字典。' },
      propertyCategory: { type: 'string', description: '属性类别过滤。' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
  }),
  tool('navisworks_find_items', '按名称、类别或属性搜索模型构件。大模型会分段扫描：结果 truncated 为 true 时，用完全相同的参数再次调用可从断点继续搜索；多次后仍找不到，请用户在 Navisworks 手动选中后用 navisworks_get_selection。', 'read-only', {
    type: 'object',
    properties: {
      query: { type: 'string', description: '名称/显示名包含匹配（不区分大小写）。' },
      scope: { type: 'string', enum: ['names', 'properties', 'all'], description: '扫描范围（默认 names）。' },
      category: { type: 'string', description: '类别过滤（如 Element、View）。' },
      property: { type: 'string', description: '属性名过滤。' },
      match: { type: 'string', enum: ['contains', 'equals'], description: '匹配方式（默认 contains）。' },
      caseSensitive: { type: 'boolean', description: '是否区分大小写。' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回条数。' },
    },
  }),
  tool('navisworks_get_item_properties', '读取指定构件的属性。', 'read-only', {
    type: 'object',
    properties: {
      itemIds: {
        type: 'array',
        items: { type: 'string' },
        description: '要读取的构件 ID（最多 50 个）。',
        maxItems: 50,
      },
      category: { type: 'string', description: '属性类别过滤。' },
      property: { type: 'string', description: '属性名过滤。' },
    },
    required: ['itemIds'],
  }),
  tool('navisworks_select_items', '改变当前选择。', 'view-state-change', {
    type: 'object',
    properties: {
      itemIds: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      mode: { type: 'string', enum: ['replace', 'add', 'remove', 'clear'] },
    },
  }),
  tool('navisworks_set_visibility', '设置构件可见性。', 'view-state-change', {
    type: 'object',
    properties: {
      itemIds: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      action: { type: 'string', enum: ['hide', 'show', 'isolate', 'reset'] },
    },
  }),
  tool('navisworks_list_viewpoints', '列出已保存的视点（可分页）。', 'read-only', {
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

/**
 * P23/P25: build the capability's AgentToolDefinitions from the contracts.
 * `origin.kind = 'capability'` is the routing authority; `category` remains
 * only for the deprecated settings-UI field (§23). defaultPermission mirrors
 * the historical rule: view-state-change → ask, read-only → allow.
 */
export interface AgentToolDefinitionLite {
  name: NavisworksToolName
  label: string
  description: string
  parameters: JsonSchema
  impact: AgentToolImpact
  defaultPermission: 'allow' | 'ask' | 'deny'
  contract: AgentToolContract
}

const NAVISWORKS_LABELS: Record<NavisworksToolName, string> = {
  navisworks_status: '检查插件连接状态',
  navisworks_get_document: '读取当前文档',
  navisworks_get_selection: '读取当前选择',
  navisworks_find_items: '搜索构件',
  navisworks_get_item_properties: '读取构件属性',
  navisworks_select_items: '改变构件选择',
  navisworks_set_visibility: '改变模型可见性',
  navisworks_list_viewpoints: '列出保存视点',
  navisworks_activate_viewpoint: '激活保存视点',
}

export function navisworksToolDefinitions(): readonly AgentToolDefinitionLite[] {
  return NAVISWORKS_TOOL_DEFINITIONS.map((contract) => {
    const name = contract.function.name as NavisworksToolName
    return {
      name,
      label: NAVISWORKS_LABELS[name],
      description: contract.function.description,
      parameters: contract.function.parameters,
      impact: contract.impact,
      defaultPermission: contract.impact === 'view-state-change' ? 'ask' : 'allow',
      contract,
    }
  })
}
