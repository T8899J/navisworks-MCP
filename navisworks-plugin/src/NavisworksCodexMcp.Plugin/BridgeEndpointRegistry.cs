using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace NavisworksCodexMcp.Plugin
{
    internal sealed class BridgeEndpointRegistry
    {
        private readonly JavaScriptSerializer serializer;
        private readonly int processId;
        private readonly string endpointFile;

        public BridgeEndpointRegistry()
            : this(GetDataDirectory(), Process.GetCurrentProcess().Id)
        {
        }

        internal BridgeEndpointRegistry(string dataDirectory, int processId)
        {
            serializer = new JavaScriptSerializer
            {
                MaxJsonLength = BridgeConstants.MaxFrameBytes
            };
            this.processId = processId;
            endpointFile = Path.Combine(
                GetEndpointsDirectory(dataDirectory),
                processId + ".json");
        }

        public static string GetDataDirectory()
        {
            return Path.Combine(
                Environment.GetFolderPath(
                    Environment.SpecialFolder.LocalApplicationData),
                "NavisworksCodexMcp");
        }

        public static string GetEndpointsDirectory()
        {
            return GetEndpointsDirectory(GetDataDirectory());
        }

        private static string GetEndpointsDirectory(string dataDirectory)
        {
            return Path.Combine(dataDirectory, "endpoints");
        }

        public void Write(string pipeName, string pluginVersion, string hostVersion)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(endpointFile));

            var endpoint = new BridgeEndpoint
            {
                ProtocolVersion = BridgeConstants.ProtocolVersion,
                PipeName = pipeName,
                ProcessId = processId,
                PluginVersion = pluginVersion,
                HostVersion = hostVersion,
                StartedAtUtc = DateTime.UtcNow.ToString("O")
            };

            string temporaryFile = endpointFile + ".tmp-"
                + processId;
            File.WriteAllText(
                temporaryFile,
                serializer.Serialize(endpoint),
                new UTF8Encoding(false));

            try
            {
                File.Replace(temporaryFile, endpointFile, null);
            }
            catch (FileNotFoundException)
            {
                // First write in this data directory: nothing to replace yet.
                File.Move(temporaryFile, endpointFile);
            }
        }

        public void DeleteIfOwned(string pipeName)
        {
            try
            {
                if (!File.Exists(endpointFile))
                {
                    return;
                }

                BridgeEndpoint endpoint = serializer.Deserialize<BridgeEndpoint>(
                    File.ReadAllText(endpointFile, Encoding.UTF8));
                if (endpoint != null
                    && string.Equals(
                        endpoint.PipeName,
                        pipeName,
                        StringComparison.Ordinal))
                {
                    File.Delete(endpointFile);
                }
            }
            catch
            {
                // A stale endpoint is harmless; the MCP client will fail closed.
            }
        }
    }
}
