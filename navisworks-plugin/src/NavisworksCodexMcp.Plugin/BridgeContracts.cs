using System;
using System.Collections.Generic;

namespace NavisworksCodexMcp.Plugin
{
    internal static class BridgeConstants
    {
        public const int ProtocolVersion = 1;
        public const int MaxFrameBytes = 1024 * 1024;
    }

    internal sealed class BridgeRequest
    {
        public string Id { get; set; }

        public int ProtocolVersion { get; set; }

        public string Method { get; set; }

        public Dictionary<string, object> Params { get; set; }
    }

    internal sealed class BridgeResponse
    {
        public string Id { get; set; }

        public bool Ok { get; set; }

        public object Result { get; set; }

        public BridgeFailure Error { get; set; }

        public static BridgeResponse Success(string id, object result)
        {
            return new BridgeResponse
            {
                Id = id ?? string.Empty,
                Ok = true,
                Result = result
            };
        }

        public static BridgeResponse Failure(
            string id,
            string code,
            string message)
        {
            return new BridgeResponse
            {
                Id = id ?? string.Empty,
                Ok = false,
                Error = new BridgeFailure
                {
                    Code = code,
                    Message = message
                }
            };
        }
    }

    internal sealed class BridgeFailure
    {
        public string Code { get; set; }

        public string Message { get; set; }
    }

    internal sealed class BridgeEndpoint
    {
        public int ProtocolVersion { get; set; }

        public string PipeName { get; set; }

        public int ProcessId { get; set; }

        public string PluginVersion { get; set; }

        public string HostVersion { get; set; }

        public string StartedAtUtc { get; set; }
    }

    internal sealed class BridgeException : Exception
    {
        public BridgeException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        public string Code { get; private set; }
    }
}

