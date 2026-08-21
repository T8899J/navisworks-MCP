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
        private readonly CancellationTokenSource cancellation;
        private readonly ManualResetEventSlim listenerReady;
        private readonly string pipeName;
        // Both collections are guarded by pipeSyncRoot. activePipes holds
        // every live server instance (waiting for a client or being served);
        // handlerTasks tracks the per-connection workers so Dispose can wait
        // for them in a bounded way.
        private readonly List<NamedPipeServerStream> activePipes = new List<NamedPipeServerStream>();
        private readonly List<Task> handlerTasks = new List<Task>();
        private Task runTask;
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

            NamedPipeServerStream[] pipesSnapshot;
            Task[] handlersSnapshot;
            lock (pipeSyncRoot)
            {
                pipesSnapshot = activePipes.ToArray();
                handlersSnapshot = handlerTasks.ToArray();
            }

            // Disposing every live instance unlocks both the accept loop's
            // WaitForConnectionAsync and the handlers' blocked reads/writes.
            foreach (NamedPipeServerStream pipe in pipesSnapshot)
            {
                DisposeQuietly(pipe);
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

            try
            {
                Task.WaitAll(handlersSnapshot, TimeSpan.FromSeconds(2));
            }
            catch
            {
                // The pipes are already gone; handlers exit on their own soon after.
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
                NamedPipeServerStream pipe = null;
                try
                {
                    pipe = CreatePipe();

                    lock (pipeSyncRoot)
                    {
                        activePipes.Add(pipe);

                        if (firstListener)
                        {
                            firstListener = false;
                            listenerReady.Set();
                        }

                        PruneCompletedHandlersLocked();
                    }

                    await pipe.WaitForConnectionAsync(
                        cancellationToken).ConfigureAwait(false);

                    // Hand the connected instance to its own worker so the
                    // accept loop immediately offers the next instance; a slow
                    // or busy connection can no longer block new clients.
                    Task handlerTask = HandleConnectionAsync(
                        pipe,
                        cancellationToken);
                    lock (pipeSyncRoot)
                    {
                        handlerTasks.Add(handlerTask);
                    }
                    pipe = null;
                }
                catch (OperationCanceledException)
                {
                    CleanupFailedAccept(pipe);
                    break;
                }
                catch (ObjectDisposedException)
                {
                    CleanupFailedAccept(pipe);
                    if (cancellationToken.IsCancellationRequested)
                    {
                        break;
                    }
                }
                catch (Exception exception)
                {
                    CleanupFailedAccept(pipe);
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
            }
        }

        private async Task HandleConnectionAsync(
            NamedPipeServerStream pipe,
            CancellationToken cancellationToken)
        {
            try
            {
                await ProcessConnectionAsync(
                    pipe,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Shutdown: the pipe is disposed in finally below.
            }
            catch (Exception exception)
            {
                logger.Error(
                    "Bridge connection failed: "
                    + exception.GetType().Name
                    + ": "
                    + exception.Message);
            }
            finally
            {
                lock (pipeSyncRoot)
                {
                    activePipes.Remove(pipe);
                }

                DisposeQuietly(pipe);
            }
        }

        private void CleanupFailedAccept(NamedPipeServerStream pipe)
        {
            if (pipe == null)
            {
                return;
            }

            lock (pipeSyncRoot)
            {
                activePipes.Remove(pipe);
            }

            DisposeQuietly(pipe);
        }

        private static void DisposeQuietly(NamedPipeServerStream pipe)
        {
            try
            {
                pipe.Dispose();
            }
            catch
            {
                // Best-effort teardown during shutdown or error recovery.
            }
        }

        private void PruneCompletedHandlersLocked()
        {
            for (int i = handlerTasks.Count - 1; i >= 0; i--)
            {
                if (handlerTasks[i].IsCompleted)
                {
                    handlerTasks.RemoveAt(i);
                }
            }
        }

        private async Task ProcessConnectionAsync(
            Stream pipe,
            CancellationToken cancellationToken)
        {
            // JavaScriptSerializer has no thread-safety guarantee; concurrent
            // connections each get their own instance.
            JavaScriptSerializer serializer = CreateSerializer();

            while (!cancellationToken.IsCancellationRequested)
            {
                string requestJson = await BridgeFrameProtocol.ReadJsonAsync(
                    pipe,
                    cancellationToken).ConfigureAwait(false);
                if (requestJson == null)
                {
                    return;
                }

                BridgeResponse response = await ProcessRequestAsync(
                    serializer,
                    requestJson).ConfigureAwait(false);

                // Serializing and writing the response must never kill the
                // connection loop: an oversized or undeliverable response is
                // downgraded to a small failure frame instead.
                string responseJson;
                try
                {
                    responseJson = serializer.Serialize(response);
                    await BridgeFrameProtocol.WriteJsonAsync(
                        pipe,
                        responseJson,
                        cancellationToken).ConfigureAwait(false);
                    continue;
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    logger.Error(
                        "Bridge response pipeline failed: "
                        + exception.GetType().Name
                        + ": "
                        + exception.Message);
                    responseJson = serializer.Serialize(
                        BuildDegradedFailure(response, exception));
                }

                // The degraded frame only carries Id/Ok/Error and is far below
                // the frame limit. If this write also fails the pipe is truly
                // broken; let the exception close the connection via RunAsync.
                await BridgeFrameProtocol.WriteJsonAsync(
                    pipe,
                    responseJson,
                    cancellationToken).ConfigureAwait(false);
            }
        }

        private static BridgeResponse BuildDegradedFailure(
            BridgeResponse response,
            Exception exception)
        {
            bool tooLarge = exception is BridgeException
                || exception is ArgumentException
                || exception is InvalidOperationException;
            string code = tooLarge
                ? "RESPONSE_TOO_LARGE"
                : "BRIDGE_RESPONSE_WRITE_FAILED";
            string message = tooLarge
                ? "Navisworks response exceeded the one MiB protocol limit. "
                    + "Narrow the query: request fewer items, use the "
                    + "category/property filters, or lower the limit."
                : "Navisworks could not deliver the response.";
            return BridgeResponse.Failure(response.Id, code, message);
        }

        private async Task<BridgeResponse> ProcessRequestAsync(
            JavaScriptSerializer serializer,
            string requestJson)
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

        private static JavaScriptSerializer CreateSerializer()
        {
            return new JavaScriptSerializer
            {
                MaxJsonLength = BridgeConstants.MaxFrameBytes,
                RecursionLimit = 100
            };
        }

        private NamedPipeServerStream CreatePipe()
        {
            return new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,

                // Live instances = in-flight handlers + one acceptor. Eight
                // leaves ample headroom over the real concurrency peak while
                // keeping the handler count bounded.
                8,
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
