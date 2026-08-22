using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace NavisworksMcp.Desktop.Services;

public sealed record LlmToolCall(
    string Id,
    int Index,
    string Name,
    IReadOnlyDictionary<string, object?> Arguments);

public sealed record LlmRunResult(
    bool IsSuccess,
    string Message,
    int ContextTokensUsed,
    bool IsCancelled = false)
{
    public static LlmRunResult Success(string message, int contextTokensUsed) =>
        new(true, message, contextTokensUsed);

    public static LlmRunResult Failure(string message, int contextTokensUsed = 0) =>
        new(false, message, contextTokensUsed);

    public static LlmRunResult Cancelled(string partialMessage, int contextTokensUsed) =>
        new(false, partialMessage, contextTokensUsed, true);
}

public enum LlmStreamKind
{
    Thinking,
    Content,
    Tool
}

public sealed record LlmStreamUpdate(LlmStreamKind Kind, string Text);

public sealed record LlmConnectionResult(bool IsSuccess, string Message);
public sealed record LlmHistoryEntry(string Role, string Content);
public sealed record LlmModelListResult(
    bool IsSuccess,
    IReadOnlyList<string> Models,
    string Message);

public sealed class OllamaClient : IDisposable
{
    private const int MaxToolRounds = 4;
    private const int MaxHistoryMessages = 24;

    // Approximate token budget for a single tool result. Character-based
    // because the desktop app has no tokenizer; 6k chars keeps a full
    // 4-round tool loop inside the 16K-token window alongside the fixed
    // prompt (system + tool schemas) and the reply budget.
    private const int MaxToolResultChars = 6000;
    private static readonly TimeSpan ConnectionProbeTimeout = TimeSpan.FromSeconds(5);

    // Hang detector for the streamed /api/chat response: generous because a cold
    // model load plus a 16K prompt prefill can run minutes without emitting a token.
    private static readonly TimeSpan StreamIdleTimeout = TimeSpan.FromMinutes(5);

    private readonly HttpClient _http;
    private readonly string _model;
    private readonly string _baseUrl;
    private readonly bool _think;
    private readonly int _contextWindow;
    private readonly int _numPredict;
    private readonly List<OllamaMessage> _history = new();

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(_baseUrl) && !string.IsNullOrWhiteSpace(_model);

    public OllamaClient(
        string baseUrl = "http://localhost:11434",
        string model = "qwen3.5:9b-q4_K_M",
        bool think = false,
        int contextWindow = 16384,
        int numPredict = 1024)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _model = model.Trim();
        _think = think;
        _contextWindow = Math.Max(1024, contextWindow);
        _numPredict = Math.Max(1, numPredict);
        _http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
    }

    public void RestoreHistory(IEnumerable<LlmHistoryEntry> entries)
    {
        ArgumentNullException.ThrowIfNull(entries);
        _history.Clear();

        foreach (var entry in entries.TakeLast(MaxHistoryMessages))
        {
            if (entry.Role is not ("user" or "assistant") ||
                string.IsNullOrWhiteSpace(entry.Content))
            {
                continue;
            }

            _history.Add(new OllamaMessage(entry.Role, entry.Content));
        }
    }

    public async Task<LlmConnectionResult> CheckConnectionAsync(
        CancellationToken cancellationToken = default)
    {
        if (!IsConfigured)
            return new(false, "Ollama 地址或模型名为空。");

        try
        {
            using var probeCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            probeCts.CancelAfter(ConnectionProbeTimeout);
            using var response = await _http.GetAsync(
                $"{_baseUrl}/api/tags",
                probeCts.Token);

            if (!response.IsSuccessStatusCode)
            {
                return new(
                    false,
                    $"Ollama 返回 {(int)response.StatusCode} {response.ReasonPhrase}。");
            }

            using var document = JsonDocument.Parse(
                await response.Content.ReadAsStringAsync(probeCts.Token));

            var installed = document.RootElement
                .GetProperty("models")
                .EnumerateArray()
                .Select(model =>
                    model.TryGetProperty("name", out var name) ? name.GetString() : null)
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Cast<string>()
                .ToArray();

            if (!installed.Contains(_model, StringComparer.OrdinalIgnoreCase))
            {
                var available = installed.Length == 0
                    ? "未检测到已安装模型"
                    : $"当前模型：{string.Join(", ", installed)}";
                return new(false, $"未找到模型 {_model}；{available}。");
            }

            return new(true, $"Ollama 已连接，模型：{_model}");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new(false, "连接 Ollama 超时。");
        }
        catch (HttpRequestException ex)
        {
            return new(false, $"无法连接 Ollama：{ex.Message}");
        }
        catch (Exception ex)
        {
            return new(false, $"检查 Ollama 失败：{ex.Message}");
        }
    }

    public async Task<LlmModelListResult> ListInstalledModelsAsync(
        CancellationToken cancellationToken = default)
    {
        try
        {
            using var probeCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            probeCts.CancelAfter(ConnectionProbeTimeout);
            using var response = await _http.GetAsync(
                $"{_baseUrl}/api/tags",
                probeCts.Token);

            if (!response.IsSuccessStatusCode)
            {
                return new(
                    false,
                    Array.Empty<string>(),
                    $"Ollama 返回 {(int)response.StatusCode} {response.ReasonPhrase}。");
            }

            using var document = JsonDocument.Parse(
                await response.Content.ReadAsStringAsync(probeCts.Token));

            var models = document.RootElement
                .GetProperty("models")
                .EnumerateArray()
                .Select(model =>
                    model.TryGetProperty("name", out var name) ? name.GetString() : null)
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Cast<string>()
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
                .ToArray();

            return new(true, models, $"检测到 {models.Length} 个本地模型。");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new(false, Array.Empty<string>(), "读取 Ollama 模型列表超时。");
        }
        catch (HttpRequestException ex)
        {
            return new(false, Array.Empty<string>(), $"无法连接 Ollama：{ex.Message}");
        }
        catch (Exception ex)
        {
            return new(false, Array.Empty<string>(), $"读取模型列表失败：{ex.Message}");
        }
    }

    public async Task<LlmRunResult> RunAgentAsync(
        string userInput,
        Func<LlmToolCall, CancellationToken, Task<string>> executeTool,
        Action<LlmStreamUpdate>? onUpdate = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(userInput);
        ArgumentNullException.ThrowIfNull(executeTool);

        var userMessage = new OllamaMessage("user", userInput);
        var turnMessages = new List<OllamaMessage> { userMessage };
        var requestMessages = new List<OllamaMessage>
        {
            new("system", SystemPrompt)
        };

        requestMessages.AddRange(_history.Skip(GetValidHistoryStart(_history)));
        requestMessages.Add(userMessage);
        var latestContextTokens = 0;
        var streamedContent = "";
        Action<LlmStreamUpdate> progress = update =>
        {
            if (update.Kind == LlmStreamKind.Content)
                streamedContent = update.Text;
            onUpdate?.Invoke(update);
        };

        try
        {
            for (var round = 0; round < MaxToolRounds; round++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var reply = await SendAsync(requestMessages, progress, cancellationToken);
                latestContextTokens = reply.PromptEvalCount + reply.EvalCount;

                if (reply.ToolCalls.Count == 0)
                {
                    if (string.IsNullOrWhiteSpace(reply.Content))
                    {
                        return LlmRunResult.Failure(
                            "模型没有返回文本或工具调用，请重试或更换模型。");
                    }

                    var finalMessage = new OllamaMessage("assistant", reply.Content.Trim());
                    turnMessages.Add(finalMessage);
                    CommitHistory(turnMessages);
                    return LlmRunResult.Success(finalMessage.Content, latestContextTokens);
                }

                var assistantMessage = new OllamaMessage(
                    "assistant",
                    reply.Content,
                    reply.ToolCalls.Select(ToWireToolCall).ToArray());
                requestMessages.Add(assistantMessage);
                turnMessages.Add(assistantMessage);

                foreach (var toolCall in reply.ToolCalls)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    progress(new LlmStreamUpdate(LlmStreamKind.Tool, toolCall.Name));
                    var rawToolResult = await executeTool(toolCall, cancellationToken);
                    var toolResult = TruncateToolResult(toolCall.Name, rawToolResult);
                    var toolMessage = new OllamaMessage("tool", toolResult);
                    requestMessages.Add(toolMessage);
                    turnMessages.Add(toolMessage);
                }

                // The next round starts a fresh completion over the tool results.
                streamedContent = "";
                progress(new LlmStreamUpdate(LlmStreamKind.Thinking, ""));
            }

            CommitHistory(turnMessages, "工具调用已达上限，已停止。");
            return LlmRunResult.Failure(
                $"工具调用超过 {MaxToolRounds} 轮，已停止以避免循环。请缩小指令范围后重试。",
                latestContextTokens);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            var partial = streamedContent.Trim();
            if (!string.IsNullOrWhiteSpace(partial))
                turnMessages.Add(new OllamaMessage("assistant", partial));
            CommitHistory(turnMessages, "已停止生成。");
            return LlmRunResult.Cancelled(partial, latestContextTokens);
        }
        catch (OperationCanceledException)
        {
            return LlmRunResult.Failure("本地模型响应超时（长时间无输出）。");
        }
        catch (HttpRequestException ex)
        {
            return LlmRunResult.Failure($"Ollama 请求失败：{ex.Message}");
        }
        catch (JsonException ex)
        {
            return LlmRunResult.Failure($"Ollama 返回格式无效：{ex.Message}");
        }
        catch (Exception ex)
        {
            return LlmRunResult.Failure($"本地模型调用失败：{ex.Message}");
        }
    }

    public void ClearHistory() => _history.Clear();

    public void Dispose() => _http.Dispose();

    private async Task<OllamaReply> SendAsync(
        IReadOnlyList<OllamaMessage> messages,
        Action<LlmStreamUpdate>? onUpdate,
        CancellationToken cancellationToken)
    {
        var request = new OllamaChatRequest(
            _model,
            messages,
            ToolDefinitions,
            true,
            _think,
            new OllamaOptions(0.1, _numPredict, _contextWindow));

        // Linked idle CTS: user cancellation flows in from cancellationToken while
        // CancelAfter acts as a per-chunk hang detector that resets on every line.
        using var idleCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        idleCts.CancelAfter(StreamIdleTimeout);

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/api/chat")
        {
            Content = JsonContent.Create(request, options: JsonOptions)
        };
        using var response = await _http.SendAsync(
            httpRequest,
            HttpCompletionOption.ResponseHeadersRead,
            idleCts.Token);

        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(idleCts.Token);
            throw new HttpRequestException(
                $"{(int)response.StatusCode} {response.ReasonPhrase}: {ReadError(errorBody)}");
        }

        var content = new StringBuilder();
        var toolCalls = new List<LlmToolCall>();
        var promptEvalCount = 0;
        var evalCount = 0;
        var thinking = new StringBuilder();

        await using var stream = await response.Content.ReadAsStreamAsync(idleCts.Token);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        while (await reader.ReadLineAsync(idleCts.Token) is { } line)
        {
            idleCts.CancelAfter(StreamIdleTimeout);
            if (string.IsNullOrWhiteSpace(line))
                continue;

            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;

            if (root.TryGetProperty("error", out var errorElement))
            {
                throw new HttpRequestException(
                    errorElement.GetString() ?? "Ollama 返回了未知错误。");
            }

            if (root.TryGetProperty("message", out var message))
            {
                if (message.TryGetProperty("thinking", out var thinkingElement) &&
                    thinkingElement.ValueKind == JsonValueKind.String)
                {
                    var thinkingDelta = thinkingElement.GetString();
                    if (!string.IsNullOrEmpty(thinkingDelta))
                    {
                        // Same per-delta pattern as the content stream: the
                        // full accumulated chain goes out on every chunk, so
                        // the expander renders it live like a typing effect.
                        thinking.Append(thinkingDelta);
                        onUpdate?.Invoke(new LlmStreamUpdate(
                            LlmStreamKind.Thinking,
                            thinking.ToString()));
                    }
                }

                if (message.TryGetProperty("content", out var contentElement) &&
                    contentElement.ValueKind == JsonValueKind.String)
                {
                    var contentDelta = contentElement.GetString();
                    if (!string.IsNullOrEmpty(contentDelta))
                    {
                        content.Append(contentDelta);
                        onUpdate?.Invoke(new LlmStreamUpdate(
                            LlmStreamKind.Content,
                            content.ToString()));
                    }
                }

                toolCalls.AddRange(ParseToolCalls(message, toolCalls.Count));
            }

            if (root.TryGetProperty("done", out var done) && done.ValueKind == JsonValueKind.True)
            {
                promptEvalCount = root.TryGetProperty("prompt_eval_count", out var promptElement) &&
                                  promptElement.TryGetInt32(out var parsedPrompt)
                    ? parsedPrompt
                    : 0;
                evalCount = root.TryGetProperty("eval_count", out var evalElement) &&
                            evalElement.TryGetInt32(out var parsedEval)
                    ? parsedEval
                    : 0;
            }
        }

        return new OllamaReply(
            content.ToString(),
            toolCalls,
            promptEvalCount,
            evalCount);
    }

    private static IReadOnlyList<LlmToolCall> ParseToolCalls(JsonElement message, int startIndex = 0)
    {
        if (!message.TryGetProperty("tool_calls", out var toolCalls) ||
            toolCalls.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<LlmToolCall>();
        }

        var result = new List<LlmToolCall>();
        var fallbackIndex = startIndex;

        foreach (var call in toolCalls.EnumerateArray())
        {
            if (!call.TryGetProperty("function", out var function))
                continue;

            var name = function.TryGetProperty("name", out var nameElement)
                ? nameElement.GetString() ?? string.Empty
                : string.Empty;
            if (string.IsNullOrWhiteSpace(name))
                continue;

            var id = call.TryGetProperty("id", out var idElement)
                ? idElement.GetString() ?? $"call-{Guid.NewGuid():N}"
                : $"call-{Guid.NewGuid():N}";
            var index = function.TryGetProperty("index", out var indexElement) &&
                        indexElement.TryGetInt32(out var parsedIndex)
                ? parsedIndex
                : fallbackIndex;

            var arguments = function.TryGetProperty("arguments", out var argumentsElement)
                ? ParseArguments(argumentsElement)
                : new Dictionary<string, object?>();

            result.Add(new LlmToolCall(id, index, name, arguments));
            fallbackIndex++;
        }

        return result;
    }

    private static IReadOnlyDictionary<string, object?> ParseArguments(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.String)
        {
            var text = element.GetString();
            if (string.IsNullOrWhiteSpace(text))
                return new Dictionary<string, object?>();

            using var document = JsonDocument.Parse(text);
            return ParseArguments(document.RootElement);
        }

        if (element.ValueKind != JsonValueKind.Object)
            throw new JsonException("工具 arguments 必须是对象或 JSON 字符串。");

        return element.EnumerateObject().ToDictionary(
            property => property.Name,
            property => JsonElementToObject(property.Value));
    }

    private static object? JsonElementToObject(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.String => element.GetString(),
        JsonValueKind.Number => element.TryGetInt64(out var integer)
            ? integer
            : element.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Null => null,
        JsonValueKind.Array => element.EnumerateArray().Select(JsonElementToObject).ToList(),
        JsonValueKind.Object => element.EnumerateObject().ToDictionary(
            property => property.Name,
            property => JsonElementToObject(property.Value)),
        _ => element.ToString()
    };

    private static OllamaToolCall ToWireToolCall(LlmToolCall call) => new(
        call.Id,
        new OllamaFunctionCall(call.Index, call.Name, call.Arguments));

    private void CommitHistory(List<OllamaMessage> messages, string? closeoutForIncompleteTurn = null)
    {
        EnsureCompleteTurnEnding(messages, closeoutForIncompleteTurn);
        _history.AddRange(messages);

        var start = GetValidHistoryStart(_history);
        if (start > 0)
            _history.RemoveRange(0, start);
    }

    // Index of the first message of the trailing MaxHistoryMessages window
    // that does not start on an orphaned "tool" reply (its assistant request
    // was trimmed away). Keeps assistant(tool_calls)/tool pairs intact.
    private static int GetValidHistoryStart(IReadOnlyList<OllamaMessage> messages)
    {
        var start = Math.Max(0, messages.Count - MaxHistoryMessages);
        while (start < messages.Count && messages[start].Role == "tool")
            start++;
        return start;
    }

    // Keeps a single tool result from crowding out the rest of the 16K
    // context window. The tail hint tells the model why data is missing and
    // how to narrow the query, mirroring the plug-in's RESPONSE_TOO_LARGE.
    private static string TruncateToolResult(string toolName, string result)
    {
        if (result.Length <= MaxToolResultChars)
            return result;

        var clipped = result[..MaxToolResultChars];
        if (char.IsHighSurrogate(clipped[^1]))
            clipped = clipped[..^1];

        return clipped +
            "\n\n[工具 " + toolName + " 的结果过大（原始 " +
            result.Length.ToString("N0") + " 字符），已截断至 " +
            MaxToolResultChars.ToString("N0") +
            " 字符。请缩小查询范围后重试：降低 limit、改用 category/property 过滤参数，或减少 itemIds 数量。]";
    }

    // A turn committed to history must never end on a dangling fragment:
    //  - ending on "tool": append the synthetic assistant closeout so the
    //    tool results stay answerable in later turns;
    //  - ending on an assistant(tool_calls) whose tools never ran: drop it,
    //    there is nothing to keep and it would break the pairing.
    private static void EnsureCompleteTurnEnding(List<OllamaMessage> messages, string? closeoutText)
    {
        while (messages.Count > 0)
        {
            var last = messages[^1];
            if (last.Role == "tool")
            {
                if (!string.IsNullOrEmpty(closeoutText))
                    messages.Add(new OllamaMessage("assistant", closeoutText));
                return;
            }

            if (last.Role == "assistant" && last.ToolCalls is { Count: > 0 })
            {
                messages.RemoveAt(messages.Count - 1);
                continue;
            }

            return;
        }
    }

    private static string ReadError(string responseBody)
    {
        try
        {
            using var document = JsonDocument.Parse(responseBody);
            if (document.RootElement.TryGetProperty("error", out var error))
                return error.GetString() ?? responseBody;
        }
        catch (JsonException)
        {
            // Preserve the bounded raw body below.
        }

        return responseBody.Length <= 500 ? responseBody : responseBody[..500];
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static readonly IReadOnlyList<OllamaToolDefinition> ToolDefinitions =
    [
        Tool("navisworks_status", "检查 Navisworks 插件连接状态和当前文档。", new
        {
            type = "object",
            properties = new { }
        }),
        Tool("navisworks_get_document", "读取活动文档、已加载模型、单位和选择数量。", new
        {
            type = "object",
            properties = new { }
        }),
        Tool("navisworks_get_selection", "读取当前选择的构件。", new
        {
            type = "object",
            properties = new
            {
                includeProperties = new { type = "boolean", description = "是否同时返回属性。" },
                limit = new { type = "integer", minimum = 1, maximum = 100 }
            }
        }),
        Tool("navisworks_find_items", "按名称、类别或属性搜索模型构件。", new
        {
            type = "object",
            properties = new
            {
                query = new { type = "string", description = "搜索关键词。" },
                scope = new { type = "string", @enum = new[] { "names", "properties", "all" } },
                match = new { type = "string", @enum = new[] { "contains", "equals" } },
                caseSensitive = new { type = "boolean" },
                limit = new { type = "integer", minimum = 1, maximum = 100 }
            },
            required = new[] { "query" }
        }),
        Tool("navisworks_get_item_properties", "读取一个或多个构件 ID 的属性。", new
        {
            type = "object",
            properties = new
            {
                itemIds = new { type = "array", items = new { type = "string" }, maxItems = 50 },
                category = new { type = "string" },
                property = new { type = "string" }
            },
            required = new[] { "itemIds" }
        }),
        Tool("navisworks_select_items", "选中、添加、移除或清空构件选择。", new
        {
            type = "object",
            properties = new
            {
                itemIds = new { type = "array", items = new { type = "string" }, maxItems = 50 },
                mode = new { type = "string", @enum = new[] { "replace", "add", "remove", "clear" } }
            }
        }),
        Tool("navisworks_set_visibility", "隐藏、显示、隔离构件或重置可见性。", new
        {
            type = "object",
            properties = new
            {
                action = new { type = "string", @enum = new[] { "hide", "show", "isolate", "reset" } },
                itemIds = new { type = "array", items = new { type = "string" }, maxItems = 50 }
            },
            required = new[] { "action" }
        }),
        Tool("navisworks_list_viewpoints", "列出当前文档中的保存视点和文件夹。", new
        {
            type = "object",
            properties = new { }
        }),
        Tool("navisworks_activate_viewpoint", "按 GUID 激活保存视点。", new
        {
            type = "object",
            properties = new
            {
                viewpointId = new { type = "string", description = "保存视点的 GUID。" }
            },
            required = new[] { "viewpointId" }
        })
    ];

    private static OllamaToolDefinition Tool(string name, string description, object parameters) =>
        new("function", new OllamaFunctionDefinition(name, description, parameters));

    private const string SystemPrompt = """
你是一个友好、可靠的 Navisworks 中文助手。

规则：
1. 问候、闲聊、能力介绍和一般知识问题，直接自然回复，不要调用工具。
2. 只有当用户需要读取当前 Navisworks 模型数据，或要求修改当前选择、可见性、视点时，才调用工具。
3. 工具返回后，用简洁自然的中文向用户解释结果；如果完成任务还需要另一个工具，可以继续调用。
4. 不要编造模型、构件、属性、选择或连接状态；这些事实必须来自工具结果。
5. 构件 ID 只在当前 Navisworks 文档和插件会话中有效。用户提到“第一个、第三个”等结果时，使用前面工具结果里的构件 ID。
6. 工具报错时说明实际错误，并给出安全的下一步，不要声称操作成功。
7. 不执行任意脚本，不保存、覆盖或删除 Navisworks 文件。
8. 调用 navisworks_list_viewpoints 后，简要说明视点数量；除非用户明确要求，不要在对话中逐项重复视点名称和 GUID。
""";

    private sealed record OllamaReply(
        string Content,
        IReadOnlyList<LlmToolCall> ToolCalls,
        int PromptEvalCount,
        int EvalCount);

    private sealed record OllamaChatRequest(
        [property: JsonPropertyName("model")] string Model,
        [property: JsonPropertyName("messages")] IReadOnlyList<OllamaMessage> Messages,
        [property: JsonPropertyName("tools")] IReadOnlyList<OllamaToolDefinition> Tools,
        [property: JsonPropertyName("stream")] bool Stream,
        [property: JsonPropertyName("think")] bool Think,
        [property: JsonPropertyName("options")] OllamaOptions Options);

    private sealed record OllamaMessage(
        [property: JsonPropertyName("role")] string Role,
        [property: JsonPropertyName("content")] string Content,
        [property: JsonPropertyName("tool_calls")]
        IReadOnlyList<OllamaToolCall>? ToolCalls = null);

    private sealed record OllamaToolDefinition(
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("function")] OllamaFunctionDefinition Function);

    private sealed record OllamaFunctionDefinition(
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("description")] string Description,
        [property: JsonPropertyName("parameters")] object Parameters);

    private sealed record OllamaToolCall(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("function")] OllamaFunctionCall Function);

    private sealed record OllamaFunctionCall(
        [property: JsonPropertyName("index")] int Index,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("arguments")]
        IReadOnlyDictionary<string, object?> Arguments);

    private sealed record OllamaOptions(
        [property: JsonPropertyName("temperature")] double Temperature,
        [property: JsonPropertyName("num_predict")] int NumPredict,
        [property: JsonPropertyName("num_ctx")] int NumContext);
}
