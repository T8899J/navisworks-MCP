import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * P19 skill roots. Built-in skills ship with the app; user skills live in the
 * data directory. NO network / git / home-directory scanning (§41/§104): only
 * these two roots are ever read, and ONLY the manifest + the single SKILL.md
 * the user names (§103).
 */
export interface SkillRoots {
  /** Built-in skills shipped with the application. */
  readonly builtinDirectory: string
  /** The user's own skills (data-directory/skills) — override built-in by name. */
  readonly userDirectory: string
}

/**
 * Locate the built-in skills directory across dev and a packaged Windows app:
 *   1. packaged:   process.resourcesPath/skills
 *   2. electron:   <app>/resources/skills
 *   3. dev/vitest: <package>/resources/skills  (walked up from this module)
 * The first EXISTING candidate wins; a path that does not exist simply yields
 * an empty built-in set (never a crash). `process.cwd()` is never trusted.
 */
export function resolveBuiltinSkillsDirectory(
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath: string | undefined = process.resourcesPath,
): string {
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'skills')
    if (existsSync(packaged)) return packaged
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // electron-builder / electron-packager layout (app/... + resources/skills)
    resolve(moduleDirectory, '..', 'resources', 'skills'),
    resolve(moduleDirectory, '..', '..', 'resources', 'skills'),
    resolve(moduleDirectory, '..', '..', '..', 'resources', 'skills'),
    resolve(moduleDirectory, '..', '..', '..', '..', 'resources', 'skills'),
    // explicit override for tests / unusual layouts
    env.NAVISWORKS_MCP_BUILTIN_SKILLS_DIR ?? '',
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  // Deterministic fallback (the canonical packaged location) → no built-ins.
  return resourcesPath ? join(resourcesPath, 'skills') : resolve(moduleDirectory, '..', '..', 'resources', 'skills')
}

export function skillRoots(
  dataDirectory: string,
  builtinDirectory: string = resolveBuiltinSkillsDirectory(),
): SkillRoots {
  return {
    builtinDirectory,
    userDirectory: join(dataDirectory, 'skills'),
  }
}
