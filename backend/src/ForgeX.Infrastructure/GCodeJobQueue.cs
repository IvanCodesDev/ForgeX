using System.Threading.Channels;
using ForgeX.Application;

namespace ForgeX.Infrastructure;

public sealed class GCodeJobQueue : IGCodeJobQueue
{
    private readonly Channel<string> _channel;

    public GCodeJobQueue(int capacity = 64)
    {
        _channel = Channel.CreateBounded<string>(new BoundedChannelOptions(capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
        });
    }

    public bool IsAccepting => !_channel.Reader.Completion.IsCompleted;

    public ValueTask EnqueueAsync(string jobId, CancellationToken cancellationToken) =>
        _channel.Writer.WriteAsync(jobId, cancellationToken);

    public IAsyncEnumerable<string> ReadAllAsync(CancellationToken cancellationToken) =>
        _channel.Reader.ReadAllAsync(cancellationToken);
}
