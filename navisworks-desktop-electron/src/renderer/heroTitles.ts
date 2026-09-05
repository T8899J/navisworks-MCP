/**
 * Greeting lines for the new-conversation hero. One is drawn at random each
 * time the composer enters the hero variant (i.e. per fresh conversation),
 * so repeat visits do not read like a static banner.
 *
 * The hero is Curi's generic front door: no Navisworks vocabulary, no
 * capability lists, no self-introduction — connectivity is already shown
 * by the header chip. New lines must keep to that rule (enforced by test).
 */
export const HERO_TITLES = [
  '今天想做点什么？',
  '从哪里开始？',
  '说说你的想法。',
  '有什么想解决的？',
  '我们从问题开始。',
  '这次想做到哪一步？',
  '有件事想一起弄明白吗？',
  '想到什么就说。',
  '准备好了。',
  '开始吧。'
] as const

/** Draws one greeting line at random. */
export function pickHeroTitle(): string {
  const index = Math.floor(Math.random() * HERO_TITLES.length)
  // The index is always in range; the fallback just satisfies strict indexing.
  return HERO_TITLES[index] ?? HERO_TITLES[0]
}
