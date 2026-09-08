import type { AgentToolContract, AgentToolImpact, JsonSchema } from '../toolCatalog'
import { toolCatalog } from '../toolCatalog'
import type { ToolPermission } from '../../shared/ipc'
import type { ToolOrigin } from '../capability/types'
import type { CapabilityRegistry } from '../capability/capabilityRegistry'

/**
 * The single source of truth for agent tools. Core-owned INTERNAL tools are
 * defined here; capability tools are CONTRIBUTED by the CapabilityRegistry
 * at composition time (§24/§101) — this file never names a capability.
 * Adds the permission layer's needs: a stable identity, a display label, an
 * origin, and a default permission.
 *
 * The renderer NEVER holds a second copy of this catalog — it fetches
 * summaries through the `tools.list` IPC route.
 */

/** @deprecated display compatibility only; runtime decisions read `origin` (§23). */
export type ToolCategory = 'navisworks' | 'internal'

/** @deprecated narrow alias for the historical Navisworks tool set; core types use string. */
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

/** @deprecated narrow alias for the core-owned internal tools. */
export type InternalToolName = 'read_tool_result' | 'question' | 'skill'

export interface AgentToolDefinition {
  name: string
  label: string
  description: string
  parameters: JsonSchema
  /** @deprecated kept for the settings UI until capability grouping lands; use origin. */
  category: ToolCategory
  /** P23: where the definition actually comes from — the routing authority. */
  origin: ToolOrigin
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
  origin: { kind: 'internal' },
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

/** P16 internal tool: ask the user for missing decision-critical information. */
const QUESTION_DEFINITION: AgentToolDefinition = {
  name: 'question',
  label: '向用户提问',
  description: '缺少完成任务所需的关键信息时，向用户提出 1–4 个问题并等待回答。',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: '要问用户的问题（1–4 个）。single/multiple 必须给 2–8 个 options，text 不给。',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '问题文本（≤500 字符）。' },
            kind: { type: 'string', enum: ['single', 'multiple', 'text'] },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 8,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '选项文案（≤200 字符）。' },
                  description: { type: 'string' },
                },
                required: ['label'],
              },
            },
            required: { type: 'boolean' },
          },
          required: ['question', 'kind'],
        },
      },
    },
    required: ['questions'],
  },
  category: 'internal',
  origin: { kind: 'internal' },
  impact: 'read-only',
  defaultPermission: 'allow',
  contract: {
    type: 'function',
    function: {
      name: 'question',
      description: '缺少完成任务所需的关键信息时，向用户提出 1–4 个问题并等待回答；这不是执行授权确认，也不改变任何状态。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                kind: { type: 'string', enum: ['single', 'multiple', 'text'] },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 8,
                  items: {
                    type: 'object',
                    properties: { label: { type: 'string' }, description: { type: 'string' } },
                    required: ['label'],
                  },
                },
                required: { type: 'boolean' },
              },
              required: ['question', 'kind'],
            },
          },
        },
        required: ['questions'],
      },
    },
    impact: 'read-only',
  },
}

/** P19 internal tool: load one Skill's full instructions on demand. */
const SKILL_DEFINITION: AgentToolDefinition = {
  name: 'skill',
  label: '加载 Skill',
  description: '按名称加载已在 Available Skills 列出的工作流说明。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill 名称（来自上下文中的 Available Skills 清单）。' },
    },
    required: ['name'],
  },
  category: 'internal',
  origin: { kind: 'internal' },
  impact: 'read-only',
  defaultPermission: 'allow',
  contract: {
    type: 'function',
    function: {
      name: 'skill',
      description: '按名称加载一个已在 Available Skills 中列出的工作流说明。只在任务与该 Skill 描述匹配时调用。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    impact: 'read-only',
  },
}

const INTERNAL_DEFINITIONS: readonly AgentToolDefinition[] = [
  READ_TOOL_RESULT_DEFINITION,
  QUESTION_DEFINITION,
  SKILL_DEFINITION,
]

export interface ToolRegistryOptions {
  /** Registered capabilities; their tool definitions join the single truth (§24). */
  capabilities?: CapabilityRegistry
  /** Explicit internal definitions override (tests). */
  internal?: readonly AgentToolDefinition[]
}

export class ToolRegistry {
  readonly #definitions: AgentToolDefinition[]
  readonly #byName: Map<string, AgentToolDefinition>
  readonly #capabilities: CapabilityRegistry | undefined

  /**
   * `definitions` (legacy positional) fully replaces the set — used by unit
   * tests predating capability composition. The production path is
   * `createToolRegistry(options)` which aggregates internal + capabilities.
   */
  constructor(definitions?: readonly AgentToolDefinition[], capabilities?: CapabilityRegistry) {
    this.#definitions = definitions ? [...definitions] : [...INTERNAL_DEFINITIONS]
    this.#byName = new Map(this.#definitions.map((definition) => [definition.name, definition]))
    this.#capabilities = capabilities
  }

  /** Aggregate the single tool truth: internal definitions + every registered capability (§24). */
  static compose(options: ToolRegistryOptions): ToolRegistry {
    const internal = [...(options.internal ?? INTERNAL_DEFINITIONS)]
    const capabilityDefinitions = options.capabilities?.toolDefinitions() ?? []
    const registry = new ToolRegistry([...internal, ...capabilityDefinitions], options.capabilities)
    // Tool names must be globally unique — the capability registry already
    // checks cross-capability collisions; internal/capability overlap is caught HERE.
    const seen = new Set<string>()
    for (const definition of registry.#definitions) {
      if (seen.has(definition.name)) {
        throw new Error(`重复的 Tool name: ${definition.name}（internal 与 capability 冲突，拒绝启动）`)
      }
      seen.add(definition.name)
    }
    return registry
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
   * Argument normalization: capability definitions delegate to the owning
   * catalog's behavior (blank optional strings dropped) so old calling
   * conventions keep working; internal tools pass through unchanged.
   */
  normalizeArguments(
    name: string,
    argumentsValue: Record<string, unknown>,
  ): Record<string, unknown> {
    const definition = this.get(name)
    if (definition !== undefined && definition.origin.kind === 'capability' && definition.category === 'navisworks') {
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
    if (definition.origin.kind === 'capability' && definition.category === 'navisworks') {
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
      .filter((definition) => definition.origin.kind !== 'internal')
      .map((definition) => ({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        impact: definition.impact,
        category: definition.category,
        capabilityId: definition.origin.kind === 'capability' ? definition.origin.capabilityId : undefined,
        capabilityName: definition.origin.kind === 'capability'
          ? this.#capabilities?.get(definition.origin.capabilityId)?.manifest.name
          : undefined,
        permission: this.resolvePermission(definition.name, input),
        defaultPermission: definition.defaultPermission,
      }))
  }
}

export interface ToolDefinitionSummary {
  name: string
  label: string
  description: string
  impact: AgentToolImpact
  category: ToolCategory
  capabilityId?: string
  capabilityName?: string
  permission: ToolPermission
  defaultPermission: ToolPermission
}

function buildDefaultRegistry(): ToolRegistry {
  // Production default: the three core-internal tools only. Capability tools
  // join through ToolRegistry.compose({ capabilities }) in the composition
  // root — this module no longer hardcodes any capability's catalog (§101).
  return ToolRegistry.compose({ internal: INTERNAL_DEFINITIONS })
}

/**
 * @deprecated production composition uses the ONE `agentTools` registry built
 * in the composition root (`AgentToolRegistryToken` in applicationServices) —
 * this module-level singleton contains ONLY the internal tools and exists
 * purely for legacy unit-test imports (§8). Production MUST NOT use it.
 */
export const toolRegistry: ToolRegistry = buildDefaultRegistry()

/** Factory seam (§117): compose the registry once the capabilities exist. */
export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  return ToolRegistry.compose(options)
}

/** Explicit access to the core-internal definitions (tests / composition). */
export function internalToolDefinitions(): readonly AgentToolDefinition[] {
  return INTERNAL_DEFINITIONS
}
