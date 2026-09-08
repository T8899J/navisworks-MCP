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

import { NAVISWORKS_TOOL_DEFINITIONS } from './navisworks/toolDefinitions'

/**
 * P25 generalization: tool identity is an OPEN string so future capabilities
 * (files_, web_, …) never require touching this core type (§20). Narrow
 * strong-typed unions live with the layer that owns them
 * (NavisworksToolName in navisworks/toolDefinitions, InternalToolName in
 * tool/registry). The historical closed union remains as
 * LEGACY_AGENT_TOOL_NAMES for the navisworks toolNameSchema IPC compat.
 */
export type AgentToolName = string

/** @deprecated compatibility: the historical closed union. */
export type LegacyAgentToolName =
  | 'read_tool_result'
  | 'question'
  | 'skill'
  | import('./navisworks/toolDefinitions').NavisworksToolName

export class ToolCatalogError extends Error {
  readonly code = 'TOOL_NOT_ALLOWED'

  constructor(message: string) {
    super(message)
    this.name = 'ToolCatalogError'
  }
}

const definitions = NAVISWORKS_TOOL_DEFINITIONS

/** @deprecated compatibility re-export: the Navisworks contracts, previously the global catalog. */
const definitionsByName = new Map<AgentToolName, AgentToolContract>(
  definitions.map((definition) => [definition.function.name, definition]),
)

export const AGENT_TOOL_DEFINITIONS: readonly AgentToolContract[] = definitions
/** @deprecated compatibility re-export (see AGENT_TOOL_DEFINITIONS). */
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
