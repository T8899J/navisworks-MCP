import { describe, expect, it } from 'vitest'
import { toolRegistry } from '../registry'
import { AGENT_TOOL_NAMES } from '../../toolCatalog'
import { requestSchemas } from '../../../shared/ipc/schemas'
import { eventSchemas } from '../../../shared/ipc/schemas'

const NAVISWORKS_TOOLS = [
  'navisworks_status',
  'navisworks_get_document',
  'navisworks_get_selection',
  'navisworks_find_items',
  'navisworks_get_item_properties',
  'navisworks_select_items',
  'navisworks_set_visibility',
  'navisworks_list_viewpoints',
  'navisworks_activate_viewpoint',
] as const

describe('ToolRegistry — single source of truth (Cases 1–2)', () => {
  it('Case 1: lists every Navisworks tool plus the internal reader', () => {
    const names = toolRegistry.list().map((definition) => definition.name)
    for (const name of NAVISWORKS_TOOLS) {
      expect(names).toContain(name)
    }
    expect(names).toContain('read_tool_result')
  })

  it('Case 2: unknown tools resolve to nothing and default to deny', () => {
    expect(toolRegistry.get('not_a_real_tool')).toBeUndefined()
    expect(toolRegistry.contains('not_a_real_tool')).toBe(false)
    expect(toolRegistry.resolvePermission('not_a_real_tool')).toBe('deny')
  })

  it('Case 3: normalizeArguments keeps the legacy blank-string compatibility', () => {
    // toolCatalog behavior: blank optional strings are dropped, required stay.
    const normalized = toolRegistry.normalizeArguments('navisworks_find_items', {
      query: 'Pump',
      scope: '',
    })
    expect(normalized).toEqual({ query: 'Pump' })
  })
})

describe('ToolRegistry — permission resolution (Cases 4–8)', () => {
  it('Case 4: read tools default to allow', () => {
    for (const name of [
      'navisworks_status',
      'navisworks_get_document',
      'navisworks_get_selection',
      'navisworks_find_items',
      'navisworks_get_item_properties',
      'navisworks_list_viewpoints',
    ]) {
      expect(toolRegistry.resolvePermission(name)).toBe('allow')
    }
  })

  it('Case 5: view-state tools default to ask', () => {
    for (const name of [
      'navisworks_select_items',
      'navisworks_set_visibility',
      'navisworks_activate_viewpoint',
    ]) {
      expect(toolRegistry.resolvePermission(name)).toBe('ask')
    }
  })

  it('Case 6: explicit toolPermissions override the default', () => {
    expect(toolRegistry.resolvePermission('navisworks_status', {
      permissions: { navisworks_status: 'deny' },
    })).toBe('deny')
    expect(toolRegistry.resolvePermission('navisworks_set_visibility', {
      permissions: { navisworks_set_visibility: 'allow' },
    })).toBe('allow')
  })

  it('Case 7: legacy disabledTools resolves to deny without toolPermissions', () => {
    expect(toolRegistry.resolvePermission('navisworks_set_visibility', {
      legacyDisabled: ['navisworks_set_visibility'],
    })).toBe('deny')
  })

  it('Case 8: explicit allow wins over the legacy disabled migration', () => {
    expect(toolRegistry.resolvePermission('navisworks_set_visibility', {
      permissions: { navisworks_set_visibility: 'allow' },
      legacyDisabled: ['navisworks_set_visibility'],
    })).toBe('allow')
  })
})

describe('ToolRegistry — materialization', () => {
  it('allow and ask are sent to the model; deny is hidden', () => {
    const contracts = toolRegistry.materialize({
      permissions: {
        navisworks_status: 'allow',
        navisworks_get_document: 'ask',
        navisworks_get_selection: 'deny',
      },
    })
    const names = contracts.map((contract) => contract.function.name)
    expect(names).toContain('navisworks_status')
    expect(names).toContain('navisworks_get_document')
    expect(names).not.toContain('navisworks_get_selection')
    // Contracts stay provider-shaped (existing AgentToolContract) and every
    // name is a registry-known tool.
    for (const contract of contracts) {
      expect(toolRegistry.contains(contract.function.name)).toBe(true)
    }
  })

  it('the internal reader is materialized by default but hidden from the UI list', () => {
    const names = toolRegistry.materialize().map((contract) => contract.function.name)
    expect(names).toContain('read_tool_result')
    const uiNames = toolRegistry.listUiTools().map((summary) => summary.name)
    expect(uiNames).not.toContain('read_tool_result')
    expect(uiNames).toContain('navisworks_get_document')
  })

  it('summary shapes match the tools.list IPC schema', () => {
    const summaries = toolRegistry.listUiTools({ permissions: { navisworks_status: 'deny' } })
    // Parse the whole array through the real route schema.
    const parsed = requestSchemas['tools.list'].output.parse(summaries) as Array<{ name: string; permission: string }>
    expect(parsed.some((summary) => summary.name === 'navisworks_status' && summary.permission === 'deny')).toBe(true)
  })

  it('AGENT_TOOL_NAMES and the shared ToolName union stay in sync with the registry', () => {
    for (const name of AGENT_TOOL_NAMES) {
      expect(toolRegistry.contains(name)).toBe(true)
    }
  })
})
