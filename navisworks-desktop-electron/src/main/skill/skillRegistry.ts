import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkillMarkdown } from './skillParser'
import { SKILL_NAME_PATTERN } from './limits'
import type { SkillRoots } from './paths'
import type { SkillInfo, SkillManifestEntry } from './types'

/**
 * P19 Skill Registry: scans exactly the two known roots ONCE at startup
 * (§50 — no file watching, no hot reload), parses every `SKILL.md`, and keeps
 * the valid ones. A broken skill is skipped with a warning and never affects
 * the others (§90 Case 5). Listing is alphabetically stable (§49), and user
 * skills override built-in ones of the same name with a low-noise warning
 * (§48) — never filesystem-enumeration order.
 */
export class SkillRegistry {
  readonly #roots: SkillRoots
  readonly #skills = new Map<string, SkillInfo>()
  #discovered = false

  constructor(roots: SkillRoots) {
    this.#roots = roots
  }

  async discover(): Promise<void> {
    this.#skills.clear()
    const builtin = await this.#loadLayer('builtin', this.#roots.builtinDirectory)
    const user = await this.#loadLayer('user', this.#roots.userDirectory)
    // user > builtin: apply builtin first, then let user overwrite.
    for (const skill of [...builtin, ...user]) {
      const existing = this.#skills.get(skill.name)
      if (existing !== undefined && existing.source === 'builtin' && skill.source === 'user') {
        console.debug(`[skill] user overrides builtin: ${skill.name}`)
      }
      // Within one layer a stable pick: first alphabetical wins.
      if (existing === undefined || (existing.source === skill.source && skill.name < existing.name)) {
        this.#skills.set(skill.name, skill)
      }
    }
    this.#discovered = true
    console.debug(`[skill] discovered count=${this.#skills.size}`)
  }

  isDiscovered(): boolean {
    return this.#discovered
  }

  list(): readonly SkillInfo[] {
    return [...this.#skills.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): SkillInfo | undefined {
    return this.#skills.get(name)
  }

  require(name: string): SkillInfo {
    const skill = this.#skills.get(name)
    if (skill === undefined) throw new Error(`Skill 不存在：${name}`)
    return skill
  }

  /** Manifest entries (name + description ONLY, never body/location — §52). */
  manifest(): readonly SkillManifestEntry[] {
    return this.list().map((skill) => ({ name: skill.name, description: skill.description }))
  }

  async #loadLayer(source: 'builtin' | 'user', directory: string): Promise<SkillInfo[]> {
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return []
    }
    // Sort first so a duplicate-name pick within a layer is deterministic.
    const loaded: SkillInfo[] = []
    for (const entry of [...entries].sort()) {
      const location = join(directory, entry, 'SKILL.md')
      let bytes: Uint8Array
      try {
        bytes = await readFile(location)
      } catch {
        // A root entry without a readable SKILL.md is simply not a skill.
        continue
      }
      const parsed = parseSkillMarkdown(bytes)
      if (!parsed.ok) {
        console.warn(`[skill] 跳过 ${source}/${entry}：${parsed.reason}`)
        continue
      }
      // Defense in depth: the parsed name must match its own directory too.
      if (!SKILL_NAME_PATTERN.test(parsed.frontmatter.name) || parsed.frontmatter.name !== entry) {
        console.warn(`[skill] 跳过 ${source}/${entry}：name 与目录名不一致或非法。`)
        continue
      }
      loaded.push({
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        location,
        source,
        content: parsed.body,
      })
    }
    return loaded
  }
}
