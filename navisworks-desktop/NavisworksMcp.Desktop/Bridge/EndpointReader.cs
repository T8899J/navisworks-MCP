using System.Text.Json;

namespace NavisworksMcp.Console.Bridge;

internal static class EndpointReader
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false
    };

    public static string GetDefaultEndpointFile()
    {
        var explicitPath = Environment.GetEnvironmentVariable("NAVISWORKS_MCP_ENDPOINT_FILE");
        if (!string.IsNullOrWhiteSpace(explicitPath))
        {
            return explicitPath;
        }

        var localAppData = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(localAppData, "NavisworksCodexMcp", "endpoint.json");
    }

    public static async Task<BridgeEndpoint> ReadAsync(string? endpointFile = null)
    {
        var filePath = endpointFile ?? GetDefaultEndpointFile();

        string json;
        try
        {
            json = await File.ReadAllTextAsync(filePath);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            throw new BridgeException(
                "NAVISWORKS_NOT_CONNECTED",
                "Navisworks MCP plug-in is not running. Start or restart Navisworks Manage 2023.",
                ex);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new BridgeException(
                "ENDPOINT_READ_FAILED",
                $"Cannot read the Navisworks bridge endpoint file: {ex.Message}",
                ex);
        }

        BridgeEndpoint? endpoint;
        try
        {
            endpoint = JsonSerializer.Deserialize<BridgeEndpoint>(json, JsonOptions);
        }
        catch (JsonException ex)
        {
            throw new BridgeException(
                "INVALID_ENDPOINT",
                "Navisworks bridge endpoint file contains invalid JSON.",
                ex);
        }

        if (endpoint == null
            || string.IsNullOrWhiteSpace(endpoint.PipeName)
            || endpoint.ProtocolVersion != BridgeConstants.ProtocolVersion)
        {
            throw new BridgeException(
                "INVALID_ENDPOINT",
                endpoint == null
                    ? "Navisworks bridge endpoint file is empty."
                    : $"Expected bridge protocol {BridgeConstants.ProtocolVersion}, " +
                      $"received {endpoint.ProtocolVersion}.");
        }

        return endpoint;
    }
}