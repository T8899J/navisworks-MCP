/** A discovered + validated skill. `location` is main-only (§47). */
export interface SkillInfo {
  name: string
  description: string
  location: string
  source: 'builtin' | 'user'
  content: string
}

/** What a Context manifest / the skill tool exposes to the model. */
export interface SkillManifestEntry {
  name: string
  description: string
}
