using System.Text.Json.Serialization;

namespace NavisworksMcp.Console.Bridge;

internal static class BridgeConstants
{
    public const int ProtocolVersion = 1;
    public const int MaxFrameBytes = 1024 * 1024;
    public const int DefaultRequestTimeoutMs = 15_000;
}

internal sealed class BridgeRequest
{
    [JsonPropertyName("Id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("ProtocolVersion")]
    public int ProtocolVersion { get; set; }

    [JsonPropertyName("Method")]
    public string Method { get; set; } = string.Empty;

    [JsonPropertyName("Params")]
    public Dictionary<string, object?>? Params { get; set; }
}

internal sealed class BridgeResponse
{
    [JsonPropertyName("Id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("Ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("Result")]
    public object? Result { get; set; }

    [JsonPropertyName("Error")]
    public BridgeFailure? Error { get; set; }
}

internal sealed class BridgeFailure
{
    [JsonPropertyName("Code")]
    public string Code { get; set; } = string.Empty;

    [JsonPropertyName("Message")]
    public string Message { get; set; } = string.Empty;
}

internal sealed class BridgeEndpoint
{
    [JsonPropertyName("ProtocolVersion")]
    public int ProtocolVersion { get; set; }

    [JsonPropertyName("PipeName")]
    public string PipeName { get; set; } = string.Empty;

    [JsonPropertyName("ProcessId")]
    public int ProcessId { get; set; }

    [JsonPropertyName("PluginVersion")]
    public string PluginVersion { get; set; } = string.Empty;

    [JsonPropertyName("HostVersion")]
    public string HostVersion { get; set; } = string.Empty;

    [JsonPropertyName("StartedAtUtc")]
    public string StartedAtUtc { get; set; } = string.Empty;
}

internal sealed class BridgeException : Exception
{
    public string Code { get; }

    public BridgeException(string code, string message, Exception? inner = null)
        : base(message, inner)
    {
        Code = code;
    }
}