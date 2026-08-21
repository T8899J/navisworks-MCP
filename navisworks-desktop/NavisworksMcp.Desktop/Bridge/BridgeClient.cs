using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace NavisworksMcp.Console.Bridge;

internal sealed class BridgeClient : IDisposable
{
    private readonly string _endpointFile;
    private readonly int _requestTimeoutMs;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false
    };

    public BridgeClient(string? endpointFile = null, int requestTimeoutMs = BridgeConstants.DefaultRequestTimeoutMs)
    {
        _endpointFile = endpointFile ?? EndpointReader.GetDefaultEndpointFile();
        _requestTimeoutMs = requestTimeoutMs;
    }

    public async Task<object?> CallAsync(string method, Dictionary<string, object?>? parameters = null)
    {
        var endpoint = await EndpointReader.ReadAsync(_endpointFile);
        var pipePath = $@"\\.\pipe\{endpoint.PipeName}";

        var request = new BridgeRequest
        {
            Id = Guid.NewGuid().ToString("D"),
            ProtocolVersion = BridgeConstants.ProtocolVersion,
            Method = method,
            Params = parameters ?? new Dictionary<string, object?>()
        };

        var rawResponse = await ExchangeFrameAsync(pipePath, request, _requestTimeoutMs);

        BridgeResponse? response;
        try
        {
            response = JsonSerializer.Deserialize<BridgeResponse>(rawResponse, JsonOptions);
        }
        catch (JsonException ex)
        {
            throw new BridgeException(
                "INVALID_RESPONSE",
                "Navisworks bridge returned an invalid response.",
                ex);
        }

        if (response == null)
        {
            throw new BridgeException(
                "INVALID_RESPONSE",
                "Navisworks bridge returned an empty response.");
        }

        if (response.Id != request.Id)
        {
            throw new BridgeException(
                "RESPONSE_ID_MISMATCH",
                "Navisworks bridge returned a response for another request.");
        }

        if (!response.Ok)
        {
            throw new BridgeException(
                response.Error?.Code ?? "NAVISWORKS_ERROR",
                response.Error?.Message ?? "Navisworks rejected the request.");
        }

        return response.Result;
    }

    public void Dispose()
    {
        // No persistent resources to dispose.
    }

    // ---------------------------------------------------------------
    //  Frame protocol
    // ---------------------------------------------------------------

    private static async Task<string> ExchangeFrameAsync(
        string pipePath,
        BridgeRequest request,
        int timeoutMs)
    {
        using var cts = new CancellationTokenSource(timeoutMs);
        using var pipe = new NamedPipeClientStream(
            ".",
            pipePath.Replace(@"\\.\pipe\", ""),
            PipeDirection.InOut,
            PipeOptions.Asynchronous);

        try
        {
            await pipe.ConnectAsync(timeoutMs, cts.Token);

            // Write frame
            var payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request, JsonOptions));
            if (payload.Length > BridgeConstants.MaxFrameBytes)
            {
                throw new BridgeException(
                    "FRAME_TOO_LARGE",
                    $"Bridge payload exceeds {BridgeConstants.MaxFrameBytes} bytes.");
            }

            var header = new byte[4];
            header[0] = (byte)(payload.Length & 0xFF);
            header[1] = (byte)((payload.Length >> 8) & 0xFF);
            header[2] = (byte)((payload.Length >> 16) & 0xFF);
            header[3] = (byte)((payload.Length >> 24) & 0xFF);

            await pipe.WriteAsync(header, cts.Token);
            await pipe.WriteAsync(payload, cts.Token);
            await pipe.FlushAsync(cts.Token);

            // Read response header
            var responseHeader = new byte[4];
            await ReadExactlyAsync(pipe, responseHeader, cts.Token);

            var responseLength = responseHeader[0]
                | (responseHeader[1] << 8)
                | (responseHeader[2] << 16)
                | (responseHeader[3] << 24);

            if (responseLength <= 0 || responseLength > BridgeConstants.MaxFrameBytes)
            {
                throw new BridgeException(
                    "INVALID_FRAME_LENGTH",
                    "Bridge frame length is outside the allowed range.");
            }

            // Read response payload
            var responsePayload = new byte[responseLength];
            await ReadExactlyAsync(pipe, responsePayload, cts.Token);

            return Encoding.UTF8.GetString(responsePayload);
        }
        catch (BridgeException)
        {
            throw;
        }
        catch (TimeoutException ex)
        {
            throw new BridgeException(
                "NAVISWORKS_TIMEOUT",
                $"Navisworks did not respond within {timeoutMs} ms.",
                ex);
        }
        catch (OperationCanceledException ex)
        {
            throw new BridgeException(
                "NAVISWORKS_TIMEOUT",
                $"Navisworks did not respond within {timeoutMs} ms.",
                ex);
        }
        catch (Exception ex)
        {
            throw new BridgeException(
                "BRIDGE_IO",
                $"Navisworks bridge I/O failed: {ex.Message}",
                ex);
        }
    }

    private static async Task ReadExactlyAsync(
        PipeStream pipe,
        byte[] buffer,
        CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var bytesRead = await pipe.ReadAsync(
                buffer.AsMemory(offset, buffer.Length - offset),
                cancellationToken);

            if (bytesRead == 0)
            {
                throw new EndOfStreamException(
                    "Bridge connection ended in the middle of a frame.");
            }

            offset += bytesRead;
        }
    }
}