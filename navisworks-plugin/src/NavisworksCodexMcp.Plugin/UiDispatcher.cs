using System;
using System.Threading;
using System.Threading.Tasks;

namespace NavisworksCodexMcp.Plugin
{
    internal sealed class UiDispatcher
    {
        private readonly SynchronizationContext synchronizationContext;

        public UiDispatcher(SynchronizationContext synchronizationContext)
        {
            this.synchronizationContext = synchronizationContext
                ?? throw new ArgumentNullException("synchronizationContext");
        }

        public Task<object> InvokeAsync(Func<object> action)
        {
            return InvokeAsync<object>(action);
        }

        public Task<T> InvokeAsync<T>(Func<T> action)
        {
            if (action == null)
            {
                throw new ArgumentNullException("action");
            }

            if (SynchronizationContext.Current == synchronizationContext)
            {
                try
                {
                    return Task.FromResult(action());
                }
                catch (Exception exception)
                {
                    var failed = new TaskCompletionSource<T>(
                        TaskCreationOptions.RunContinuationsAsynchronously);
                    failed.SetException(exception);
                    return failed.Task;
                }
            }

            var completion = new TaskCompletionSource<T>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            synchronizationContext.Post(
                state =>
                {
                    try
                    {
                        completion.SetResult(action());
                    }
                    catch (Exception exception)
                    {
                        completion.SetException(exception);
                    }
                },
                null);
            return completion.Task;
        }
    }
}

