import { BridgeError, type BridgeCallOptions } from './bridgeClient'
import {
  AGENT_TOOL_DEFINITIONS,
  toolCatalog,
  ToolCatalogError,
  type AgentToolName,
} from './toolCatalog'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const DEFAULT_MODEL = 'qwen3.5:9b-q4_K_M'
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const CONNECTION_TIMEOUT_MS = 5_000
const MAX_TOOL_ROUNDS = 8
const MAX_HISTORY_MESSAGES = 24
const MAX_TOOL_RESULT_CHARS = 4_000

export interface AgentHistoryEntry {
  role: 'user' | 'assistant' | 'ai'
  content: string
}

export type AgentRunEvent =
  | { phase: 'text'; delta: string }
  | { phase: 'thinking'; delta: string }
  | { phase: 'started'; tool: string; arguments: Record<string, unknown> }
  | {
      phase: 'completed'
      tool: string
      arguments: Record<string, unknown>
      result?: unknown
      error?: { code: string; message: string; ambiguousOutcome?: boolean }
    }

export interface RunAgentOptions {
  history?: readonly AgentHistoryEntry[]
  signal?: AbortSignal
  onEvent?: (event: AgentRunEvent) => void
}

export interface AgentRunResult {
  isSuccess: boolean
  message: string
  contextTokensUsed: number
  thinkingText?: string
  errorCode?: string
}

export interface OllamaConnectionResult {
  isSuccess: boolean
  message: string
}

export interface OllamaAgentOptions {
  bridgeClient: AgentBridgeClient
  baseUrl?: string
  apiKey?: string
  model?: string
  think?: boolean
  contextWindow?: number
  numPredict?: number
  requestTimeoutMs?: number
  maxToolRounds?: number
  disabledTools?: readonly string[]
  fetchImpl?: typeof fetch
}

export interface AgentBridgeClient {
  call<T = unknown>(
    method: string,
    parameters?: Record<string, unknown>,
    options?: BridgeCallOptions,
  ): Promise<T>
}

export class OllamaAgentError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OllamaAgentError'
    this.code = code
  }
}

export class OllamaAgent {
  readonly #bridgeClient: AgentBridgeClient
  readonly #baseUrl: string
  readonly #model: string
  readonly #think: boolean
  readonly #contextWindow: number
  readonly #numPredict: number
  readonly #requestTimeoutMs: number
  readonly #maxToolRounds: number
  readonly #disabledTools: Set<string>
  readonly #apiKey: string
  readonly #fetch: typeof fetch

  constructor(options: OllamaAgentOptions) {
    this.#bridgeClient = options.bridgeClient
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#model = (options.model ?? DEFAULT_MODEL).trim()
    this.#think = options.think ?? false
    this.#contextWindow = Math.max(1024, Math.trunc(options.contextWindow ?? 8192))
    this.#numPredict = Math.max(1, Math.trunc(options.numPredict ?? 2048))
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    )
    this.#maxToolRounds = positiveInteger(
      options.maxToolRounds ?? MAX_TOOL_ROUNDS,
      'maxToolRounds',
    )
    this.#disabledTools = new Set(options.disabledTools ?? [])
    this.#apiKey = options.apiKey?.trim() ?? ''
    this.#fetch = options.fetchImpl ?? fetch
  }

  /** Bearer auth for remote/proxied Ollama endpoints; empty key sends nothing. */
  #authHeaders(): Record<string, string> {
    return this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const body = await this.#requestJson(
      '/api/tags',
      { method: 'GET', headers: this.#authHeaders() },
      signal,
      CONNECTION_TIMEOUT_MS,
    )
    const root = requireObject(body, 'Ollama model list')
    if (!Array.isArray(root.models)) {
      throw new OllamaAgentError('OLLAMA_INVALID_RESPONSE', 'Ollama 模型列表格式无效。')
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

  async testConnection(signal?: AbortSignal): Promise<OllamaConnectionResult> {
    if (!this.#baseUrl || !this.#model) {
      return { isSuccess: false, message: 'Ollama 地址或模型名为空。' }
    }

    try {
      const models = await this.listModels(signal)
      if (!models.some((name) => name.localeCompare(this.#model, undefined, {
        sensitivity: 'accent',
      }) === 0)) {
        const available = models.length === 0
          ? '未检测到已安装模型'
          : `当前模型：${models.join(', ')}`
        return {
          isSuccess: false,
          message: `未找到模型 ${this.#model}；${available}。`,
        }
      }
      return { isSuccess: true, message: `Ollama 已连接，模型：${this.#model}` }
    } catch (error) {
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }
      return {
        isSuccess: false,
        message: `无法连接 Ollama：${errorMessage(error)}`,
      }
    }
  }

  async run(input: string, options: RunAgentOptions = {}): Promise<AgentRunResult> {
    const trimmedInput = input.trim()
    if (!trimmedInput) {
      return {
        isSuccess: false,
        message: '消息不能为空。',
        contextTokensUsed: 0,
        errorCode: 'EMPTY_INPUT',
      }
    }

    const messages: OllamaMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...normalizeHistory(options.history ?? []),
      { role: 'user', content: trimmedInput },
    ]
    let latestContextTokens = 0

    try {
      for (let round = 0; round < this.#maxToolRounds; round += 1) {
        throwIfAborted(options.signal)
        const response = await this.#streamChat(messages, options.signal, options.onEvent)
        latestContextTokens = response.promptEvalCount + response.evalCount

        if (response.toolCalls.length === 0) {
          const finalMessage = response.content.trim()
          if (!finalMessage) {
            return {
              isSuccess: false,
              message: '模型没有返回文本或工具调用，请重试或更换模型。',
              contextTokensUsed: latestContextTokens,
              errorCode: 'OLLAMA_EMPTY_RESPONSE',
            }
          }
          return {
            isSuccess: true,
            message: finalMessage,
            contextTokensUsed: latestContextTokens,
            ...(response.thinking.trim() ? { thinkingText: response.thinking } : {}),
          }
        }

        messages.push({
          role: 'assistant',
          content: response.content,
          tool_calls: response.toolCalls.map(toWireToolCall),
        })

        for (const toolCall of response.toolCalls) {
          throwIfAborted(options.signal)
          options.onEvent?.({
            phase: 'started',
            tool: toolCall.name,
            arguments: toolCall.arguments,
          })

          const toolResult = await this.#executeTool(toolCall, options.signal)
          options.onEvent?.({
            phase: 'completed',
            tool: toolCall.name,
            arguments: toolCall.arguments,
            result: toolResult.result,
            error: toolResult.error,
          })

          const wireResult = JSON.stringify(toolResult.wire)
          messages.push({
            role: 'tool',
            content: truncateToolResult(toolCall.name, wireResult),
          })
        }
      }

      return {
        isSuccess: false,
        message: `工具调用超过 ${this.#maxToolRounds} 轮，已停止以避免循环。请缩小指令范围后重试。`,
        contextTokensUsed: latestContextTokens,
        errorCode: 'TOOL_ROUND_LIMIT',
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw createAbortError(options.signal.reason)
      }
      if (error instanceof OllamaAgentError) {
        return {
          isSuccess: false,
          message: error.message,
          contextTokensUsed: latestContextTokens,
          errorCode: error.code,
        }
      }
      return {
        isSuccess: false,
        message: `本地模型调用失败：${errorMessage(error)}`,
        contextTokensUsed: latestContextTokens,
        errorCode: 'OLLAMA_ERROR',
      }
    }
  }

  dispose(): void {
    // fetch and BridgeClient do not own a persistent connection in this layer.
  }

  /**
   * Streams /api/chat as ndjson so text and thinking deltas reach the UI as
   * they are generated instead of after the full response lands.
   */
  async #streamChat(
    messages: readonly OllamaMessage[],
    signal: AbortSignal | undefined,
    onEvent: ((event: AgentRunEvent) => void) | undefined,
  ): Promise<OllamaReply> {
    throwIfAborted(signal)
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(new OllamaAgentError(
        'OLLAMA_TIMEOUT',
        `Ollama 在 ${this.#requestTimeoutMs} ms 内没有响应。`,
      ))
    }, this.#requestTimeoutMs)
    const linked = linkAbortSignals(signal, timeoutController.signal)

    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#authHeaders() },
        body: JSON.stringify({
          model: this.#model,
          messages,
          tools: AGENT_TOOL_DEFINITIONS
            .filter((definition) => !this.#disabledTools.has(definition.function.name))
            .map(({ impact: _impact, ...definition }) => definition),
          stream: true,
          think: this.#think,
          options: {
            temperature: 0.1,
            num_predict: this.#numPredict,
            num_ctx: this.#contextWindow,
          },
        }),
        signal: linked.signal,
      })
      if (!response.ok) {
        const responseBody = await response.text()
        throw new OllamaAgentError(
          'OLLAMA_HTTP_ERROR',
          `Ollama 返回 ${response.status} ${response.statusText}: ${readOllamaError(responseBody)}`,
        )
      }
      if (!response.body) {
        throw new OllamaAgentError('OLLAMA_INVALID_RESPONSE', 'Ollama 流式响应缺少正文。')
      }
      return await readChatStream(response.body, onEvent)
    } catch (error) {
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }
      if (timeoutController.signal.aborted) {
        const reason = timeoutController.signal.reason
        throw reason instanceof OllamaAgentError
          ? reason
          : new OllamaAgentError('OLLAMA_TIMEOUT', 'Ollama 响应超时。')
      }
      if (error instanceof OllamaAgentError) {
        throw error
      }
      throw new OllamaAgentError(
        'OLLAMA_IO',
        `Ollama 请求失败：${errorMessage(error)}`,
        { cause: error },
      )
    } finally {
      clearTimeout(timeout)
      linked.dispose()
    }
  }

  async #executeTool(
    toolCall: ParsedToolCall,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    try {
      toolCatalog.assertAllowed(toolCall.name, toolCall.arguments)
      if (this.#disabledTools.has(toolCall.name)) {
        throw new ToolCatalogError(`工具已被用户禁用：${toolCall.name}`)
      }
      const normalizedArguments = toolCatalog.normalizeArguments(toolCall.name, toolCall.arguments)
      const result = await this.#bridgeClient.call(
        toolCall.name,
        normalizedArguments,
        { signal },
      )
      return {
        result,
        wire: { status: 'success', tool: toolCall.name, result },
      }
    } catch (error) {
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }
      const code = error instanceof BridgeError
        ? error.code
        : error instanceof ToolCatalogError
          ? error.code
          : 'TOOL_EXECUTION_FAILED'
      const message = errorMessage(error)
      const ambiguousOutcome = error instanceof BridgeError && error.ambiguousOutcome
      const errorShape = { code, message, ambiguousOutcome }
      return {
        error: errorShape,
        wire: {
          status: 'error',
          tool: toolCall.name,
          code,
          summary: message,
          ambiguousOutcome,
          next_actions: [
            '确认 Navisworks Manage 2023 已启动。',
            '确认模型文档已打开，并已加载 Navisworks MCP 插件。',
          ],
        },
      }
    }
  }

  async #requestJson(
    pathname: string,
    init: RequestInit,
    externalSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    throwIfAborted(externalSignal)
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(new OllamaAgentError(
        'OLLAMA_TIMEOUT',
        `Ollama 在 ${timeoutMs} ms 内没有响应。`,
      ))
    }, timeoutMs)
    const linked = linkAbortSignals(externalSignal, timeoutController.signal)

    try {
      const response = await this.#fetch(`${this.#baseUrl}${pathname}`, {
        ...init,
        signal: linked.signal,
      })
      const responseBody = await response.text()
      if (!response.ok) {
        throw new OllamaAgentError(
          'OLLAMA_HTTP_ERROR',
          `Ollama 返回 ${response.status} ${response.statusText}: ${readOllamaError(responseBody)}`,
        )
      }
      try {
        return JSON.parse(responseBody)
      } catch (error) {
        throw new OllamaAgentError(
          'OLLAMA_INVALID_RESPONSE',
          `Ollama 返回格式无效：${errorMessage(error)}`,
          { cause: error },
        )
      }
    } catch (error) {
      if (externalSignal?.aborted) {
        throw createAbortError(externalSignal.reason)
      }
      if (timeoutController.signal.aborted) {
        const reason = timeoutController.signal.reason
        throw reason instanceof OllamaAgentError
          ? reason
          : new OllamaAgentError('OLLAMA_TIMEOUT', 'Ollama 响应超时。')
      }
      if (error instanceof OllamaAgentError) {
        throw error
      }
      throw new OllamaAgentError(
        'OLLAMA_IO',
        `Ollama 请求失败：${errorMessage(error)}`,
        { cause: error },
      )
    } finally {
      clearTimeout(timeout)
      linked.dispose()
    }
  }
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCallWire[]
}

interface OllamaToolCallWire {
  id: string
  function: {
    index: number
    name: string
    arguments: Record<string, unknown>
  }
}

interface ParsedToolCall {
  id: string
  index: number
  name: string
  arguments: Record<string, unknown>
}

interface OllamaReply {
  content: string
  thinking: string
  toolCalls: ParsedToolCall[]
  promptEvalCount: number
  evalCount: number
}

interface ToolExecutionResult {
  result?: unknown
  error?: { code: string; message: string; ambiguousOutcome?: boolean }
  wire: Record<string, unknown>
}

function parseToolCalls(value: unknown): ParsedToolCall[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new OllamaAgentError('OLLAMA_INVALID_RESPONSE', 'tool_calls 必须是数组。')
  }

  const result: ParsedToolCall[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = requireObject(value[index], 'tool call')
    const functionValue = requireObject(entry.function, 'tool call function')
    const name = typeof functionValue.name === 'string' ? functionValue.name : ''
    if (!name.trim()) {
      continue
    }
    result.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : `call-${index}`,
      index: finiteInteger(functionValue.index, index),
      name,
      arguments: parseToolArguments(functionValue.arguments),
    })
  }
  return result
}

/**
 * Consumes the ndjson body of a streaming /api/chat response, forwarding
 * text/thinking deltas as they arrive and merging tool_calls chunks (which
 * may be split across lines) into one final list.
 */
async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: ((event: AgentRunEvent) => void) | undefined,
): Promise<OllamaReply> {
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
      throw new OllamaAgentError(
        'OLLAMA_INVALID_RESPONSE',
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
        onEvent?.({ phase: 'thinking', delta: message.thinking })
      }
      if (typeof message.content === 'string' && message.content.length > 0) {
        content += message.content
        onEvent?.({ phase: 'text', delta: message.content })
      }
      if (message.tool_calls !== undefined && message.tool_calls !== null) {
        toolCalls.push(...parseToolCalls(message.tool_calls))
      }
    }
    promptEvalCount = finiteInteger(root.prompt_eval_count, promptEvalCount)
    evalCount = finiteInteger(root.eval_count, evalCount)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
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
    reader.releaseLock()
  }

  return { content, thinking, toolCalls, promptEvalCount, evalCount }
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === '') {
    return {}
  }
  if (typeof value === 'string') {
    try {
      return parseToolArguments(JSON.parse(value))
    } catch (error) {
      throw new OllamaAgentError(
        'OLLAMA_INVALID_RESPONSE',
        `工具 arguments 不是有效 JSON：${errorMessage(error)}`,
        { cause: error },
      )
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OllamaAgentError(
      'OLLAMA_INVALID_RESPONSE',
      '工具 arguments 必须是对象或 JSON 字符串。',
    )
  }
  return value as Record<string, unknown>
}

function toWireToolCall(call: ParsedToolCall): OllamaToolCallWire {
  return {
    id: call.id,
    function: {
      index: call.index,
      name: call.name,
      arguments: call.arguments,
    },
  }
}

function normalizeHistory(history: readonly AgentHistoryEntry[]): OllamaMessage[] {
  return history
    .slice(-MAX_HISTORY_MESSAGES)
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => ({
      role: entry.role === 'user' ? 'user' : 'assistant',
      content: entry.content,
    }))
}

function truncateToolResult(toolName: string, result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) {
    return result
  }
  let clipped = result.slice(0, MAX_TOOL_RESULT_CHARS)
  const finalCodeUnit = clipped.charCodeAt(clipped.length - 1)
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) {
    clipped = clipped.slice(0, -1)
  }
  return `${clipped}\n\n[工具 ${toolName} 的结果过大（原始 ${result.length} 字符），` +
    `已截断至 ${MAX_TOOL_RESULT_CHARS} 字符。请缩小查询范围后重试：降低 limit、` +
    '改用 category/property 过滤参数，或减少 itemIds 数量。]'
}

function readOllamaError(responseBody: string): string {
  try {
    const value: unknown = JSON.parse(responseBody)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const error = (value as Record<string, unknown>).error
      if (typeof error === 'string') {
        return error
      }
    }
  } catch {
    // Preserve the bounded raw response below.
  }
  return responseBody.length <= 500 ? responseBody : responseBody.slice(0, 500)
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OllamaAgentError('OLLAMA_INVALID_RESPONSE', `${label} 格式无效。`)
  }
  return value as Record<string, unknown>
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer.`)
  }
  return value
}

function linkAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abortFromFirst = (): void => controller.abort(first?.reason)
  const abortFromSecond = (): void => controller.abort(second.reason)

  first?.addEventListener('abort', abortFromFirst, { once: true })
  second.addEventListener('abort', abortFromSecond, { once: true })
  if (first?.aborted) {
    abortFromFirst()
  } else if (second.aborted) {
    abortFromSecond()
  }

  return {
    signal: controller.signal,
    dispose: () => {
      first?.removeEventListener('abort', abortFromFirst)
      second.removeEventListener('abort', abortFromSecond)
    },
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason)
  }
}

function createAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason
  }
  const error = new Error(
    reason instanceof Error ? reason.message : 'The operation was aborted.',
    reason instanceof Error ? { cause: reason } : undefined,
  )
  error.name = 'AbortError'
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SYSTEM_PROMPT = `你是一个友好、可靠的 Navisworks 中文助手。

规则：
1. 问候、闲聊、能力介绍和一般知识问题，直接自然回复，不要调用工具。
2. 只有当用户需要读取当前 Navisworks 模型数据，或要求修改当前选择、可见性、视点时，才调用工具。
3. 工具返回后，用简洁自然的中文向用户解释结果；如果完成任务还需要另一个工具，可以继续调用。
4. 不要编造模型、构件、属性、选择或连接状态；这些事实必须来自工具结果。
5. 构件 ID 只在当前 Navisworks 文档和插件会话中有效。用户提到“第一个、第三个”等结果时，使用前面工具结果里的构件 ID。
6. 工具报错时说明实际错误，并给出安全的下一步，不要声称操作成功。
7. 不执行任意脚本，不保存、覆盖或删除 Navisworks 文件。
8. 调用 navisworks_list_viewpoints 后，简要说明视点数量；除非用户明确要求，不要在对话中逐项重复视点名称和 GUID。`

export type { AgentToolName }
