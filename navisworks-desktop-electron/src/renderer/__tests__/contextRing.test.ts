import { describe, expect, it } from 'vitest'
import { formatCacheRateLabel, formatTokenCount, resolveContextRingState } from '../contextRing'

const BASE_API_INPUT = {
  usingApi: true,
  usedTokens: 18_600,
  profileContextWindowTokens: null,
  configuredContextWindowTokens: 32_768,
}

describe('resolveContextRingState — measured sources', () => {
  it('profile source reads "API 配置窗口" (场景 A: 18K / 128K)', () => {
    const state = resolveContextRingState({
      ...BASE_API_INPUT,
      reportedWindow: 128_000,
      reportedSource: 'profile',
    })
    expect(state.mode).toBe('known')
    expect(state.total).toBe(128_000)
    expect(state.sourceLabel).toBe('API 配置窗口')
    expect(state.title).toContain('128K')
    expect(state.title).toContain('API 配置窗口')
    expect(state.percent).toBeGreaterThan(0)
  })

  it('provider source reads "服务端报告窗口" (场景 B: 18K / 200K)', () => {
    const state = resolveContextRingState({
      ...BASE_API_INPUT,
      reportedWindow: 200_000,
      reportedSource: 'provider',
    })
    expect(state.total).toBe(200_000)
    expect(state.sourceLabel).toBe('服务端报告窗口')
    expect(state.title).toContain('服务端报告窗口')
  })

  it('local source reads "本地上下文窗口"', () => {
    const state = resolveContextRingState({
      usingApi: false,
      usedTokens: 18_600,
      reportedWindow: 32_768,
      reportedSource: 'local',
      profileContextWindowTokens: null,
      configuredContextWindowTokens: 32_768,
    })
    expect(state.sourceLabel).toBe('本地上下文窗口')
    expect(state.title).toContain('本地上下文窗口')
  })

  it('an unattributed reported window is ignored rather than misrepresented', () => {
    // A done event from an older build has no source: without attribution the
    // ring must not invent a claim — it falls through to the pre-run state.
    const state = resolveContextRingState({ ...BASE_API_INPUT, reportedWindow: 32_768 })
    expect(state.mode).toBe('auto')
    expect(state.total).toBeNull()
  })
})

describe('resolveContextRingState — fallback is a safety budget (Case 6, 场景 C)', () => {
  it('says 安全预算 and 模型真实上限未知, never claims a model maximum', () => {
    const state = resolveContextRingState({
      ...BASE_API_INPUT,
      reportedWindow: 32_768,
      reportedSource: 'fallback',
    })
    expect(state.mode).toBe('known')
    expect(state.total).toBe(32_768)
    expect(state.sourceLabel).toBe('安全预算')
    expect(state.title).toContain('安全预算')
    expect(state.title).toContain('模型真实上限未知')
    // The forbidden claims must be absent from every user-visible string.
    expect(state.title).not.toContain('模型最大上下文')
    expect(state.title).not.toContain('模型上下文窗口')
  })
})

describe('resolveContextRingState — pre-run states (Case 7/8 UI, 场景 D)', () => {
  it('API profile with a fixed window shows it as 配置窗口 before any run', () => {
    const state = resolveContextRingState({
      ...BASE_API_INPUT,
      usedTokens: 0,
      profileContextWindowTokens: 128_000,
    })
    expect(state.mode).toBe('known')
    expect(state.total).toBe(128_000)
    expect(state.sourceLabel).toBe('API 配置窗口')
    expect(state.usedTokens).toBe(0)
    expect(state.percent).toBe(0)
  })

  it('API profile Auto with no run shows Auto / 未确定 — never a borrowed 32K', () => {
    const state = resolveContextRingState({
      ...BASE_API_INPUT,
      usedTokens: 0,
      profileContextWindowTokens: null,
      configuredContextWindowTokens: 32_768,
    })
    expect(state.mode).toBe('auto')
    expect(state.total).toBeNull()
    expect(state.sourceLabel).toBe('Auto')
    expect(state.title).toContain('Auto')
    expect(state.title).toContain('等待运行时确定')
    expect(state.title).toContain('安全预算')
    // The configured fallback value must NOT leak in as a displayed total.
    expect(state.total).not.toBe(32_768)
  })

  it('local mode never shows Auto: the local clamp is the real window', () => {
    const state = resolveContextRingState({
      usingApi: false,
      usedTokens: 0,
      profileContextWindowTokens: null,
      configuredContextWindowTokens: 16_384,
    })
    expect(state.mode).toBe('known')
    expect(state.total).toBe(16_384)
    expect(state.sourceLabel).toBe('本地上下文窗口')
  })
})

describe('resolveContextRingState — Model Configuration v2: the ring follows the ACTIVE model (§49 A–D)', () => {
  const QWEN_REF = { providerId: 'api:x', modelId: 'qwen3.8-max' }
  const OTHER_REF = { providerId: 'api:x', modelId: 'qwen-plus' }

  it('Case A: a stale 32K fallback is superseded by the current 1M active model', () => {
    const state = resolveContextRingState({
      ...BASE_API_INPUT,
      // The LAST finished run reported a 32K fallback…
      reportedWindow: 32_768, reportedSource: 'fallback',
      // …but the CURRENT active model is configured to 1M → the ring shows 1M.
      activeModelContextWindow: 1_000_000, activeModelMetadataSource: 'model',
      activeModelRef: QWEN_REF, reportedModelRef: QWEN_REF,
    })
    expect(state.total).toBe(1_000_000)
    expect(state.sourceLabel).toBe('模型自定义')
    expect(state.total).not.toBe(32_768)
  })

  it('Case B: a saved override flips the ring to 1M BEFORE any new run', () => {
    const state = resolveContextRingState({
      ...BASE_API_INPUT,
      usedTokens: 0,
      // No reportedWindow at all — only the freshly-resolved active model.
      profileContextWindowTokens: null,
      activeModelContextWindow: 1_000_000, activeModelMetadataSource: 'model',
      activeModelRef: QWEN_REF,
    })
    expect(state.mode).toBe('known')
    expect(state.total).toBe(1_000_000)
    expect(state.sourceLabel).toBe('模型自定义')
  })

  it('Case C: a finished run reports window=1M source=model', () => {
    const state = resolveContextRingState({
      ...BASE_API_INPUT,
      reportedWindow: 1_000_000, reportedSource: 'model', reportedModelRef: QWEN_REF,
      activeModelContextWindow: 1_000_000, activeModelMetadataSource: 'model', activeModelRef: QWEN_REF,
    })
    expect(state.total).toBe(1_000_000)
    expect(state.sourceLabel).toBe('模型自定义')
  })

  it('Case D: switching models drops a stale window from the previous model', () => {
    // No active window known yet (model just switched); the reported 1M belongs
    // to the PREVIOUS model, so it must NOT be shown for the new one.
    const state = resolveContextRingState({
      ...BASE_API_INPUT,
      usedTokens: 0,
      profileContextWindowTokens: null,
      reportedWindow: 1_000_000, reportedSource: 'model', reportedModelRef: QWEN_REF,
      activeModelRef: OTHER_REF, // different model → stale report rejected
    })
    expect(state.total).not.toBe(1_000_000)
    expect(state.mode).toBe('auto')
  })

  it('the reported window is trusted when it belongs to the current model', () => {
    const state = resolveContextRingState({
      ...BASE_API_INPUT,
      reportedWindow: 200_000, reportedSource: 'provider', reportedModelRef: OTHER_REF,
      activeModelRef: OTHER_REF, // match → usable even without an active context number
    })
    expect(state.total).toBe(200_000)
  })
})

describe('formatTokenCount (§62)', () => {
  it('renders K/M units with honest decimals', () => {
    expect(formatTokenCount(1_234)).toBe('1.2K')
    expect(formatTokenCount(860)).toBe('860')
    expect(formatTokenCount(128_000)).toBe('128K')
    expect(formatTokenCount(12_300)).toBe('12.3K')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
    expect(formatTokenCount(2_000_000)).toBe('2M')
    expect(formatTokenCount(0)).toBe('0')
  })
})

describe('formatCacheRateLabel — the three cases stay distinct (§32, §62)', () => {
  it('undefined means NOT REPORTED, not 0%', () => {
    expect(formatCacheRateLabel(undefined)).toBe('未报告')
  })
  it('a reported 0 shows as 0%', () => {
    expect(formatCacheRateLabel(0)).toBe('0%')
  })
  it('fraction rates render with at most one decimal', () => {
    expect(formatCacheRateLabel(0.5)).toBe('50%')
    expect(formatCacheRateLabel(2 / 3)).toBe('66.7%')
    expect(formatCacheRateLabel(0.6991150442)).toBe('69.9%')
  })
})
