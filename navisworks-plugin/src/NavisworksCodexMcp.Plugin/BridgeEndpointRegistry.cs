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
        private readonly string endpointFile;

        public BridgeEndpointRegistry()
        {
            serializer = new JavaScriptSerializer
            {
                MaxJsonLength = BridgeConstants.MaxFrameBytes
            };
            endpointFile = Path.Combine(GetDataDirectory(), "endpoint.json");
        }

        public static string GetDataDirectory()
        {
            return Path.Combine(
                Environment.GetFolderPath(
                    Environment.SpecialFolder.LocalApplicationData),
                "NavisworksCodexMcp");
        }

        public void Write(string pipeName, string pluginVersion, string hostVersion)
        {
            Directory.CreateDirectory(GetDataDirectory());

            var endpoint = new BridgeEndpoint
            {
                ProtocolVersion = BridgeConstants.ProtocolVersion,
                PipeName = pipeName,
                ProcessId = Process.GetCurrentProcess().Id,
                PluginVersion = pluginVersion,
                HostVersion = hostVersion,
                StartedAtUtc = DateTime.UtcNow.ToString("O")
            };

            string temporaryFile = endpointFile + ".tmp-"
                + Process.GetCurrentProcess().Id;
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

