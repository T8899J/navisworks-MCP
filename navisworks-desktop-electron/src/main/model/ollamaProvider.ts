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
  finiteInteger,
  linkAbortSignals,
  parseToolArguments,
  positiveInteger,
  readStreamChunk,
  readErrorSnippet,
  requireObject,
} from './providerUtils'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const CONNECTION_TIMEOUT_MS = 5_000
/** Short ceiling so a slow/stuck summarizer can never stall retitling long. */
export const TITLE_SUMMARY_TIMEOUT_MS = 20_000

interface OllamaToolCallWire {
  id: string
  function: {
    index: number
    name: string
    arguments: Record<string, unknown>
  }
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCallWire[]
}

interface OllamaReply {
  content: string
  thinking: string
  toolCalls: ParsedToolCall[]
  promptEvalCount: number
  evalCount: number
}

export interface OllamaProviderOptions {
  baseUrl?: string
  apiKey?: string
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Chat backend for a local Ollama daemon: ndjson /api/chat streaming, /api/tags
 * model listing, and the `think` reasoning toggle with local sampling options.
 */
export class OllamaProvider implements ModelProvider {
  readonly kind: ProviderKind = 'ollama'
  readonly displayName = 'Ollama'

  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #requestTimeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: OllamaProviderOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#apiKey = options.apiKey?.trim() ?? ''
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 5 * 60 * 1000,
      'requestTimeoutMs',
    )
    this.#fetch = options.fetchImpl ?? fetch
  }

  capabilities(_model: string): ModelCapabilities {
    // Local Ollama tops out at 32K regardless of any larger configured window; it both
    // supports function tools and the `think` reasoning toggle.
    return {
      supportsTools: true,
      supportsThinking: true,
      maxContextWindow: 32_768,
      defaultContextWindow: 32_768,
    }
  }

  #authHeaders(): Record<string, string> {
    return this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = {
      model: request.model,
      messages: toOllamaMessages(request.messages),
      tools: request.tools?.length
        ? request.tools.map(({ impact: _impact, ...definition }) => definition)
        : undefined,
      stream: true,
      think: request.think ?? false,
      options: {
        temperature: request.sampling?.temperature ?? 0.1,
        num_predict: request.sampling?.maxTokens,
        num_ctx: request.sampling?.contextWindow,
      },
    }
    // Drop undefined option fields so Ollama receives its defaults untouched.
    for (const key of Object.keys(body.options)) {
      if (body.options[key as keyof typeof body.options] === undefined) {
        delete body.options[key as keyof typeof body.options]
      }
    }

    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(new AgentRuntimeError(
        'MODEL_TIMEOUT',
        `${this.displayName} 在 ${this.#requestTimeoutMs} ms 内没有响应。`,
      ))
    }, this.#requestTimeoutMs)
    const linked = linkAbortSignals(request.signal, timeoutController.signal)
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#authHeaders() },
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
      return await readOllamaStream(response.body, request.onDelta, linked.signal)
    } catch (error) {
      throw normalizeFetchError(error, request.signal, timeoutController.signal, this.displayName)
    } finally {
      clearTimeout(timeout)
      linked.dispose()
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const body = await this.#requestJson(
      '/api/tags',
      { method: 'GET', headers: this.#authHeaders() },
      signal,
      CONNECTION_TIMEOUT_MS,
    )
    const root = requireObject(body, `${this.displayName} model list`)
    if (!Array.isArray(root.models)) {
      throw new AgentRuntimeError('MODEL_INVALID_RESPONSE', `${this.displayName} 模型列表格式无效。`)
    }

    return root.models
      .map((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          return ''
        }
        const model = entry as Record<string, unknown>
        return typeof model.name === 'string' ? model.name : ''
      })
      .filter((name) => name.trim().length > 0)
  }

  async testConnection(model: string, signal?: AbortSignal): Promise<ProviderCheckResult> {
    if (!this.#baseUrl || !model.trim()) {
      return { ok: false, message: `${this.displayName} 地址或模型名为空。` }
    }

    try {
      const models = await this.listModels(signal)
      if (!models.some((name) => name.localeCompare(model, undefined, {
        sensitivity: 'accent',
      }) === 0)) {
        const available = models.length === 0
          ? '未检测到已安装模型'
          : `当前模型：${models.join(', ')}`
        return {
          ok: false,
          message: `未找到模型 ${model}；${available}。`,
        }
      }
      return { ok: true, message: `${this.displayName} 已连接，模型：${model}` }
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

  async summarizeTitle(
    model: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const prompt = [
      '为下面的用户消息生成一个简短的会话标题。',
      '要求：不超过12个字，概括主题；只输出标题本身，不要引号、句号或任何前缀说明。',
      '',
      `用户消息：${text.slice(0, 500)}`
    ].join('\n')

    const body = await this.#requestJson(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.#authHeaders() },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: '你是会话标题生成器，只输出标题本身。' },
            { role: 'user', content: prompt }
          ],
          stream: false,
          think: false,
          options: { num_predict: 24, temperature: 0.2 }
        })
      },
      signal,
      TITLE_SUMMARY_TIMEOUT_MS,
    )

    const root = requireObject(body, `${this.displayName} 标题响应`)
    const message = root.message
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new AgentRuntimeError('MODEL_INVALID_RESPONSE', `${this.displayName} 标题响应缺少 message 字段。`)
    }
    const raw = (message as Record<string, unknown>).content
    const title = cleanTitleCandidate(typeof raw === 'string' ? raw : '')
    if (!title) {
      throw new AgentRuntimeError('MODEL_INVALID_RESPONSE', `${this.displayName} 没有返回可用的标题。`)
    }
    return title
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
        `${this.displayName} 在 ${timeoutMs} ms 内没有响应。`,
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
      : new AgentRuntimeError('MODEL_TIMEOUT', `${displayName} 响应超时。`)
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

function toOllamaMessages(messages: readonly ChatMessage[]): OllamaMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: message.content,
        tool_calls: message.toolCalls.map((call, index) => ({
          id: call.id,
          function: {
            index,
            name: call.name,
            arguments: call.arguments,
          },
        })),
      }
    }
    return { role: message.role, content: message.content }
  })
}

/** Consumes the ndjson body, forwarding deltas and merging split tool_calls. */
async function readOllamaStream(
  body: ReadableStream<Uint8Array>,
  onDelta: ((delta: CompletionDelta) => void) | undefined,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let thinking = ''
  const toolCalls: ParsedToolCall[] = []
  let promptEvalCount = 0
  let evalCount = 0

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new AgentRuntimeError(
        'MODEL_INVALID_RESPONSE',
        `Ollama 流式响应行无效：${errorMessage(error)}`,
        { cause: error },
      )
    }
    const root = requireObject(parsed, 'Ollama stream chunk')
    const message = root.message === null || root.message === undefined
      ? undefined
      : requireObject(root.message, 'Ollama stream message')
    if (message !== undefined) {
      if (typeof message.thinking === 'string' && message.thinking.length > 0) {
        thinking += message.thinking
        onDelta?.({ thinking: message.thinking })
      }
      if (typeof message.content === 'string' && message.content.length > 0) {
        content += message.content
        onDelta?.({ text: message.content })
      }
      if (message.tool_calls !== undefined && message.tool_calls !== null) {
        if (Array.isArray(message.tool_calls)) {
          toolCalls.push(...parseOllamaToolCalls(message.tool_calls))
        }
      }
    }
    promptEvalCount = finiteInteger(root.prompt_eval_count, promptEvalCount)
    evalCount = finiteInteger(root.eval_count, evalCount)
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

  return {
    content,
    thinking,
    toolCalls,
    contextTokensUsed: promptEvalCount + evalCount,
  }
}

function parseOllamaToolCalls(value: unknown[]): ParsedToolCall[] {
  const result: ParsedToolCall[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = requireObject(value[index], 'tool call')
    const functionValue = requireObject(entry.function, 'tool call function')
    const name = typeof functionValue.name === 'string' ? functionValue.name : ''
    if (!name.trim()) {
      continue
    }
    result.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : `generated-${randomUUID()}`,
      name,
      arguments: parseToolArguments(functionValue.arguments),
    })
  }
  return result
}

function cleanTitleCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/^[「『"'“”‘’]+/, '')
    .replace(/[」』"'“”‘’]+$/, '')
    .replace(/^(标题|会话标题|Title)\s*[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30)
    .replace(/[。.!!??]+$/, '')
    .trim()
}
import { randomUUID } from 'node:crypto'
