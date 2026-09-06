using ForgeX.Application;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.6a：与 Node <c>server/index.js</c> 的 60 秒 <c>setInterval</c> 清扫器对等——周期性对每个启用的
/// <see cref="IResourceSweepable"/> 仓库删除过期记录。单个仓库出错只记日志，不影响其他仓库，也不结束循环。
/// 与 Node 一样是「保底」：读路径本身已按 TTL 过滤，清扫只回收磁盘 / 表空间。
/// </summary>
internal sealed class ResourceSweeper : BackgroundService
{
    public static readonly TimeSpan DefaultInterval = TimeSpan.FromSeconds(60);

    private readonly IReadOnlyList<IResourceSweepable> _resources;
    private readonly ILogger<ResourceSweeper> _logger;
    private readonly TimeSpan _interval;
    private long _sweeps;

    public ResourceSweeper(IEnumerable<IResourceSweepable> resources, ILogger<ResourceSweeper> logger)
        : this(resources, logger, DefaultInterval)
    {
    }

    public ResourceSweeper(IEnumerable<IResourceSweepable> resources, ILogger<ResourceSweeper> logger, TimeSpan interval)
    {
        if (interval <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(interval), interval, "Sweep interval must be positive.");
        }

        _resources = resources.ToList();
        _logger = logger;
        _interval = interval;
    }

    /// <summary>Completed sweep rounds (diagnostics / gate).</summary>
    public long Sweeps => Interlocked.Read(ref _sweeps);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (_resources.Count == 0)
        {
            return;
        }

        using var timer = new PeriodicTimer(_interval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await SweepOnceAsync(DateTimeOffset.UtcNow, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // graceful shutdown
        }
    }

    /// <summary>One sweep round over every resource; failures are isolated per resource.</summary>
    public async Task SweepOnceAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        foreach (var resource in _resources)
        {
            try
            {
                var removed = await resource.SweepAsync(now, cancellationToken);
                if (removed > 0)
                {
                    _logger.LogInformation("Swept {Removed} expired {Resource} record(s)", removed, resource.ResourceName);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                _logger.LogWarning(exception, "Sweeping {Resource} failed; will retry next round", resource.ResourceName);
            }
        }

        Interlocked.Increment(ref _sweeps);
    }
}
