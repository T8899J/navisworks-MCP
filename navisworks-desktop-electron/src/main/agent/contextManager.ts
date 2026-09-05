import type { ChatMessage } from '../model/types'
import type { AgentToolContract } from '../toolCatalog'
import type { BuiltAgentRequest } from './contextTypes'
import {
  contextFramesToMessages,
  messagesToContextFrames,
  type ContextFrame,
} from './contextFrames'
import { computeContextBudget, estimateTokens } from './tokenBudget'

export const CONTEXT_SOFT_PRESSURE_RATIO = 0.80
export const CONTEXT_COMPACT_TRIGGER_RATIO = 0.85
const COMPACT_KEEP_RECENT_FRAMES = 1
const COMPACT_MIN_COMPRESSIBLE_FRAMES = 2
export const COMPACT_MAX_TRANSCRIPT_CHARS = 30_000
export const LOCAL_MAX_CONTEXT_TOKENS = 32_768

export type ContextPressure = 'idle' | 'soft' | 'compact'
export type ContextBlockKind = 'document-transition' | 'semantic-memory' | 'compact-summary' | 'verified-facts' | 'reference-set' | 'recall' | 'task-state' | 'other'

export interface ContextBlock {
  message: ChatMessage
  kind: ContextBlockKind
}

const DEFAULT_COMPACT_SYSTEM_PROMPT =
  '你是会话压缩器。把提供的对话与工具过程压缩为一份简洁的工作摘要，必须保留：用户目标、'
  + '已验证的关键事实（构件 ID、名称、数量、属性要点）、已执行的操作及结果、重要错误、未完成的步骤。'
  + '不要编造，不要添加建议，只输出摘要本身。'

const DEFAULT_PROVIDER_OVERHEAD = 256
const DEFAULT_SAFETY_MARGIN = 512

export function clampLocalContextWindow(configured: number): number {
  return Math.min(Math.max(1024, Math.trunc(configured)), LOCAL_MAX_CONTEXT_TOKENS)
}

export function providerSendsContextWindow(
  providerKind: string,
  windowFinite: boolean,
  effectiveWindow: number,
): boolean {
  return windowFinite && providerKind === 'ollama' && effectiveWindow > 0
}

export interface CompactConfig {
  keepRecentFrames?: number
  minCompressibleFrames?: number
  maxTranscriptChars?: number
  systemPrompt?: string
  summarizerModel: string
  signal?: AbortSignal
  summarize: (messages: ChatMessage[]) => Promise<string>
  onSummary?: (summary: string) => void
}

export interface BuildRequestInput {
  systemPrompt: string
  history: readonly ChatMessage[]
  currentInput: string
  tools: readonly AgentToolContract[]
  temperature: number
  maxTokens: number
  effectiveWindow: number
  inFlight?: readonly ChatMessage[]
  alreadyCompacted?: boolean
  compactSummary?: string
  verifiedFactsBlock?: string
  sendContextWindow?: boolean
}

/**
 * Owns the exact model-visible frame sequence for one run. The current user turn and all
 * tool exchanges created after it are protected: budgeting and compaction can only remove
 * complete historical frames, never one side of a tool call/result exchange.
 */
export class ContextManager {
  readonly #systemPrompt: string
  readonly #frames: ContextFrame[] = []
  readonly #contextBlocks: ContextBlock[] = []
  #protectedFrameStart: number
  #compacted = false

  constructor(options: {
    systemPrompt: string
    history?: readonly ChatMessage[]
    contextBlocks?: readonly (ChatMessage | ContextBlock)[]
  }) {
    this.#systemPrompt = options.systemPrompt
    this.#frames.push(...messagesToContextFrames(options.history ?? []))
    this.#protectedFrameStart = this.#frames.length
    this.#contextBlocks.push(...(options.contextBlocks ?? []).map((block) =>
      'message' in block && 'kind' in block
        ? { message: { ...block.message }, kind: block.kind }
        : { message: { ...block }, kind: 'other' as const },
    ))
  }

  addContextBlock(message: ChatMessage, kind: ContextBlockKind = 'other'): void {
    if (message.role !== 'system') throw new Error('Context block must be a system message.')
    this.#contextBlocks.push({ message: { ...message }, kind })
  }

  /**
   * Singleton block per kind: a repeated set for the same kind REPLACES the
   * previous block in place instead of stacking. task-state uses this so every
   * task update refreshes one block rather than accumulating stale ones.
   */
  setSingletonContextBlock(kind: ContextBlockKind, message: ChatMessage): void {
    if (message.role !== 'system') throw new Error('Context block must be a system message.')
    const existing = this.#contextBlocks.find((block) => block.kind === kind)
    if (existing !== undefined) {
      existing.message = { ...message }
      return
    }
    this.#contextBlocks.push({ message: { ...message }, kind })
  }

  addUserTurn(message: ChatMessage): void {
    if (message.role !== 'user') throw new Error('User turn must have role=user.')
    this.#protectedFrameStart = this.#frames.length
    this.#frames.push({ type: 'user', message: { ...message } })
  }

  addToolExchange(assistant: ChatMessage, results: readonly ChatMessage[]): void {
    const toolCallIds = assistant.toolCalls?.map((call) => call.id) ?? []
    const resultIds = new Set(results.map((message) => message.toolCallId))
    if (assistant.role !== 'assistant' || toolCallIds.length === 0) {
      throw new Error('Tool exchange requires an assistant message with tool calls.')
    }
    if (toolCallIds.some((id) => !resultIds.has(id))) {
      throw new Error('Tool exchange is incomplete: every tool call requires one result.')
    }
    this.#frames.push({
      type: 'tool-exchange',
      assistant: { ...assistant },
      results: results.map((message) => ({ ...message })),
      toolCallIds,
    })
  }

  get frames(): readonly ContextFrame[] {
    return this.#frames
  }

  estimateRequestTokens(tools: readonly AgentToolContract[], maxTokens: number): number {
    const messages = this.#allMessages(this.#frames)
    return estimateMessages(messages)
      + estimateTools(tools)
      + maxTokens
      + DEFAULT_PROVIDER_OVERHEAD
      + DEFAULT_SAFETY_MARGIN
  }

  /** Production request assembly. All trimming is performed over complete ContextFrames. */
  assembleBudgetedFrames(input: {
    tools: readonly AgentToolContract[]
    temperature: number
    maxTokens: number
    effectiveWindow: number
    sendContextWindow: boolean
    providerOverhead?: number
    safetyMargin?: number
  }): BuiltAgentRequest {
    const providerOverhead = input.providerOverhead ?? DEFAULT_PROVIDER_OVERHEAD
    const safetyMargin = input.safetyMargin ?? DEFAULT_SAFETY_MARGIN
    const contextBudget = computeContextBudget({
      effectiveContextWindow: input.effectiveWindow,
      outputReserve: input.maxTokens,
      providerOverhead,
      safetyMargin,
    })
    const toolSchemaTokens = estimateTools(input.tools)
    const kept = [...this.#frames]
    const protectedFrames = new Set(this.#frames.slice(this.#protectedFrameStart))
    let messages = this.#allMessages(kept)
    let dropped = 0

    while (estimateMessages(messages) + toolSchemaTokens > contextBudget) {
      const removableIndex = kept.findIndex((frame) => !protectedFrames.has(frame))
      if (removableIndex < 0) break
      kept.splice(removableIndex, 1)
      dropped += 1
      messages = this.#allMessages(kept)
    }

    const sampling = {
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      ...(input.sendContextWindow ? { contextWindow: input.effectiveWindow } : {}),
    }
    const systemTokens = estimateTokens(this.#systemPrompt)
    const tokensFor = (...kinds: ContextBlockKind[]): number => this.#contextBlocks.reduce(
      (sum, block) => sum + (kinds.includes(block.kind) ? estimateMessage(block.message) : 0),
      0,
    )
    const recentFrameTokens = kept.reduce(
      (sum, frame) => sum + contextFramesToMessages([frame]).reduce(
        (inner, message) => inner + estimateMessage(message),
        0,
      ),
      0,
    )

    return {
      messages,
      tools: [...input.tools],
      sampling,
      report: {
        contextWindow: input.effectiveWindow,
        estimatedInputTokens: estimateMessages(messages) + toolSchemaTokens,
        outputReserve: input.maxTokens,
        safetyMargin,
        systemTokens,
        toolSchemaTokens,
        semanticMemoryTokens: tokensFor('semantic-memory', 'compact-summary'),
        workingStateTokens: tokensFor('document-transition'),
        verifiedFactTokens: tokensFor('verified-facts', 'reference-set', 'recall'),
        recentFrameTokens,
        framesIncluded: kept.length,
        framesDropped: dropped,
        compacted: this.#compacted,
      },
    }
  }

  /**
   * Summarize complete historical frames only. The current turn and every in-flight tool
   * exchange stay verbatim; a failed summarizer leaves the frame list untouched.
   */
  async tryCompact(config: CompactConfig): Promise<boolean> {
    const keep = config.keepRecentFrames ?? COMPACT_KEEP_RECENT_FRAMES
    const min = config.minCompressibleFrames ?? COMPACT_MIN_COMPRESSIBLE_FRAMES
    const completedCurrentFrames = this.#frames.slice(this.#protectedFrameStart + 1)
    const currentCompressibleCount = completedCurrentFrames.length - keep
    const compactStart = currentCompressibleCount >= min ? this.#protectedFrameStart + 1 : 0
    const sourceFrames = currentCompressibleCount >= min
      ? completedCurrentFrames
      : this.#frames.slice(0, this.#protectedFrameStart)
    const compressibleCount = sourceFrames.length - keep
    if (compressibleCount < min) return false
    const compressible = sourceFrames.slice(0, compressibleCount)
    const transcript = contextFramesToMessages(compressible)
      .map((message) => {
        const calls = message.toolCalls?.map((call) => call.name).join(', ')
        const label = calls ? `${message.role}（工具: ${calls}）` : message.role
        return `[${label}] ${message.content || '（无文本）'}`
      })
      .join('\n\n')

    let summary: string
    try {
      summary = (await config.summarize([
        { role: 'system', content: config.systemPrompt ?? DEFAULT_COMPACT_SYSTEM_PROMPT },
        { role: 'user', content: clip(transcript, config.maxTranscriptChars ?? COMPACT_MAX_TRANSCRIPT_CHARS) },
      ])).trim()
    } catch {
      return false
    }
    if (!summary) return false

    this.#frames.splice(compactStart, compressibleCount, {
      type: 'compact-summary',
      message: {
        role: 'system',
        content: `以下是本任务早期过程的压缩摘要（对应原始帧已移除）：\n${summary}\n以上为摘要；后续工具结果为最新事实。`,
      },
    })
    if (compactStart === 0) this.#protectedFrameStart -= compressibleCount - 1
    this.#compacted = true
    config.onSummary?.(summary)
    return true
  }

  static compactTriggerRatio(): number {
    return CONTEXT_COMPACT_TRIGGER_RATIO
  }

  static contextPressure(usageTokens: number, effectiveWindow: number): ContextPressure {
    if (!Number.isFinite(effectiveWindow) || effectiveWindow <= 0) return 'idle'
    const ratio = usageTokens / effectiveWindow
    if (ratio >= CONTEXT_COMPACT_TRIGGER_RATIO) return 'compact'
    if (ratio >= CONTEXT_SOFT_PRESSURE_RATIO) return 'soft'
    return 'idle'
  }

  #allMessages(frames: readonly ContextFrame[]): ChatMessage[] {
    return [
      { role: 'system', content: this.#systemPrompt },
      ...this.#contextBlocks.map((block) => ({ ...block.message })),
      ...contextFramesToMessages(frames),
    ]
  }
}

/** Stateless helper retained for manual /compact and focused tests. */
export function buildAgentRequest(input: BuildRequestInput): BuiltAgentRequest {
  const contextBlocks: ContextBlock[] = []
  if (input.compactSummary?.trim()) {
    contextBlocks.push({
      kind: 'compact-summary',
      message: {
        role: 'system',
        content: `早期对话摘要（供参考，非实时事实）：\n${input.compactSummary.trim()}`,
      },
    })
  }
  if (input.verifiedFactsBlock?.trim()) {
    contextBlocks.push({
      kind: 'verified-facts',
      message: { role: 'system', content: input.verifiedFactsBlock.trim() },
    })
  }
  const manager = new ContextManager({
    systemPrompt: input.systemPrompt,
    history: input.history,
    contextBlocks,
  })
  manager.addUserTurn({ role: 'user', content: input.currentInput })
  for (const frame of messagesToContextFrames(input.inFlight ?? [])) {
    if (frame.type === 'tool-exchange') manager.addToolExchange(frame.assistant, frame.results)
  }
  const built = manager.assembleBudgetedFrames({
    tools: input.tools,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    effectiveWindow: input.effectiveWindow,
    sendContextWindow: input.sendContextWindow ?? true,
  })
  if (input.alreadyCompacted) built.report.compacted = true
  return built
}

function estimateTools(tools: readonly AgentToolContract[]): number {
  return tools.reduce((sum, tool) => sum + estimateTokens(JSON.stringify(tool)), 0)
}

function estimateMessage(message: ChatMessage): number {
  return estimateTokens(JSON.stringify(message))
}

function estimateMessages(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessage(message), 0)
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…[已截断]`
}
