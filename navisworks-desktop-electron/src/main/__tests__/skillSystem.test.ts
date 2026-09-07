import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillMarkdown } from '../skill/skillParser'
import { SkillRegistry } from '../skill/skillRegistry'
import { SKILL_MAX_BYTES } from '../skill/limits'
import { ContextEngine } from '../context/contextEngine'
import { ContextEpochStore } from '../context/contextEpochStore'
import { contextRegistry } from '../context/contextRegistry'
import type { SkillRoots } from '../skill/paths'

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function skillFile(name: string, description: string, body = '# Steps\n1. do\n'): string {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', body].join('\n')
}

async function tempSkillRoots(): Promise<SkillRoots & { root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'curi-skills-'))
  const builtinDirectory = join(root, 'builtin')
  const userDirectory = join(root, 'user')
  await mkdir(builtinDirectory, { recursive: true })
  await mkdir(userDirectory, { recursive: true })
  return {
    builtinDirectory,
    userDirectory,
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function writeSkill(dir: string, name: string, text: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true })
  await writeFile(join(dir, name, 'SKILL.md'), text, 'utf8')
}

describe('skill parser (§89)', () => {
  it('Case 1: a valid SKILL.md parses name/description/body', () => {
    const parsed = parseSkillMarkdown(encode(skillFile('property-analysis', '批量分析属性。')))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.frontmatter.name).toBe('property-analysis')
    expect(parsed.body).toContain('# Steps')
  })

  it('Case 2: missing name → rejected', () => {
    const parsed = parseSkillMarkdown(encode('---\ndescription: x\n---\nbody'))
    expect(parsed.ok).toBe(false)
  })

  it('Case 3: illegal names rejected (uppercase, path chars, leading dash)', () => {
    for (const name of ['../x', 'A\\B', 'Property Analysis', '-lead', 'UPPER']) {
      expect(parseSkillMarkdown(encode(skillFile(name, 'd'))).ok).toBe(false)
    }
  })

  it('Case 4: description is REQUIRED this round', () => {
    expect(parseSkillMarkdown(encode('---\nname: model-inspection\n---\nbody')).ok).toBe(false)
  })

  it('Case 5: over-size files rejected', () => {
    const huge = skillFile('model-inspection', 'd', 'x'.repeat(SKILL_MAX_BYTES + 10))
    const parsed = parseSkillMarkdown(encode(huge))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('40000')
  })

  it('Case 6: UTF-8 Chinese parses intact', () => {
    const parsed = parseSkillMarkdown(encode(skillFile('model-inspection', '检查当前 Navisworks 文档、选择与视点。')))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.frontmatter.description).toContain('Navisworks')
  })
})

describe('skill registry (§90)', () => {
  it('Case 1/2: discovers built-in and user layers', async () => {
    const roots = await tempSkillRoots()
    try {
      await writeSkill(roots.builtinDirectory, 'model-inspection', skillFile('model-inspection', '内置'))
      await writeSkill(roots.userDirectory, 'my-workflow', skillFile('my-workflow', '用户'))
      const registry = new SkillRegistry(roots)
      await registry.discover()
      expect(registry.get('model-inspection')?.source).toBe('builtin')
      expect(registry.get('my-workflow')?.source).toBe('user')
    } finally {
      await roots.cleanup()
    }
  })

  it('Case 3: user overrides builtin with the same name', async () => {
    const roots = await tempSkillRoots()
    try {
      await writeSkill(roots.builtinDirectory, 'model-inspection', skillFile('model-inspection', '内置版本'))
      await writeSkill(roots.userDirectory, 'model-inspection', skillFile('model-inspection', '用户版本'))
      const registry = new SkillRegistry(roots)
      await registry.discover()
      const skill = registry.get('model-inspection')
      expect(skill?.source).toBe('user')
      expect(skill?.description).toBe('用户版本')
    } finally {
      await roots.cleanup()
    }
  })

  it('Case 4: list() is stable alphabetical regardless of fs order', async () => {
    const roots = await tempSkillRoots()
    try {
      for (const name of ['zebra-skill', 'alpha-skill', 'mid-skill']) {
        await writeSkill(roots.userDirectory, name, skillFile(name, 'd'))
      }
      const registry = new SkillRegistry(roots)
      await registry.discover()
      expect(registry.list().map((skill) => skill.name))
        .toEqual(['alpha-skill', 'mid-skill', 'zebra-skill'])
    } finally {
      await roots.cleanup()
    }
  })

  it('Case 5: one broken skill never affects the others', async () => {
    const roots = await tempSkillRoots()
    try {
      await writeSkill(roots.userDirectory, 'broken-skill', 'no frontmatter at all')
      await writeSkill(roots.userDirectory, 'good-skill', skillFile('good-skill', 'ok'))
      const registry = new SkillRegistry(roots)
      await registry.discover()
      expect(registry.get('broken-skill')).toBeUndefined()
      expect(registry.get('good-skill')).toBeDefined()
    } finally {
      await roots.cleanup()
    }
  })

  it('missing directories are simply empty layers (first run, nothing installed)', async () => {
    const registry = new SkillRegistry({
      builtinDirectory: join(tmpdir(), 'definitely-missing-builtin-skills'),
      userDirectory: join(tmpdir(), 'definitely-missing-user-skills'),
    })
    await registry.discover()
    expect(registry.list()).toHaveLength(0)
  })
})

describe('skills/manifest baseline source (§91/§93)', () => {
  const provider = (entries: { name: string; description: string }[]) => ({
    manifest: () => entries,
  })

  function prepareWith(sessionId: string, entries: { name: string; description: string }[]) {
    const engine = new ContextEngine(contextRegistry, undefined)
    return engine.prepare(sessionId, {
      sessionId,
      skillManifestProvider: provider(entries),
    })
  }

  it('manifest (name+description only) enters the baseline; skill BODY never does', async () => {
    const assembly = await prepareWith('s1', [{
      name: 'property-analysis',
      description: '批量读取比较属性。正文绝不进基线。',
    }])
    expect(assembly.baseline).toContain('可用 Skills')
    expect(assembly.baseline).toContain('property-analysis: 批量读取比较属性')
    // The BODY marker must be absent (§52: manifest carries no body).
    expect(assembly.baseline).not.toContain('# Steps')
  })

  it('no skills → the baseline contains no manifest header at all (§55)', async () => {
    const empty = await prepareWith('s2', [])
    expect(empty.baseline).not.toContain('可用 Skills')
    const withSkills = await prepareWith('s2', [{ name: 'x-skill', description: 'd' }])
    expect(withSkills.baselineHash).not.toBe(empty.baselineHash)
  })

  it('changing the skill SET (restart) changes baselineHash → baseline-changed rollover', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'curi-skill-epoch-'))
    try {
      const store = new ContextEpochStore(dir)
      const engine = new ContextEngine(contextRegistry, store)
      const before = await engine.prepare('s1', {
        sessionId: 's1',
        skillManifestProvider: provider([{ name: 'a-skill', description: 'A' }]),
      })
      await engine.commit(before.epoch)
      // A skill was added and the app restarted (new manifest):
      const after = await engine.prepare('s1', {
        sessionId: 's1',
        skillManifestProvider: provider([
          { name: 'a-skill', description: 'A' },
          { name: 'b-skill', description: 'B' },
        ]),
      })
      expect(after.status).toBe('rolled-over')
      expect(after.generation).toBe(before.generation + 1)
      // Same manifest again = same baselineHash (stability, §47).
      await engine.commit(after.epoch)
      const stable = await engine.prepare('s1', {
        sessionId: 's1',
        skillManifestProvider: provider([
          { name: 'a-skill', description: 'A' },
          { name: 'b-skill', description: 'B' },
        ]),
      })
      expect(stable.baselineHash).toBe(after.baselineHash)
      expect(stable.status).toBe('unchanged')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('built-in skills ship with the app (§51)', () => {
  it('model-inspection and property-analysis are valid, discoverable files', async () => {
    // vitest runs with the package root as cwd — the canonical source layout.
    const builtinDirectory = join(process.cwd(), 'resources', 'skills')
    const registry = new SkillRegistry({ builtinDirectory, userDirectory: join(tmpdir(), 'curi-empty-user-skills') })
    await registry.discover()
    const names = registry.list().map((skill) => skill.name)
    expect(names).toContain('model-inspection')
    expect(names).toContain('property-analysis')
    // Bodies exist but NEVER reach the model except via the skill tool.
    expect(registry.get('property-analysis')?.content).toContain('find_items')
  })
})
