import { describe, expect, it } from 'vitest'
import { normalizeModelInfo } from '../chatTypes'
import { resolveContextRingState } from '../contextRing'

// The reported bug: a per-model context override (1M) never reached the ring.
// Two whitelists in the renderer were involved — normalizeModelInfo clamped the
// metadataSource. This test locks the full renderer path: main returns a
// 'model'-sourced ModelInfo → normalizeModelInfo preserves it → the ring shows
// 1M / 模型自定义, not "Auto".
describe('Model Configuration v2 — the ring reflects a saved per-model window (§30/§33/§49)', () => {
  const mainResolvedModelInfo = {
    ref: { providerId: 'api:p1', modelId: 'glm-5.3-flash-free' },
    displayName: 'glm-5.3-flash-free',
    provider: { id: 'api:p1', displayName: 'P1', kind: 'openai-compatible' },
    capabilities: { tools: true, modalities: { input: ['text'], output: ['text'] } },
    limits: { context: 1_000_000, output: 128_000 },
    reasoning: { modes: ['low', 'medium', 'high', 'xhigh', 'max'] },
    metadataSource: 'model',
  }

  it('normalizeModelInfo preserves the "model" metadataSource (was coerced to unknown)', () => {
    const info = normalizeModelInfo(mainResolvedModelInfo)
    expect(info).not.toBeNull()
    expect(info?.metadataSource).toBe('model')
    expect(info?.limits.context).toBe(1_000_000)
  })

  it('with the normalized info, the ring shows 1M / 模型自定义 before any run', () => {
    const info = normalizeModelInfo(mainResolvedModelInfo)!
    // This mirrors exactly what Composer derives from activeModel.
    const ring = resolveContextRingState({
      usingApi: info.provider.kind === 'openai-compatible',
      usedTokens: 0,
      profileContextWindowTokens: null,
      configuredContextWindowTokens: 8192,
      activeModelContextWindow: info.limits.context,
      activeModelMetadataSource: info.metadataSource !== 'unknown'
        ? info.metadataSource as 'model'
        : undefined,
      activeModelRef: info.ref,
    })
    expect(ring.mode).toBe('known')
    expect(ring.total).toBe(1_000_000)
    expect(ring.sourceLabel).toBe('模型自定义')
    expect(ring.total).not.toBe(8192) // never the configured local fallback
  })
})
