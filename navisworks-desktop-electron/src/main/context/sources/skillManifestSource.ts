import type { ContextSource } from '../types'
import { canonicalFingerprint } from '../contextHash'
import type { SkillManifestEntry } from '../../skill/types'

/**
 * Baseline source `skills/manifest`: the ONLY skill information in the stable
 * prefix — name + description per skill, never a body (§52/§7). Because the
 * skill set is discovered once per process, this block's bytes are stable for
 * the whole run; when a user adds/removes a skill and restarts, the manifest
 * (hence baseline) changes and the ContextEngine rolls the epoch over (§53/§93).
 */
export const skillManifestSource: ContextSource<SkillManifestEntry[]> = {
  key: 'skills/manifest',
  version: 1,
  mode: 'baseline',
  load(env) {
    const provider = env.skillManifestProvider
    if (provider === undefined) return undefined
    const entries = provider.manifest()
    // No skills → contribute NOTHING to the baseline (never an empty header — §55).
    return entries.length === 0 ? undefined : [...entries]
  },
  fingerprint(value) {
    return canonicalFingerprint(value)
  },
  render(value) {
    const lines = value
      .map((entry) => `- ${entry.name}: ${entry.description}`)
      .join('\n')
    return `## 可用 Skills（需要时调用 skill 工具按名称加载完整说明，仅在任务与描述匹配时使用）\n${lines}`
  },
}
