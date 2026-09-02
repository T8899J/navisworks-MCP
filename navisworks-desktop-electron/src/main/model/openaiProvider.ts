import {
  AgentRuntimeError,
  type ChatMessage,
  type CompletionDelta,
  type CompletionRequest,
  type CompletionResult,
  type ModelCapabilities,
  type ModelProvider,
  type ParsedToolCall,
  type ProviderCheckResult,
  type ProviderKind,
} from './types'
import {
  createAbortError,
  errorMessage,
  linkAbortSignals,
  parseToolArguments,
  positiveInteger,
  readStreamChunk,
  readErrorSnippet,
  requireObject,
} from './providerUtils'

const CONNECTION_TIMEOUT_MS = 5_000

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface MergedToolCall {
  id: string
  name: string
  argumentsText: string
}

export interface OpenAICompatibleProviderOptions {
  baseUrl: string
  apiKey?: string
  requestTimeoutMs?: number
  /**
   * Optional window for gateways that advertise one. When absent the provider reports
   * NO context window: ContextManager then sends no num_ctx and applies no clamping, so
   * a cloud run is never assumed to be a fixed size (never "1M by default").
   */
  contextWindow?: number
  fetchImpl?: typeof fetch
}

/**
 * Chat backend for any OpenAI-compatible /chat/completions endpoint
 * (DashScope, vLLM, LM Studio, OpenRouter, ...). API profiles use this
 * provider; tool calls stream as indexed argument fragments that are merged
 * per chunk, and reasoning models expose their thinking via
 * delta.reasoning_content / delta.reasoning.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind: ProviderKind = 'openai'
  readonly displayName = 'OpenAI 兼容端点'

  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #requestTimeoutMs: number
  readonly #contextWindow: number | undefined
  readonly #fetch: typeof fetch

  constructor(options: OpenAICompatibleProviderOptions) {
    this.#baseUrl = options.baseUrl.trim().replace(/\/+$/, '')
    if (!this.#baseUrl) {
      throw new AgentRuntimeError('MODEL_IO', 'OpenAI 兼容端点地址为空。')
    }
    this.#apiKey = options.apiKey?.trim() ?? ''
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 5 * 60 * 1000,
      'requestTimeoutMs',
    )
    this.#contextWindow = options.contextWindow === undefined
      ? undefined
      : positiveInteger(options.contextWindow, 'contextWindow')
    this.#fetch = options.fetchImpl ?? fetch
  }

  capabilities(_model: string): ModelCapabilities {
    // Function tools and reasoning deltas are both surfaced by the wire format here.
    // No window is advertised unless one was configured — a cloud run is never assumed
    // to be a fixed size.
    return {
      supportsTools: true,
      supportsThinking: true,
      ...(this.#contextWindow === undefined
        ? {}
        : { maxContextWindow: this.#contextWindow, defaultContextWindow: this.#contextWindow }),
    }
  }

  #authHeaders(): Record<string, string> {
    return this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
      stream: true,
      temperature: request.sampling?.temperature ?? 0.2,
      // Strict OpenAI endpoints omit usage in streams unless this is set;
      // tolerant gateways ignore it.
      stream_options: { include_usage: true },
    }
    if (request.sampling?.maxTokens !== undefined) {
      body.max_tokens = request.sampling.maxTokens
    }
    // Never send an empty tools array: some gateways reject it outright.
    if (request.tools?.length) {
      body.tools = request.tools.map(({ impact: _impact, ...definition }) => definition)
    }
    // Five-step effort picked in the composer; tolerant gateways consume it,
    // endpoints without reasoning support ignore the unknown field.
    if (request.reasoningEffort !== undefined) {
      body.reasoning_effort = request.reasoningEffort
    }

    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(new AgentRuntimeError(
        'MODEL_TIMEOUT',
        `${this.displayName}在 ${this.#requestTimeoutMs} ms 内没有响应。`,
      ))
    }, this.#requestTimeoutMs)
    const linked = linkAbortSignals(request.signal, timeoutController.signal)
    try {
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.#authHeaders(),
        },
        body: JSON.stringify(body),
        signal: linked.signal,
      })
      if (!response.ok) {
        const responseBody = await response.text()
        throw new AgentRuntimeError(
          'MODEL_HTTP_ERROR',
          `${this.displayName} 返回 ${response.status} ${response.statusText}: ${readErrorSnippet(responseBody)}`,
        )
      }
      if (!response.body) {
        throw new AgentRuntimeError('MODEL_INVALID_RESPONSE', `${this.displayName} 流式响应缺少正文。`)
      }
      return await readOpenAIStream(response.body, request.onDelta, linked.signal)
    } catch (error) {
      throw normalizeFetchError(error, request.signal, timeoutController.signal, this.displayName)
    } finally {
      clearTimeout(timeout)
      linked.dispose()
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const body = await this.#requestJson(
      '/models',
      { method: 'GET', headers: this.#authHeaders() },
      signal,
      CONNECTION_TIMEOUT_MS,
    )
    const root = requireObject(body, `${this.displayName} model list`)
    if (!Array.isArray(root.data)) {
      throw new AgentRuntimeError('MODEL_INVALID_RESPONSE', `${this.displayName} 模型列表格式无效。`)
    }
    return root.data
      .map((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          return ''
        }
        const model = entry as Record<string, unknown>
        return typeof model.id === 'string' ? model.id : ''
      })
      .filter((name) => name.trim().length > 0)
  }

  async testConnection(model: string, signal?: AbortSignal): Promise<ProviderCheckResult> {
    if (!this.#baseUrl || !model.trim()) {
      return { ok: false, message: `${this.displayName}地址或模型名为空。` }
    }

    try {
      const models = await this.listModels(signal)
      if (!models.some((name) => name.localeCompare(model, undefined, {
        sensitivity: 'accent',
      }) === 0)) {
        const available = models.length === 0
          ? '未检测到可用模型'
          : `当前模型：${models.slice(0, 8).join(', ')}${models.length > 8 ? ' …' : ''}`
        return {
          ok: false,
          message: `未找到模型 ${model}；${available}。`,
        }
      }
      return { ok: true, message: `${this.displayName}已连接，模型：${model}` }
    } catch (error) {
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }
      return {
        ok: false,
        message: `无法连接 ${this.displayName}：${errorMessage(error)}`,
      }
    }
  }

  async #requestJson(
    pathname: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(new AgentRuntimeError(
        'MODEL_TIMEOUT',
        `${this.displayName}在 ${timeoutMs} ms 内没有响应。`,
      ))
    }, timeoutMs)
    const linked = linkAbortSignals(signal, timeoutController.signal)
    try {
      const response = await this.#fetch(`${this.#baseUrl}${pathname}`, {
        ...init,
        signal: linked.signal,
      })
      const responseBody = await response.text()
      if (!response.ok) {
        throw new AgentRuntimeError(
          'MODEL_HTTP_ERROR',
          `${this.displayName} 返回 ${response.status} ${response.statusText}: ${readErrorSnippet(responseBody)}`,
        )
      }
      try {
        return JSON.parse(responseBody)
      } catch (error) {
        throw new AgentRuntimeError(
          'MODEL_INVALID_RESPONSE',
          `${this.displayName} 响应不是有效 JSON：${errorMessage(error)}`,
          { cause: error },
        )
      }
    } catch (error) {
      throw normalizeFetchError(error, signal, timeoutController.signal, this.displayName)
    } finally {
      clearTimeout(timeout)
      linked.dispose()
    }
  }

}

function normalizeFetchError(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  displayName: string,
): Error {
  if (externalSignal?.aborted) {
    return createAbortError(externalSignal.reason)
  }
  if (timeoutSignal.aborted) {
    const reason = timeoutSignal.reason
    return reason instanceof AgentRuntimeError
      ? reason
      : new AgentRuntimeError('MODEL_TIMEOUT', `${displayName}响应超时。`)
  }
  if (error instanceof AgentRuntimeError) {
    return error
  }
  return new AgentRuntimeError(
    'MODEL_IO',
    `${displayName} 请求失败：${errorMessage(error)}`,
    { cause: error },
  )
}

function toOpenAIMessages(messages: readonly ChatMessage[]): OpenAIMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      }
    }
    if (message.role === 'tool') {
      return {
        role: 'tool' as const,
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      }
    }
    return { role: message.role, content: message.content }
  })
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    /** OpenAI style cached-token detail. */
    prompt_tokens_details?: { cached_tokens?: number } | null
    /** DeepSeek style cache split. */
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  } | null
}

/** Consumes the SSE body: `data: {...}` lines terminated by `data: [DONE]`. */
async function readOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onDelta: ((delta: CompletionDelta) => void) | undefined,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let thinking = ''
  let contextTokensUsed = 0
  let cacheHitRate: number | undefined
  const mergedCalls = new Map<number, MergedToolCall>()

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch (error) {
      throw new AgentRuntimeError(
        'MODEL_INVALID_RESPONSE',
        `OpenAI 兼容流式响应行无效：${errorMessage(error)}`,
        { cause: error },
      )
    }
    const root = requireObject(parsed, 'OpenAI compatible stream chunk')
    const chunk = root as unknown as OpenAIStreamChunk
    const usage = chunk.usage
    if (usage && typeof usage === 'object') {
      const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
      const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
      contextTokensUsed = promptTokens + completionTokens
      // Cache hit rate: OpenAI cached_tokens detail or the DeepSeek split.
      const cached = usage.prompt_tokens_details?.cached_tokens
        ?? usage.prompt_cache_hit_tokens
      if (typeof cached === 'number' && promptTokens > 0) {
        cacheHitRate = Math.max(0, Math.min(1, cached / promptTokens))
      }
    }

    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta) {
      const thinkingDelta = delta.reasoning_content ?? delta.reasoning
      if (typeof thinkingDelta === 'string' && thinkingDelta.length > 0) {
        thinking += thinkingDelta
        onDelta?.({ thinking: thinkingDelta })
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content
        onDelta?.({ text: delta.content })
      }
      for (const fragment of delta.tool_calls ?? []) {
        const index = typeof fragment.index === 'number' ? fragment.index : 0
        const existing = mergedCalls.get(index) ?? { id: '', name: '', argumentsText: '' }
        if (fragment.id) existing.id = fragment.id
        if (fragment.function?.name) existing.name = fragment.function.name
        if (fragment.function?.arguments) existing.argumentsText += fragment.function.arguments
        mergedCalls.set(index, existing)
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await readStreamChunk(reader, signal)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        handleLine(buffer.slice(0, newlineIndex))
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) handleLine(buffer)
  } finally {
    if (signal?.aborted) {
      await reader.cancel(signal.reason).catch(() => undefined)
    }
    reader.releaseLock()
  }

  const toolCalls: ParsedToolCall[] = [...mergedCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id || `generated-${randomUUID()}`,
      name: call.name,
      arguments: parseToolArguments(call.argumentsText),
    }))
    .filter((call) => call.name.trim().length > 0)

  return {
    content,
    thinking,
    toolCalls,
    contextTokensUsed,
    ...(cacheHitRate === undefined ? {} : { cacheHitRate })
  }
}
import { randomUUID } from 'node:crypto'
