import { describe, expect, it } from 'vitest'
import * as promptModule from '../prompts'
import { CURI_CORE_PROMPT, NAVISWORKS_CAPABILITY_PROMPT } from '../prompts'

describe('agent prompts', () => {
  it('defines Curi as a general-purpose agent', () => {
    expect(CURI_CORE_PROMPT).toContain('Curi is a general-purpose agent')
  })

  it('states that tools do not define Curi identity', () => {
    expect(CURI_CORE_PROMPT).toContain('They do not define what you are.')
  })

  it('states that Navisworks access does not make Curi a Navisworks assistant', () => {
    expect(CURI_CORE_PROMPT).toContain('It does not make Curi a "Navisworks assistant."')
  })

  it('includes introduction identity rules', () => {
    expect(CURI_CORE_PROMPT).toContain('When asked who you are or asked to introduce yourself:')
    expect(CURI_CORE_PROMPT).toContain('- describe yourself as a general-purpose agent')
    expect(CURI_CORE_PROMPT).toContain('- keep a normal introduction concise')
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

  it('exports the Navisworks capability prompt', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('NAVISWORKS CAPABILITY POLICY')
  })

  it('does not export the obsolete Navisworks workspace prompt', () => {
    expect(promptModule).not.toHaveProperty('NAVISWORKS_WORKSPACE_PROMPT')
  })

  it('states that Navisworks capabilities do not redefine Curi identity', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain(
      "These capabilities extend Curi's general-purpose abilities.\nThey do not redefine Curi's identity.",
    )
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('Curi remains a general-purpose agent.')
  })

  it('keeps the exact Navisworks search tool name', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('navisworks_find_items')
  })

  it('keeps the exact Navisworks property tool name', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('navisworks_get_item_properties')
  })

  it('keeps the exact Navisworks viewpoint tool name', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('navisworks_list_viewpoints')
  })

  it('only reports modification success after explicit tool success', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain(
      'Only report a modification as successful when the modifying tool explicitly returns success.',
    )
  })

  it('routes greetings and introductions through the core prompt without Navisworks tools', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain(
      'For greetings, introductions, casual conversation,\nand questions unrelated to current Navisworks state,\ndo not call Navisworks tools.',
    )
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('- follow CURI_CORE_PROMPT')
    expect(NAVISWORKS_CAPABILITY_PROMPT).not.toContain('You are operating in a Navisworks workspace.')
  })
})
