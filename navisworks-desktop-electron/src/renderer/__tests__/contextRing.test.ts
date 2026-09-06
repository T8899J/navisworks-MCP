import { describe, expect, it } from 'vitest'
import { resolveContextRingState } from '../contextRing'

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
