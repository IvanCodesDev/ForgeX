using System.Globalization;

namespace ForgeX.Analytics;

public static class AnalyticsKpiEngine
{
    public static AnalyticsKpis Calculate(IReadOnlyList<AnalyticsRow> rows)
    {
        ArgumentNullException.ThrowIfNull(rows);
        var failures = rows.Count(static row => row.Status == AnalyticsStatus.Fail);
        var successes = rows.Count - failures;
        var costFen = rows.Sum(static row => row.CostFen);
        var groups = rows
            .GroupBy(static row => string.IsNullOrEmpty(row.MachineId) ? "未知" : row.MachineId, StringComparer.Ordinal)
            .Select(static group => new RateGroup(
                group.Key,
                group.Count(static row => row.Status == AnalyticsStatus.Fail),
                group.Count()))
            .ToArray();
        var ranking = AnalyticsStatistics.RankByRate(groups);
        var top = ranking.Ranked.Count > 0 ? ranking.Ranked[0] : null;
        var worst = top is null
            ? null
            : new AnalyticsWorstMachine(
                top.Key,
                top.Rate,
                top.N,
                top.Ci,
                top.PValue,
                top.Significant);

        var reasonCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        var reasonOrder = new List<string>();
        foreach (var row in rows)
        {
            if (row.Status != AnalyticsStatus.Fail || string.IsNullOrEmpty(row.FailReason)) continue;
            if (!reasonCounts.TryAdd(row.FailReason, 1)) reasonCounts[row.FailReason]++;
            else reasonOrder.Add(row.FailReason);
        }
        AnalyticsTopReason? topReason = null;
        foreach (var reason in reasonOrder)
        {
            var count = reasonCounts[reason];
            if (topReason is null || count > topReason.N) topReason = new AnalyticsTopReason(reason, count);
        }

        return new AnalyticsKpis(
            rows.Count,
            rows.Count > 0 ? (double)successes / rows.Count : 0,
            successes > 0 ? (long)Math.Floor(costFen / successes + 0.5) : 0,
            rows.Sum(static row => row.FilamentG) / 1000,
            rows.Sum(static row => row.EnergyKwh),
            worst,
            topReason,
            ranking.Ranked.Count,
            DateRange(rows));
    }

    private static AnalyticsDateRange? DateRange(IReadOnlyList<AnalyticsRow> rows)
    {
        string? from = null;
        string? to = null;
        foreach (var row in rows)
        {
            if (string.IsNullOrEmpty(row.Date)) continue;
            if (from is null || string.CompareOrdinal(row.Date, from) < 0) from = row.Date;
            if (to is null || string.CompareOrdinal(row.Date, to) > 0) to = row.Date;
        }
        if (from is null || to is null) return null;

        var days = 1;
        if (DateOnly.TryParseExact(from, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var start) &&
            DateOnly.TryParseExact(to, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var end))
        {
            days = Math.Max(1, end.DayNumber - start.DayNumber + 1);
        }
        var label = days <= 1 ? from : $"{from} → {to}（{days} 天）";
        return new AnalyticsDateRange(from, to, days, label);
    }
}
