import type { AgentToolContract, AgentToolImpact, JsonSchema } from '../toolCatalog'
import { toolCatalog } from '../toolCatalog'
import type { ToolPermission } from '../../shared/ipc'

/**
 * The single source of truth for agent tools. Built on top of the existing
 * toolCatalog wire contracts (name/description/schema/impact/normalization)
 * and adds what the permission layer needs: a stable identity, a display
 * label, a category, and a default permission.
 *
 * The renderer NEVER holds a second copy of this catalog — it fetches
 * summaries through the `tools.list` IPC route.
 */

export type ToolCategory = 'navisworks' | 'internal'

export interface AgentToolDefinition {
  name: string
  label: string
  description: string
  parameters: JsonSchema
  category: ToolCategory
  impact: AgentToolImpact
  defaultPermission: ToolPermission
  /** The wire contract sent to the model when the tool is not denied. */
  contract: AgentToolContract
}

/** Input for permission resolution: explicit overrides + legacy disabled list. */
export interface ToolPermissionInput {
  permissions?: Record<string, ToolPermission>
  /** Legacy enable/disable switches, migrated as deny. */
  legacyDisabled?: readonly string[]
}

/** Internal helper tool: reads pages of a previously stored large tool output. */
const READ_TOOL_RESULT_DEFINITION: AgentToolDefinition = {
  name: 'read_tool_result',
  label: '读取历史工具结果',
  description: '分页读取此前某次大型工具结果的完整内容（仅限 Curi 自己产生的 resultRef）。',
  parameters: {
    type: 'object',
    properties: {
      resultRef: { type: 'string', description: '先前工具结果返回的 resultRef。', maxLength: 64 },
      offset: { type: 'integer', minimum: 0, description: '起始条目（默认 0）。' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '本次读取条数（默认 50，最大 100）。' },
    },
    required: ['resultRef'],
  },
  category: 'internal',
  impact: 'read-only',
  defaultPermission: 'allow',
  contract: {
    type: 'function',
    function: {
      name: 'read_tool_result',
      description: '分页读取此前某次大型工具结果的完整内容。resultRef 必须来自先前工具结果。',
      parameters: {
        type: 'object',
        properties: {
          resultRef: { type: 'string', description: '先前工具结果返回的 resultRef。' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['resultRef'],
      },
    },
    impact: 'read-only',
  },
}

const LABELS: Record<string, string> = {
  navisworks_status: '检查插件连接状态',
  navisworks_get_document: '读取当前文档',
  navisworks_get_selection: '读取当前选择',
  navisworks_find_items: '搜索构件',
  navisworks_get_item_properties: '读取构件属性',
  navisworks_select_items: '改变构件选择',
  navisworks_set_visibility: '改变模型可见性',
  navisworks_list_viewpoints: '列出保存视点',
  navisworks_activate_viewpoint: '激活保存视点',
  read_tool_result: '读取历史工具结果',
}

function buildDefinition(contract: AgentToolContract): AgentToolDefinition {
  const name = contract.function.name
  const isViewState = contract.impact === 'view-state-change'
  return {
    name,
    label: LABELS[name] ?? name,
    description: contract.function.description,
    parameters: contract.function.parameters,
    category: 'navisworks',
    impact: contract.impact,
    // Read tools run silently; tools that change the user's view ask first.
    // (Existing safety rules keep applying on top — never weaker.)
    defaultPermission: isViewState ? 'ask' : 'allow',
    contract,
  }
}

export interface ToolDefinitionSummary {
  name: string
  label: string
  description: string
  impact: AgentToolImpact
  category: ToolCategory
  permission: ToolPermission
  defaultPermission: ToolPermission
}

export class ToolRegistry {
  readonly #definitions: AgentToolDefinition[]
  readonly #byName: Map<string, AgentToolDefinition>

  constructor(definitions: readonly AgentToolDefinition[]) {
    this.#definitions = [...definitions]
    this.#byName = new Map(this.#definitions.map((definition) => [definition.name, definition]))
  }

  list(): readonly AgentToolDefinition[] {
    return this.#definitions
  }

  get(name: string): AgentToolDefinition | undefined {
    return this.#byName.get(name)
  }

  contains(name: string): boolean {
    return this.#byName.has(name)
  }

  /**
   * Argument normalization — delegates Navisworks tools to the existing
   * catalog behavior (blank optional strings dropped), so old calling
   * conventions keep working.
   */
  normalizeArguments(
    name: string,
    argumentsValue: Record<string, unknown>,
  ): Record<string, unknown> {
    if (this.get(name)?.category === 'navisworks') {
      return toolCatalog.normalizeArguments(name, argumentsValue)
    }
    return argumentsValue
  }

  assertAllowed(name: string, argumentsValue: unknown = {}): void {
    const definition = this.get(name)
    if (definition === undefined) {
      throw new Error(`工具不在允许列表中：${name || '(empty)'}`)
    }
    if (
      argumentsValue === null
      || typeof argumentsValue !== 'object'
      || Array.isArray(argumentsValue)
    ) {
      throw new Error(`工具 ${name} 的 arguments 必须是对象。`)
    }
    if (definition.category === 'navisworks') {
      // Keeps the catalog's own strict tool-name check on the legacy path.
      toolCatalog.assertAllowed(name, argumentsValue)
    }
  }

  /**
   * Resolution order: explicit toolPermissions → legacy disabledTools (deny)
   * → registry defaultPermission. Unknown tools resolve to deny.
   */
  resolvePermission(name: string, input: ToolPermissionInput = {}): ToolPermission {
    const explicit = input.permissions?.[name]
    if (explicit === 'allow' || explicit === 'ask' || explicit === 'deny') {
      return explicit
    }
    if (input.legacyDisabled?.includes(name)) {
      return 'deny'
    }
    return this.get(name)?.defaultPermission ?? 'deny'
  }

  /**
   * The tool contracts sent to the model: deny tools are NOT sent at all
   * (the model never learns they exist); ask tools ARE sent — the model can
   * request them, the runtime then gates execution on user approval.
   */
  materialize(input: ToolPermissionInput = {}): AgentToolContract[] {
    return this.#definitions
      .filter((definition) => this.resolvePermission(definition.name, input) !== 'deny')
      .map((definition) => definition.contract)
  }

  /** Settings-UI summaries (internal tools excluded) with resolved permissions. */
  listUiTools(input: ToolPermissionInput = {}): ToolDefinitionSummary[] {
    return this.#definitions
      .filter((definition) => definition.category !== 'internal')
      .map((definition) => ({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        impact: definition.impact,
        category: definition.category,
        permission: this.resolvePermission(definition.name, input),
        defaultPermission: definition.defaultPermission,
      }))
  }
}

function buildDefaultRegistry(): ToolRegistry {
  const navisworksDefinitions = toolCatalog.definitions.map(buildDefinition)
  return new ToolRegistry([...navisworksDefinitions, READ_TOOL_RESULT_DEFINITION])
}

/** The process-wide registry singleton. */
export const toolRegistry: ToolRegistry = buildDefaultRegistry()
