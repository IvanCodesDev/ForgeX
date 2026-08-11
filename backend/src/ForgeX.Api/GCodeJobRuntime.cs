using System.Collections.Concurrent;

namespace ForgeX.Api;

internal sealed class GCodeJobRuntime
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _running = new(StringComparer.Ordinal);

    public bool Register(string jobId, CancellationTokenSource cancellation) => _running.TryAdd(jobId, cancellation);

    public void Unregister(string jobId)
    {
        if (_running.TryRemove(jobId, out var cancellation)) cancellation.Dispose();
    }

    public bool Cancel(string jobId)
    {
        if (!_running.TryGetValue(jobId, out var cancellation)) return false;
        try
        {
            cancellation.Cancel();
            return true;
        }
        catch (ObjectDisposedException)
        {
            return false;
        }
    }
}
