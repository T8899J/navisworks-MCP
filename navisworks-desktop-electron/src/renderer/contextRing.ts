import type { ContextWindowSource } from '../shared/ipc'

export type { ContextWindowSource }

export interface ContextRingInput {
  usingApi: boolean
  usedTokens: number
  /** Window the last finished run budgeted against (chat.done). */
  reportedWindow?: number
  reportedSource?: ContextWindowSource
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
export function resolveContextRingState(input: ContextRingInput): ContextRingState {
  const used = Math.max(0, input.usedTokens)
  const reported = input.reportedWindow !== undefined
    && input.reportedWindow > 0
    && input.reportedSource !== undefined
  if (reported) {
    return measuredState(input.reportedSource!, input.reportedWindow!, used)
  }

  // No finished run reported a window for this session yet.
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

  // Local before the first report: the runtime's own clamp is the real window.
  const localWindow = Math.min(Math.max(1024, input.configuredContextWindowTokens), 32_768)
  return measuredState('local', localWindow, used)
}
