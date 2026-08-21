using System;
using System.Threading;
using Autodesk.Navisworks.Api;
using Autodesk.Navisworks.Api.Plugins;

namespace NavisworksCodexMcp.Plugin
{
    [Plugin(
        "NavisworksCodexMcp",
        "CDXM",
        DisplayName = "Navisworks Codex MCP",
        ToolTip = "Connect the current Navisworks session to local Codex MCP.")]
    public sealed class NavisworksMcpPlugin : EventWatcherPlugin
    {
        private BridgeLogger logger;
        private NavisworksToolService toolService;
        private BridgeServer bridgeServer;

        public override void OnLoaded()
        {
            logger = new BridgeLogger();

            try
            {
                SynchronizationContext context = SynchronizationContext.Current;
                if (context == null)
                {
                    context =
                        new System.Windows.Forms.WindowsFormsSynchronizationContext();
                    SynchronizationContext.SetSynchronizationContext(context);
                }

                toolService = new NavisworksToolService();
                Application.ActiveDocumentChanged += OnActiveDocumentChanged;

                bridgeServer = new BridgeServer(
                    new UiDispatcher(context),
                    toolService,
                    logger);
                bridgeServer.Start();
            }
            catch (Exception exception)
            {
                logger.Error(
                    "Plugin startup failed: "
                    + exception.GetType().Name
                    + ": "
                    + exception.Message);
                DisposeBridge();
            }
        }

        public override void OnUnloading()
        {
            Application.ActiveDocumentChanged -= OnActiveDocumentChanged;
            DisposeBridge();
        }

        private void OnActiveDocumentChanged(object sender, EventArgs eventArgs)
        {
            if (toolService != null)
            {
                toolService.ResetSessionState();
            }
        }

        private void DisposeBridge()
        {
            if (bridgeServer != null)
            {
                bridgeServer.Dispose();
                bridgeServer = null;
            }
        }
    }
}
