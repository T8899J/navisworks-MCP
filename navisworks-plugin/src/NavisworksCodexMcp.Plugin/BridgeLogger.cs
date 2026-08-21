using System;
using System.IO;

namespace NavisworksCodexMcp.Plugin
{
    internal sealed class BridgeLogger
    {
        private const long MaxLogBytes = 1024 * 1024;
        private readonly object syncRoot = new object();
        private readonly string logFile;
        private readonly string oldLogFile;

        public BridgeLogger()
        {
            string directory = BridgeEndpointRegistry.GetDataDirectory();
            logFile = Path.Combine(directory, "bridge.log");
            oldLogFile = Path.Combine(directory, "bridge.old.log");
        }

        public void Info(string message)
        {
            Write("INFO", message);
        }

        public void Error(string message)
        {
            Write("ERROR", message);
        }

        private void Write(string level, string message)
        {
            try
            {
                lock (syncRoot)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(logFile));
                    RotateIfNeeded();
                    File.AppendAllText(
                        logFile,
                        string.Format(
                            "{0:O} [{1}] {2}{3}",
                            DateTime.UtcNow,
                            level,
                            message,
                            Environment.NewLine));
                }
            }
            catch
            {
                // Logging must never prevent Navisworks from loading.
            }
        }

        private void RotateIfNeeded()
        {
            if (!File.Exists(logFile)
                || new FileInfo(logFile).Length < MaxLogBytes)
            {
                return;
            }

            if (File.Exists(oldLogFile))
            {
                File.Delete(oldLogFile);
            }

            File.Move(logFile, oldLogFile);
        }
    }
}

