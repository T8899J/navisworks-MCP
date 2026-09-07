import {
  SKILL_MAX_BYTES,
  SKILL_MAX_DESCRIPTION_CHARS,
  SKILL_NAME_PATTERN,
} from './limits'

/** A parsed, validated SKILL.md frontmatter (name + description only, §43). */
export interface ParsedSkillFrontmatter {
  name: string
  description: string
}

export type SkillParseResult =
  | { ok: true; frontmatter: ParsedSkillFrontmatter; body: string }
  | { ok: false; reason: string }

/**
 * Parse a SKILL.md (UTF-8 bytes supplied by the caller so the size cap is
 * enforced before decoding). The frontmatter is a minimal `key: value` block
 * delimited by `---` fences; ONLY `name` and `description` are read (§46 —
 * no YAML dependency for two fields). Unknown frontmatter keys are ignored.
 *
 * Any failure returns { ok: false } — the registry SKIPS the skill and keeps
 * the others, it never crashes discovery (§46/§90 Case 5).
 */
export function parseSkillMarkdown(bytes: Uint8Array): SkillParseResult {
  if (bytes.byteLength > SKILL_MAX_BYTES) {
    return { ok: false, reason: `SKILL.md 超过 ${SKILL_MAX_BYTES} 字节上限。` }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter === null) {
    return { ok: false, reason: '缺少 --- 包裹的 frontmatter 块。' }
  }
  const fields = parseFields(frontmatter)
  const name = fields.get('name')
  const description = fields.get('description')
  if (!name) return { ok: false, reason: 'frontmatter 缺少 name。' }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `name "${name}" 不符合小写 slug 规则。` }
  }
  if (!description) return { ok: false, reason: 'frontmatter 缺少 description（本轮必填）。' }
  const trimmedDescription = collapseWhitespace(description)
  if (!trimmedDescription) return { ok: false, reason: 'description 为空。' }
  if (trimmedDescription.length > SKILL_MAX_DESCRIPTION_CHARS) {
    return { ok: false, reason: `description 超过 ${SKILL_MAX_DESCRIPTION_CHARS} 字符上限。` }
  }
  return {
    ok: true,
    frontmatter: { name, description: trimmedDescription },
    body: body.trim(),
  }
}

function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  // Allow an optional leading BOM / blank line before the opening fence.
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  let start = 0
  while (start < lines.length && lines[start]!.trim() === '') start += 1
  if (start >= lines.length || lines[start]!.trim() !== '---') return { frontmatter: null, body: normalized }
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === '---') {
      return {
        frontmatter: lines.slice(start + 1, index).join('\n'),
        body: lines.slice(index + 1).join('\n'),
      }
    }
  }
  return { frontmatter: null, body: normalized }
}

function parseFields(frontmatter: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) {
      // Last write wins for duplicated keys — stable, no fs-order surprise.
      fields.set(match[1], stripQuotes(match[2].trim()))
    }
  }
  return fields
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
