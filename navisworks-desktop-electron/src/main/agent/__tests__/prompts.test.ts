import { describe, expect, it } from 'vitest'
import { CURI_CORE_PROMPT, NAVISWORKS_WORKSPACE_PROMPT } from '../prompts'

describe('agent prompts', () => {
  it('defines Curi as a general-purpose agent', () => {
    expect(CURI_CORE_PROMPT).toContain('You are Curi, a general-purpose agent')
  })

  it('includes first-principles behavior', () => {
    expect(CURI_CORE_PROMPT).toContain('FIRST-PRINCIPLES THINKING')
  })

  it('includes inversion behavior', () => {
    expect(CURI_CORE_PROMPT).toContain('INVERSION')
  })

  it('includes Socratic reasoning', () => {
    expect(CURI_CORE_PROMPT).toContain('SOCRATIC REASONING')
  })

  it('includes multidisciplinary reasoning', () => {
    expect(CURI_CORE_PROMPT).toContain('MULTIDISCIPLINARY THINKING')
  })

  it('follows the user language', () => {
    expect(CURI_CORE_PROMPT).toContain("Respond in the user's language")
  })

  it('does not contain Navisworks tool instructions', () => {
    expect(CURI_CORE_PROMPT).not.toContain('navisworks_find_items')
  })

  it('keeps the exact Navisworks search tool name', () => {
    expect(NAVISWORKS_WORKSPACE_PROMPT).toContain('navisworks_find_items')
  })

  it('keeps the exact Navisworks property tool name', () => {
    expect(NAVISWORKS_WORKSPACE_PROMPT).toContain('navisworks_get_item_properties')
  })

  it('keeps the exact Navisworks viewpoint tool name', () => {
    expect(NAVISWORKS_WORKSPACE_PROMPT).toContain('navisworks_list_viewpoints')
  })

  it('only reports modification success after explicit tool success', () => {
    expect(NAVISWORKS_WORKSPACE_PROMPT).toContain(
      'Only report a modification as successful when the modifying tool explicitly returns success.',
    )
  })
})
