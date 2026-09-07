/**
 * P19 runtime policy constants — centralised so the caps are never scattered
 * as magic numbers across parser / registry / executor (§45/§99).
 */

/** A SKILL.md larger than this is rejected outright (keeps a skill body from
 *  bloating context; well under the ToolOutputStore inline threshold so a
 *  loaded skill is never truncated into a resultRef round-trip — §59). */
export const SKILL_MAX_BYTES = 40_000

/** Frontmatter description cap (~500 chars) — the manifest only carries this. */
export const SKILL_MAX_DESCRIPTION_CHARS = 500

/** Skill name: lowercase slug, 1–64 chars, no path separators (§44). */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
