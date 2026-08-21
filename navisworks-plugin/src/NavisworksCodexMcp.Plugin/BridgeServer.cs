using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace NavisworksCodexMcp.Plugin
{
    internal sealed class BridgeServer : IDisposable
    {
        private readonly object pipeSyncRoot = new object();
        private readonly UiDispatcher uiDispatcher;
        private readonly NavisworksToolService toolService;
        private readonly BridgeLogger logger;
        private readonly BridgeEndpointRegistry endpointRegistry;
        private readonly JavaScriptSerializer serializer;
        private readonly CancellationTokenSource cancellation;
        private readonly ManualResetEventSlim listenerReady;
        private readonly string pipeName;
        private Task runTask;
        private NamedPipeServerStream activePipe;
        private bool disposed;

        public BridgeServer(
            UiDispatcher uiDispatcher,
            NavisworksToolService toolService,
            BridgeLogger logger)
        {
            this.uiDispatcher = uiDispatcher
                ?? throw new ArgumentNullException("uiDispatcher");
            this.toolService = toolService
                ?? throw new ArgumentNullException("toolService");
            this.logger = logger ?? throw new ArgumentNullException("logger");

            endpointRegistry = new BridgeEndpointRegistry();
            serializer = new JavaScriptSerializer
            {
                MaxJsonLength = BridgeConstants.MaxFrameBytes,
                RecursionLimit = 100
            };
            cancellation = new CancellationTokenSource();
            listenerReady = new ManualResetEventSlim(false);
            pipeName = string.Format(
                "navisworks-codex-mcp-2023-{0}-{1:N}",
                Process.GetCurrentProcess().Id,
                Guid.NewGuid());
        }

        public void Start()
        {
            ThrowIfDisposed();
            runTask = Task.Run(() => RunAsync(cancellation.Token));

            if (!listenerReady.Wait(TimeSpan.FromSeconds(3)))
            {
                throw new BridgeException(
                    "BRIDGE_START_TIMEOUT",
                    "Timed out while starting the named-pipe listener.");
            }

            string pluginVersion = Assembly
                .GetExecutingAssembly()
                .GetName()
                .Version
                .ToString();
            string hostVersion = GetHostVersion();
            endpointRegistry.Write(pipeName, pluginVersion, hostVersion);
            logger.Info("Bridge listener started for Navisworks " + hostVersion + ".");
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            cancellation.Cancel();

            lock (pipeSyncRoot)
            {
                if (activePipe != null)
                {
                    activePipe.Dispose();
                    activePipe = null;
                }
            }

            if (runTask != null)
            {
                try
                {
                    runTask.Wait(TimeSpan.FromSeconds(2));
                }
                catch
                {
                    // Navisworks shutdown must not block on the bridge worker.
                }
            }

            endpointRegistry.DeleteIfOwned(pipeName);
            listenerReady.Dispose();
            cancellation.Dispose();
            logger.Info("Bridge listener stopped.");
        }

        private async Task RunAsync(CancellationToken cancellationToken)
        {
            bool firstListener = true;

            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    using (NamedPipeServerStream pipe = CreatePipe())
                    {
                        lock (pipeSyncRoot)
                        {
                            activePipe = pipe;
                        }

                        if (firstListener)
                        {
                            firstListener = false;
                            listenerReady.Set();
                        }

                        await pipe.WaitForConnectionAsync(
                            cancellationToken).ConfigureAwait(false);
                        await ProcessConnectionAsync(
                            pipe,
                            cancellationToken).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (ObjectDisposedException)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        break;
                    }
                }
                catch (Exception exception)
                {
                    logger.Error(
                        "Bridge listener error: "
                        + exception.GetType().Name
                        + ": "
                        + exception.Message);

                    try
                    {
                        await Task.Delay(250, cancellationToken)
                            .ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        break;
                    }
                }
                finally
                {
                    lock (pipeSyncRoot)
                    {
                        activePipe = null;
                    }
                }
            }
        }

        private async Task ProcessConnectionAsync(
            Stream pipe,
            CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                string requestJson = await BridgeFrameProtocol.ReadJsonAsync(
                    pipe,
                    cancellationToken).ConfigureAwait(false);
                if (requestJson == null)
                {
                    return;
                }

                BridgeResponse response = await ProcessRequestAsync(requestJson)
                    .ConfigureAwait(false);
                string responseJson = serializer.Serialize(response);
                await BridgeFrameProtocol.WriteJsonAsync(
                    pipe,
                    responseJson,
                    cancellationToken).ConfigureAwait(false);
            }
        }

        private async Task<BridgeResponse> ProcessRequestAsync(string requestJson)
        {
            BridgeRequest request = null;

            try
            {
                request = serializer.Deserialize<BridgeRequest>(requestJson);
                ValidateRequest(request);

                object result = await uiDispatcher.InvokeAsync(
                    () => toolService.Execute(
                        request.Method,
                        request.Params
                            ?? new Dictionary<string, object>()))
                    .ConfigureAwait(false);
                return BridgeResponse.Success(request.Id, result);
            }
            catch (BridgeException exception)
            {
                return BridgeResponse.Failure(
                    request == null ? string.Empty : request.Id,
                    exception.Code,
                    exception.Message);
            }
            catch (Exception exception)
            {
                logger.Error(
                    "Tool request failed: "
                    + exception.GetType().Name
                    + ": "
                    + exception.Message);
                return BridgeResponse.Failure(
                    request == null ? string.Empty : request.Id,
                    "NAVISWORKS_ERROR",
                    "Navisworks could not complete the requested operation.");
            }
        }

        private static void ValidateRequest(BridgeRequest request)
        {
            if (request == null)
            {
                throw new BridgeException(
                    "INVALID_REQUEST",
                    "Bridge request is missing.");
            }

            if (request.ProtocolVersion != BridgeConstants.ProtocolVersion)
            {
                throw new BridgeException(
                    "PROTOCOL_MISMATCH",
                    "Bridge protocol version is not supported.");
            }

            if (string.IsNullOrWhiteSpace(request.Id)
                || request.Id.Length > 100)
            {
                throw new BridgeException(
                    "INVALID_REQUEST_ID",
                    "Bridge request ID is invalid.");
            }

            if (string.IsNullOrWhiteSpace(request.Method)
                || request.Method.Length > 100)
            {
                throw new BridgeException(
                    "INVALID_METHOD",
                    "Bridge method is invalid.");
            }
        }

        private NamedPipeServerStream CreatePipe()
        {
            return new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                BridgeConstants.MaxFrameBytes,
                BridgeConstants.MaxFrameBytes,
                CreateCurrentUserPipeSecurity());
        }

        private static PipeSecurity CreateCurrentUserPipeSecurity()
        {
            SecurityIdentifier currentUser =
                WindowsIdentity.GetCurrent().User;
            if (currentUser == null)
            {
                throw new BridgeException(
                    "WINDOWS_IDENTITY_UNAVAILABLE",
                    "Cannot determine the current Windows user.");
            }

            var pipeSecurity = new PipeSecurity();
            pipeSecurity.SetAccessRuleProtection(true, false);
            pipeSecurity.SetOwner(currentUser);
            pipeSecurity.AddAccessRule(
                new PipeAccessRule(
                    currentUser,
                    PipeAccessRights.ReadWrite
                        | PipeAccessRights.CreateNewInstance,
                    AccessControlType.Allow));
            return pipeSecurity;
        }

        private static string GetHostVersion()
        {
            try
            {
                return Process
                    .GetCurrentProcess()
                    .MainModule
                    .FileVersionInfo
                    .FileVersion;
            }
            catch
            {
                return "20.x";
            }
        }

        private void ThrowIfDisposed()
        {
            if (disposed)
            {
                throw new ObjectDisposedException("BridgeServer");
            }
        }
    }
}
