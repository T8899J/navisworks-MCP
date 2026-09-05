import { describe, expect, it } from 'vitest'
import * as promptModule from '../prompts'
import { CURI_CORE_PROMPT, NAVISWORKS_CAPABILITY_PROMPT } from '../prompts'

describe('agent prompts', () => {
  it('names Curi as the user-facing identity', () => {
    expect(CURI_CORE_PROMPT).toContain('Your name is Curi.')
    expect(CURI_CORE_PROMPT).toContain('refer to yourself simply as Curi.')
  })

  it('forbids self-classification as a general-purpose agent', () => {
    // The sentences that produced "我是 Curi，一个通用型智能体" must stay gone.
    expect(CURI_CORE_PROMPT).not.toContain('Curi is a general-purpose agent')
    expect(CURI_CORE_PROMPT).not.toContain('describe yourself as a general-purpose agent')
    expect(CURI_CORE_PROMPT).toContain('- general-purpose agent')
    expect(CURI_CORE_PROMPT).toContain('- do not give yourself a category or product label')
  })

  it('forbids assistant and similar product labels in self-introductions', () => {
    expect(CURI_CORE_PROMPT).toContain(
      'Do not classify or introduce yourself using product or system labels such as:',
    )
    for (const label of ['- assistant', '- AI assistant', '- chatbot', '- copilot']) {
      expect(CURI_CORE_PROMPT).toContain(label)
    }
  })

  it('forbids the Navisworks assistant label', () => {
    expect(CURI_CORE_PROMPT).toContain('- Navisworks assistant')
    expect(CURI_CORE_PROMPT).toContain('It does not make Curi a "Navisworks assistant."')
  })

  it('defines the introduction policy around the name alone', () => {
    expect(CURI_CORE_PROMPT).toContain('When the user asks who you are or asks you to introduce yourself:')
    expect(CURI_CORE_PROMPT).toContain('- say that you are Curi')
    expect(CURI_CORE_PROMPT).toContain('- respond naturally and briefly')
    expect(CURI_CORE_PROMPT).toContain('A normal introduction should feel like meeting Curi,')
    expect(CURI_CORE_PROMPT).toContain('- do not enumerate your internal capabilities unless the user asks')
    expect(CURI_CORE_PROMPT).toContain('- do not explain your system architecture')
    expect(CURI_CORE_PROMPT).toContain('- do not recite your design philosophy')
    expect(CURI_CORE_PROMPT).toContain('- do not describe your internal reasoning framework')
  })

  it('marks curiosity and creation as a silent internal operating principle', () => {
    expect(CURI_CORE_PROMPT).toContain('INTERNAL OPERATING PRINCIPLE')
    expect(CURI_CORE_PROMPT).toContain('These principles should influence your behavior silently.')
    expect(CURI_CORE_PROMPT).toContain(
      'Do not volunteer or recite them as Curi\'s "core",\n"philosophy", "mission", or self-description.',
    )
    // The old first-person identity framing must stay gone.
    expect(CURI_CORE_PROMPT).not.toContain('Curi is built around Curiosity')
  })

  it('keeps reasoning frameworks out of default self-description', () => {
    expect(CURI_CORE_PROMPT).toContain('Do not use internal reasoning frameworks as self-description.')
    expect(CURI_CORE_PROMPT).toContain('"I use first-principles thinking."')
    expect(CURI_CORE_PROMPT).toContain('Unless the user explicitly asks about your reasoning methods,')
    expect(CURI_CORE_PROMPT).toContain('let these principles remain implicit in the quality of the answer.')
  })

  it('keeps the full core reasoning and execution behavior', () => {
    expect(CURI_CORE_PROMPT).toContain('FIRST-PRINCIPLES THINKING')
    expect(CURI_CORE_PROMPT).toContain('INVERSION')
    expect(CURI_CORE_PROMPT).toContain('SOCRATIC REASONING')
    expect(CURI_CORE_PROMPT).toContain('MULTIDISCIPLINARY THINKING')
    expect(CURI_CORE_PROMPT).toContain('CHANGE THE FRAME WHEN STUCK')
    expect(CURI_CORE_PROMPT).toContain('QUESTION THE PROBLEM')
    expect(CURI_CORE_PROMPT).toContain('INDEPENDENT JUDGMENT')
    expect(CURI_CORE_PROMPT).toContain('FACTS AND UNCERTAINTY')
    expect(CURI_CORE_PROMPT).toContain('TOOLS')
    expect(CURI_CORE_PROMPT).toContain('EXECUTION')
    expect(CURI_CORE_PROMPT).toContain('MEMORY AND CONTEXT')
    expect(CURI_CORE_PROMPT).toContain('CORE PURPOSE')
  })

  it('adds the communication rule against explaining internal architecture', () => {
    expect(CURI_CORE_PROMPT).toContain("Do not explain Curi's identity, internal philosophy,")
    expect(CURI_CORE_PROMPT).toContain('the user explicitly asks for that information.')
    expect(CURI_CORE_PROMPT).toContain("Prefer demonstrating Curi's character through the response")
  })

  it('states that tools do not define Curi identity', () => {
    expect(CURI_CORE_PROMPT).toContain('They do not define what you are.')
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

  it('treats Navisworks as a capability without redefining Curi', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain(
      "Navisworks is one of Curi's currently available specialized capabilities.",
    )
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain("It does not change Curi's identity.")
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain(
      'When Navisworks is relevant, use the capability naturally without redefining Curi.',
    )
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('- do not describe Curi as a Navisworks assistant')
    // The identity sentence this replaces must stay gone.
    expect(NAVISWORKS_CAPABILITY_PROMPT).not.toContain('Curi remains a general-purpose agent')
  })

  it('keeps Navisworks out of introductions and unrelated conversation', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain(
      'When Navisworks is unrelated to the current conversation, do not mention it.',
    )
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain(
      'For greetings, introductions, casual conversation,\nand questions unrelated to current Navisworks state,\ndo not call Navisworks tools.',
    )
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain(
      'Mention Navisworks only when it is relevant to the user\'s question.',
    )
    expect(NAVISWORKS_CAPABILITY_PROMPT).not.toContain('You are operating in a Navisworks workspace.')
  })

  it('keeps the exact Navisworks tool names', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('navisworks_find_items')
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('navisworks_get_item_properties')
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('navisworks_list_viewpoints')
  })

  it('only reports modification success after explicit tool success', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain(
      'Only report a modification as successful when the modifying tool explicitly returns success.',
    )
  })

  it('routes greetings and introductions through the core prompt without Navisworks tools', () => {
    expect(NAVISWORKS_CAPABILITY_PROMPT).toContain('- follow CURI_CORE_PROMPT')
  })
})
