import type { ContextWindowSource, ModelRef } from '../shared/ipc'

export type { ContextWindowSource }

export interface ContextRingInput {
  /**
   * `null` = the active model's provider is NOT yet known (main has not
   * resolved it): the ring must show a neutral Auto state and NEVER guess by
   * re-deriving provider routing from settings (P8.5).
   */
  usingApi: boolean | null
  usedTokens: number
  /** Window the last finished run budgeted against (chat.done). */
  reportedWindow?: number
  reportedSource?: ContextWindowSource
  /**
   * The ModelRef the `reportedWindow`/`reportedSource` came from (chat.done
   * modelRef). A reported window is only trusted for THAT model — switching the
   * active model invalidates a stale window immediately (§31/§32), so a saved
   * 1M never keeps showing the previous run's 32K.
   */
  reportedModelRef?: ModelRef
  /**
   * Model Configuration v2 (§33): the CURRENT active model's known context
   * window (ModelInfo.limits.context) + its metadata source, resolved by main.
   * When present it outranks profile/settings guessing so the ring shows the
   * truth the moment a config is saved — WITHOUT needing a new message first.
   */
  activeModelContextWindow?: number
  activeModelMetadataSource?: ContextWindowSource
  /** The CURRENT active model's identity (activeModel.ref). */
  activeModelRef?: ModelRef
  /** Active API profile's fixed window; null = profile Auto. */
  profileContextWindowTokens: number | null
  /** settings.contextWindowTokens — local default / fallback budget. */
  configuredContextWindowTokens: number
}

export interface ContextRingState {
  /**
   * 'auto' = the window is genuinely UNKNOWN (API profile Auto, no finished
   * run yet): the ring shows no number and never pretends to know one.
   */
  mode: 'auto' | 'known'
  /** Window the ring displays; null in auto mode. */
  total: number | null
  usedTokens: number
  percent: number
  /** Short ring title (span title attribute). */
  title: string
  /** 来源 label for the popover's window-origin row. */
  sourceLabel: string
}

const SOURCE_LABELS: Record<ContextWindowSource, string> = {
  // Model Configuration v2 (§22): an explicit per-model override — the user's
  // own number, shown immediately on save without waiting for a new run.
  model: '模型自定义',
  local: '本地上下文窗口',
  profile: 'API 配置窗口',
  provider: '服务端报告窗口',
  // NOT a model limit: this number only exists to keep budgeting safe when
  // nobody knows the real window.
  fallback: '安全预算',
}

function formatK(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}K`
}

/**
 * Usage labels for the popover: 1234 → "1.2K", 128000 → "128K",
 * 1_500_000 → "1.5M", 860 → "860". Whole K/M values drop the decimal.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}K`
  return String(tokens)
}

/**
 * Cache rate label — the three cases must stay STRICTLY distinct (§32):
 * undefined = never reported ("未报告", NOT "0%"), 0 = reported-zero ("0%"),
 * 0.5 → "50%", 0.6667 → "66.7%".
 */
export function formatCacheRateLabel(rate: number | undefined): string {
  if (rate === undefined) return '未报告'
  const percent = rate * 100
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`
}

function measuredState(
  source: ContextWindowSource,
  window: number,
  used: number,
): ContextRingState {
  const sourceLabel = SOURCE_LABELS[source]
  return {
    mode: 'known',
    total: window,
    usedTokens: used,
    percent: used > 0 ? Math.min(100, (used / window) * 100) : 0,
    title: source === 'fallback'
      ? `上下文窗口 ${formatK(window)} · 安全预算（模型真实上限未知）`
      : `上下文窗口 ${formatK(window)} · ${sourceLabel}`,
    sourceLabel,
  }
}

/**
 * Decide what the composer's context ring should say. The ring must never
 * present a fallback budget as the model's real context window, and in API
 * Auto mode with no finished run it must show an honest "unknown" state.
 */
/** Two ModelRefs that belong to the same model (§31). */
function sameModelRef(a?: ModelRef, b?: ModelRef): boolean {
  return a !== undefined && b !== undefined && a.providerId === b.providerId && a.modelId === b.modelId
}

export function resolveContextRingState(input: ContextRingInput): ContextRingState {
  const used = Math.max(0, input.usedTokens)
  // §33 FIRST: the CURRENT active model's known window is the truth. When a
  // ModelConfiguration (1M) is saved, main re-resolves activeModel, so the ring
  // flips to 1M IMMEDIATELY — no new message required. This outranks a stale
  // reportedWindow from a previous run.
  const activeWindow = input.activeModelContextWindow
  if (activeWindow !== undefined && activeWindow > 0 && input.activeModelMetadataSource !== undefined) {
    return measuredState(input.activeModelMetadataSource, activeWindow, used)
  }
  // No active model resolved yet (or it truly knows no window): only THEN fall
  // back to a run-reported window — and only when it belongs to the CURRENT
  // model. A 32K window reported for a since-switched model is stale (§31/§32)
  // and must NOT be shown.
  const reported = input.reportedWindow !== undefined
    && input.reportedWindow > 0
    && input.reportedSource !== undefined
    && (input.activeModelRef === undefined || sameModelRef(input.reportedModelRef, input.activeModelRef))
  if (reported) {
    return measuredState(input.reportedSource!, input.reportedWindow!, used)
  }

  // Nothing resolved this session yet.
  if (input.usingApi === null) {
    return {
      mode: 'auto',
      total: null,
      usedTokens: used,
      percent: 0,
      title: '上下文窗口：未确定（等待模型解析完成）',
      sourceLabel: '未确定',
    }
  }
  if (input.usingApi) {
    if (input.profileContextWindowTokens != null) {
      return measuredState('profile', input.profileContextWindowTokens, used)
    }
    return {
      mode: 'auto',
      total: null,
      usedTokens: used,
      percent: 0,
      title: '上下文窗口：Auto（等待运行时确定——将根据 API 配置或 Provider 能力确定，无法确定时使用安全预算）',
      sourceLabel: 'Auto',
    }
  }

  // Local before a window is known: the configured local budget, clamped to the
  // SANE range only (Model Configuration v2 §36: 32K is a default, not a cap).
  const localWindow = Math.max(1024, Math.trunc(input.configuredContextWindowTokens))
  return measuredState('local', localWindow, used)
}
