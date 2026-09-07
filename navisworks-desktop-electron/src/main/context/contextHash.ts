import { createHash } from 'node:crypto'

/**
 * SHA-256 over UTF-8 bytes — the baseline/prefix hashing function.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Canonical JSON: object keys sorted recursively, arrays keep order,
 * undefined fields dropped. Feeding this to SHA-256 gives a fingerprint that
 * is immune to key-order and whitespace drift (Invariants A/C).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null'
}

export function canonicalFingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/**
 * The stable-prefix hash: baseline + epoch seed + every durable update text,
 * joined in order. Volatile working context, conversation and the current
 * user turn NEVER enter this hash (§45) — if it changes, something that the
 * provider could have cached genuinely changed.
 */
export function computePrefixHash(input: {
  baseline: string
  seedText: string | null
  updateTexts: readonly string[]
}): string {
  const parts = [
    `baseline\u0000${sha256Hex(input.baseline)}`,
    `seed\u0000${input.seedText === null ? '' : sha256Hex(input.seedText)}`,
    ...input.updateTexts.map((text, index) => `update.${index}\u0000${sha256Hex(text)}`),
  ]
  return sha256Hex(parts.join('\n'))
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry === undefined ? null : entry))
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry === undefined) continue
      out[key] = canonicalize(entry)
    }
    return out
  }
  return value
}
