using System.Collections.Concurrent;
using ForgeX.Application;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.6a：把启用的资源仓库采样成 Node 同名 gauge（<c>forgex_datasources</c> / <c>forgex_knowledge_docs</c> /
/// <c>forgex_shares</c> / <c>forgex_calibrations_approved</c> / <c>forgex_calibrations_pending</c>）。
/// 采样失败时输出上次成功值并记日志——/metrics 不该因为某个存储腿抖动而整体 500。
/// </summary>
internal sealed class ResourceGaugeSampler(
    IEnumerable<IResourceSweepable> resources,
    ICalibrationGovernanceStore? calibrations,
    ILogger<ResourceGaugeSampler> logger)
{
    private static readonly IReadOnlyDictionary<string, (string Metric, string Help)> KnownResources =
        new Dictionary<string, (string, string)>(StringComparer.Ordinal)
        {
            ["datasources"] = ("forgex_datasources", "已存数据源数"),
            ["knowledge"] = ("forgex_knowledge_docs", "已存知识文档数"),
            ["shares"] = ("forgex_shares", "有效分享页数"),
        };

    private readonly IReadOnlyList<IResourceSweepable> _resources = resources.ToList();
    private readonly ConcurrentDictionary<string, long> _lastValues = new(StringComparer.Ordinal);

    public async Task<IReadOnlyList<ForgeXMetrics.ResourceGauge>> SampleAsync(CancellationToken cancellationToken)
    {
        var gauges = new List<ForgeXMetrics.ResourceGauge>();
        foreach (var resource in _resources)
        {
            var (metric, help) = KnownResources.TryGetValue(resource.ResourceName, out var known)
                ? known
                : ("forgex_" + resource.ResourceName, resource.ResourceName + " records");
            long value;
            try
            {
                value = await resource.CountAsync(cancellationToken);
                _lastValues[metric] = value;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                value = _lastValues.GetValueOrDefault(metric);
                logger.LogWarning(exception, "Sampling {Metric} failed; reporting last known value {Value}", metric, value);
            }

            gauges.Add(new ForgeXMetrics.ResourceGauge(metric, help, value));
        }

        if (calibrations is not null)
        {
            long approved;
            long pending;
            try
            {
                var stats = await calibrations.StatsAsync(cancellationToken);
                approved = stats.Approved;
                pending = stats.Pending;
                _lastValues["forgex_calibrations_approved"] = approved;
                _lastValues["forgex_calibrations_pending"] = pending;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                approved = _lastValues.GetValueOrDefault("forgex_calibrations_approved");
                pending = _lastValues.GetValueOrDefault("forgex_calibrations_pending");
                logger.LogWarning(exception, "Sampling calibration governance stats failed; reporting last known values");
            }

            gauges.Add(new ForgeXMetrics.ResourceGauge("forgex_calibrations_approved", "已发布校准 bundle 数", approved));
            gauges.Add(new ForgeXMetrics.ResourceGauge("forgex_calibrations_pending", "待审核校准 bundle 数", pending));
        }

        return gauges;
    }
}
