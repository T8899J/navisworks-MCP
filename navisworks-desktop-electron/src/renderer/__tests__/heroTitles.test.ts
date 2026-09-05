import { describe, expect, it } from 'vitest'
import { HERO_TITLES, pickHeroTitle } from '../heroTitles'

// The hero is Curi's generic front door. Domain vocabulary must live in the
// header status chip and the capability prompt, never in the welcome line —
// this guard is what keeps it that way.
const FORBIDDEN_WORDS = ['Navisworks', '模型', '构件', '属性', '视点', '当前文档', '智能体']

describe('hero titles', () => {
  it('keeps every greeting free of Navisworks and capability vocabulary', () => {
    for (const title of HERO_TITLES) {
      for (const word of FORBIDDEN_WORDS) {
        expect(title).not.toContain(word)
      }
    }
  })

  it('keeps each line short and non-empty', () => {
    for (const title of HERO_TITLES) {
      expect(title.trim().length).toBeGreaterThan(0)
      expect([...title].length).toBeLessThanOrEqual(16)
    }
  })

  it('picks one of the defined lines', () => {
    expect(HERO_TITLES).toContain(pickHeroTitle())
  })
})
