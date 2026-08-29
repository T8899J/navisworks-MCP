/**
 * Greeting lines for the new-conversation hero. One is drawn at random each
 * time the composer enters the hero variant (i.e. per fresh conversation),
 * so repeat visits do not read like a static banner.
 */
export const HERO_TITLES = [
  '今天想做点什么？',
  '这次想在模型里解决什么？',
  '把任务交给我，剩下的我来。',
  '从哪一个视点开始检查？',
  '准备开工了，说说你的计划。',
  '有什么想问当前文档的？',
  '查属性、找构件、切视点，随时开口。',
  '说说看，这单工作要做到哪一步？',
  'Navisworks 已就位，等你指令。',
  '聊聊你的想法，我帮你落地。'
] as const

/** Draws one greeting line at random. */
export function pickHeroTitle(): string {
  const index = Math.floor(Math.random() * HERO_TITLES.length)
  // The index is always in range; the fallback just satisfies strict indexing.
  return HERO_TITLES[index] ?? HERO_TITLES[0]
}
