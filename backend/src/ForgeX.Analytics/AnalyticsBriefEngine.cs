using System.Text.Json.Serialization;

namespace ForgeX.Analytics;

/// <summary>
/// 统计简报引擎——`server/services/brief.js` buildBrief 的逐字节移植。
/// 简报文本喂给 AI provider 并进入双跑黄金对比，因此所有数字格式化都走
/// <see cref="JsFormat"/>（toFixed 平局、String(number) 记法），分组枚举序走
/// <see cref="JsValue.OrderKeys"/>（整数样键优先），偏相关分桶复刻经典的
/// 无分隔符键拼接——这三处任何一处用 .NET 默认行为都会造成静默漂移。
/// </summary>
public static class AnalyticsBriefEngine
{
    private const int MinSample = AnalyticsStatistics.DefaultMinSample;

    public static AnalyticsBrief Build(IReadOnlyList<RawRow> rows)
    {
        ArgumentNullException.ThrowIfNull(rows);
        var stats = Aggregate(rows);
        var range = DateRange(rows);

        var machines = RankFacts(rows, "machine_id");
        var materials = RankFacts(rows, "material");
        var models = RankFacts(rows, "model_name");
        var facts = new AnalyticsBriefFacts(
            rows.Count,
            range,
            new AnalyticsBriefOverall(
                stats.Total,
                stats.Fail,
                stats.FailRate,
                AnalyticsStatistics.Wilson(stats.Fail, stats.Total),
                stats.AvgCostFen,
                stats.FilamentG,
                stats.EnergyKwh),
            machines,
            materials,
            models,
            FaultFacts(rows),
            LayerFacts(rows),
            TrendFacts(rows));

        var lines = new List<string>
        {
            "## 数据集概况",
            $"- 记录数：{facts.RowCount}",
        };
        if (range is not null) lines.Add($"- 时间跨度：{range.Label}");
        lines.Add($"- 总体失败率：{FormatRateCi(facts.Overall.FailRateCi)}（{stats.Fail}/{stats.Total}）");
        lines.Add(
            $"- 良品平均成本：¥{Yuan(stats.AvgCostFen)}；耗材合计 {JsFormat.ToFixed(stats.FilamentG / 1000, 2)} kg；" +
            $"能耗 {JsFormat.ToFixed(stats.EnergyKwh, 1)} kWh");

        PushRank(lines, "机台失败率排行", machines);
        PushRank(lines, "材料失败率排行", materials);
        PushRank(lines, "模型失败率排行", models);

        if (facts.Faults.Count > 0)
        {
            lines.Add("");
            lines.Add("## 故障类型分布（占全部失败的比例）");
            foreach (var fault in facts.Faults)
            {
                lines.Add($"- {fault.Name}：{fault.N} 次，{FormatRateCi(fault.Ci)}");
            }
        }

        if (facts.LayerHeight is { } layer)
        {
            lines.Add("");
            lines.Add("## 层高与打印时长");
            if (layer.Raw is { } raw)
            {
                lines.Add(
                    $"- 未控制混杂：r={JsFormat.ToFixed(raw.R, 3)}（n={raw.N}，{FormatP(raw.PValue)}）");
            }
            if (layer.Partial is { } partial)
            {
                lines.Add(
                    $"- 控制材料与模型后：r={JsFormat.ToFixed(partial.R, 3)}（n={partial.N}，" +
                    $"{partial.Groups} 组，{FormatP(partial.PValue)}）");
                lines.Add("- ⚠ 应以偏相关为准；相关不等于因果。");
            }
            foreach (var bucket in layer.Buckets)
            {
                lines.Add(
                    $"- {JsFormat.ToFixed(bucket.Lh, 2)}mm：平均 {JsFormat.Number(bucket.AvgDur)} 分钟，" +
                    $"n={bucket.N}{(bucket.N < MinSample ? "（样本不足）" : string.Empty)}");
            }
        }

        var trendFacts = facts.CostTrend;
        lines.Add("");
        lines.Add("## 成本");
        lines.Add(
            $"- 总成本 ¥{Yuan(trendFacts.TotalFen)}，失败损耗 ¥{Yuan(trendFacts.FailLossFen)}" +
            $"（占 {Percent(trendFacts.TotalFen != 0 ? trendFacts.FailLossFen / trendFacts.TotalFen : 0)}）");
        if (trendFacts.Trend is { } trend)
        {
            var word = trend.Direction switch { "up" => "上升", "down" => "下降", _ => "无显著趋势" };
            lines.Add(
                $"- 每日成本趋势：{word}（Mann-Kendall τ={JsFormat.ToFixed(trend.Tau, 3)}，" +
                $"{FormatP(trend.PValue)}，{trend.N} 个日期点）");
        }

        lines.Add("");
        lines.Add("## 统计口径说明（务必遵守）");
        lines.Add($"- 分组样本量 < {MinSample} 的一律不参与排名，上面已标注。");
        lines.Add("- 「显著」一词只在标注了「显著高于其余」的条目上使用，其余情况必须说明差异未达显著。");
        lines.Add("- 所有比例都给了 95% 置信区间，请连同区间一起表述，不要只报点估计。");

        return new AnalyticsBrief(string.Join('\n', lines), facts);
    }

    private static void PushRank(List<string> lines, string title, BriefRankFacts rank)
    {
        if (rank.Ranked.Count == 0 && rank.Skipped.Count == 0) return;
        lines.Add("");
        lines.Add("## " + title);
        for (var i = 0; i < rank.Ranked.Count; i++)
        {
            var group = rank.Ranked[i];
            lines.Add(
                $"{i + 1}. {group.Key}：{Percent(group.Rate)}（95%CI {Percent(group.Ci[0])}–{Percent(group.Ci[1])}），" +
                $"n={group.N}，失败 {group.K}" +
                (group.Significant
                    ? $"　← **显著高于其余**（{FormatP(group.PValue)}）"
                    : $"　（与其余差异未达显著，{FormatP(group.PValue)}）"));
        }
        if (rank.Skipped.Count > 0)
        {
            lines.Add(
                $"- 样本不足未参与排名（n < {MinSample}）：" +
                string.Join("、", rank.Skipped.Select(static x => $"{x.Key}(n={x.N})")));
        }
    }

    private static BriefRankFacts RankFacts(IReadOnlyList<RawRow> rows, string key)
    {
        var groups = GroupBy(rows, key);
        var rateGroups = groups
            .Select(group =>
            {
                var stats = Aggregate(group.Rows);
                return new RateGroup(group.Key, stats.Fail, stats.Total);
            })
            .ToArray();
        var rank = AnalyticsStatistics.RankByRate(rateGroups, MinSample);
        return new BriefRankFacts(
            [.. rank.Ranked.Select(static g => new BriefRankedEntry(
                g.Key, g.K, g.N, g.Rate, [g.Ci.Lo, g.Ci.Hi], g.PValue, g.Significant))],
            [.. rank.Skipped.Select(static x => new BriefSkippedEntry(x.Key, x.K, x.N))],
            rank.Worst?.Key,
            rank.Fleet.Rate);
    }

    private static IReadOnlyList<BriefFaultEntry> FaultFacts(IReadOnlyList<RawRow> rows)
    {
        var fails = rows.Where(static row => row.Text("status") == "fail").ToArray();
        if (fails.Length == 0) return [];
        return [.. GroupBy(fails, "fail_reason")
            .Select(group => new BriefFaultEntry(
                group.Key,
                group.Rows.Count,
                AnalyticsStatistics.Wilson(group.Rows.Count, fails.Length)))
            .OrderByDescending(static entry => entry.N)];
    }

    private static BriefLayerFacts? LayerFacts(IReadOnlyList<RawRow> rows)
    {
        var ok = rows
            .Where(static row => row.Text("status") == "success" &&
                row.Number("layer_height_mm") > 0 &&
                row.Number("duration_min") > 0)
            .ToArray();
        if (ok.Length < 4) return null;

        var raw = AnalyticsStatistics.Pearson(
            [.. ok.Select(static row => new NumericPair(
                row.Number("layer_height_mm") ?? 0,
                row.Number("duration_min") ?? 0))]);
        var partial = ClassicPartialCorrelation(ok, "layer_height_mm", "duration_min", ["material", "model_name"]);

        var buckets = GroupBy(ok, "layer_height_mm")
            .Select(group =>
            {
                var stats = Aggregate(group.Rows);
                return new BriefLayerBucket(
                    JsValue.ParseFloat(group.Key),
                    stats.Total,
                    JsFormat.Round(stats.DurationMin / Math.Max(1, stats.Total)));
            })
            .OrderBy(static bucket => bucket.Lh)
            .ToArray();
        return new BriefLayerFacts(raw, partial, buckets);
    }

    private static BriefCostTrend TrendFacts(IReadOnlyList<RawRow> rows)
    {
        var byDate = GroupBy(rows, "date");
        var series = byDate
            .OrderBy(static group => group.Key, StringComparer.Ordinal)
            .Select(group => Aggregate(group.Rows).CostFen)
            .ToArray();
        var totalFen = series.Sum();
        var failLossFen = rows
            .Where(static row => row.Text("status") == "fail")
            .Sum(static row => row.Number("cost_fen") ?? 0);
        return new BriefCostTrend(
            totalFen,
            failLossFen,
            AnalyticsStatistics.MannKendall([.. series.Select(static fen => fen / 100)]));
    }

    /// <summary>
    /// 经典 partialCorrelation 的分桶复刻：键 = 各控制变量 String() 值的**无分隔符**拼接，
    /// 桶枚举按 JS 属性序。<see cref="AnalyticsStatistics.PartialCorrelation"/> 用 \u0001 分隔键，
    /// 在控制值拼接冲突时会得出不同分组——简报要与 Node 金样字节一致，必须用经典口径。
    /// </summary>
    private static PartialCorrelationResult? ClassicPartialCorrelation(
        IReadOnlyList<RawRow> rows,
        string xKey,
        string yKey,
        IReadOnlyList<string> controlKeys)
    {
        var buckets = new Dictionary<string, List<NumericPair>>(StringComparer.Ordinal);
        var insertion = new List<string>();
        foreach (var row in rows)
        {
            var x = row.Number(xKey);
            var y = row.Number(yKey);
            if (x is null || y is null || !double.IsFinite(x.Value) || !double.IsFinite(y.Value)) continue;
            var key = string.Concat(controlKeys.Select(control =>
                row.TryGet(control, out var value)
                    ? value switch
                    {
                        string text => text,
                        double number => JsFormat.Number(number),
                        _ => "null",
                    }
                    : "undefined"));
            if (!buckets.TryGetValue(key, out var bucket))
            {
                bucket = [];
                buckets.Add(key, bucket);
                insertion.Add(key);
            }
            bucket.Add(new NumericPair(x.Value, y.Value));
        }

        var residuals = new List<NumericPair>();
        var groups = 0;
        var dropped = 0;
        foreach (var key in JsValue.OrderKeys(insertion))
        {
            var bucket = buckets[key];
            if (bucket.Count < 2)
            {
                dropped += bucket.Count;
                continue;
            }
            groups++;
            var sumX = 0d;
            var sumY = 0d;
            foreach (var pair in bucket)
            {
                sumX += pair.X;
                sumY += pair.Y;
            }
            var meanX = sumX / bucket.Count;
            var meanY = sumY / bucket.Count;
            foreach (var pair in bucket)
            {
                residuals.Add(new NumericPair(pair.X - meanX, pair.Y - meanY));
            }
        }

        if (residuals.Count < 4 || groups < 1) return null;
        var degreesOfFreedom = residuals.Count - groups - 2;
        if (degreesOfFreedom <= 0) return null;
        var correlation = AnalyticsStatistics.Pearson(residuals, degreesOfFreedom);
        if (correlation is null) return null;
        return new PartialCorrelationResult(
            correlation.R,
            correlation.N,
            correlation.Ci95,
            correlation.PValue,
            correlation.Significant,
            "组内中心化偏相关（控制：" +
            (controlKeys.Count > 0 ? string.Join("、", controlKeys) : "无") +
            "）+ fisher-z 近似",
            groups,
            dropped,
            [.. controlKeys]);
    }

    /// <summary>经典 E.groupBy：键 = String(v)（空/缺席 → "未知"），组序按 JS 属性枚举序。</summary>
    private static List<(string Key, List<RawRow> Rows)> GroupBy(IReadOnlyList<RawRow> rows, string key)
    {
        var map = new Dictionary<string, List<RawRow>>(StringComparer.Ordinal);
        var insertion = new List<string>();
        foreach (var row in rows)
        {
            var groupKey = row.GroupKey(key);
            if (!map.TryGetValue(groupKey, out var bucket))
            {
                bucket = [];
                map.Add(groupKey, bucket);
                insertion.Add(groupKey);
            }
            bucket.Add(row);
        }
        return [.. JsValue.OrderKeys(insertion).Select(k => (k, map[k]))];
    }

    /// <summary>经典 E.stats（原始行口径：`x || 0` 取值，成本按良品分摊）。</summary>
    private static BriefAggregate Aggregate(IReadOnlyList<RawRow> rows)
    {
        var total = rows.Count;
        var fail = 0;
        var duration = 0d;
        var filament = 0d;
        var cost = 0d;
        var energy = 0d;
        foreach (var row in rows)
        {
            if (row.Text("status") == "fail") fail++;
            duration += row.Number("duration_min") ?? 0;
            filament += row.Number("filament_g") ?? 0;
            cost += row.Number("cost_fen") ?? 0;
            energy += row.Number("energy_kwh") ?? 0;
        }
        var ok = total - fail;
        return new BriefAggregate(
            total,
            fail,
            duration,
            filament,
            cost,
            energy,
            total > 0 ? (double)fail / total : 0,
            ok > 0 ? JsFormat.Round(cost / ok) : 0);
    }

    /// <summary>经典 E.dateRange：字符串序取 min/max，天数按 Date.parse(± "T00:00:00Z")。</summary>
    private static AnalyticsDateRange? DateRange(IReadOnlyList<RawRow> rows)
    {
        string? min = null;
        string? max = null;
        foreach (var row in rows)
        {
            if (!row.TryGet("date", out var value)) continue;
            var date = value switch
            {
                string text when text.Length > 0 => text,
                double number when number != 0 && !double.IsNaN(number) => JsFormat.Number(number),
                _ => null,
            };
            if (date is null) continue;
            if (min is null || string.CompareOrdinal(date, min) < 0) min = date;
            if (max is null || string.CompareOrdinal(date, max) > 0) max = date;
        }
        if (min is null || max is null) return null;
        var spanMs = JsDate.Parse(max + "T00:00:00Z") - JsDate.Parse(min + "T00:00:00Z");
        var days = JsFormat.Round(spanMs / 86400000d) + 1;
        if (!double.IsFinite(days) || days < 1) days = 1;
        var dayCount = (int)days;
        return new AnalyticsDateRange(
            min,
            max,
            dayCount,
            dayCount <= 1 ? min : $"{min} → {max}（{dayCount} 天）");
    }

    private static string Percent(double value) => JsFormat.ToFixed(value * 100, 1) + "%";

    private static string Yuan(double fen) => JsFormat.ToFixed(fen / 100, 2);

    /// <summary>经典 ST.fmtP（用 JS toFixed 平局语义，区别于报告引擎的 .NET "F"）。</summary>
    private static string FormatP(double value)
    {
        if (!double.IsFinite(value)) return "—";
        if (value < 0.0001) return "p<0.0001";
        if (value < 0.001) return "p<0.001";
        return "p=" + JsFormat.ToFixed(value, value < 0.01 ? 4 : 3);
    }

    /// <summary>经典 ST.fmtRateCi。</summary>
    private static string FormatRateCi(RateInterval ci) =>
        $"{JsFormat.ToFixed(ci.P * 100, 1)}%（95%CI {JsFormat.ToFixed(ci.Lo * 100, 1)}–{JsFormat.ToFixed(ci.Hi * 100, 1)}%）";

    private sealed record BriefAggregate(
        int Total,
        int Fail,
        double DurationMin,
        double FilamentG,
        double CostFen,
        double EnergyKwh,
        double FailRate,
        double AvgCostFen);
}

public sealed record AnalyticsBrief(string Text, AnalyticsBriefFacts Facts);

/// <summary>facts 键序与 brief.js 的对象字面量一致（双跑做语义比对，但保持同序便于人工核查）。</summary>
public sealed record AnalyticsBriefFacts(
    int RowCount,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] AnalyticsDateRange? DateRange,
    AnalyticsBriefOverall Overall,
    BriefRankFacts Machines,
    BriefRankFacts Materials,
    BriefRankFacts Models,
    IReadOnlyList<BriefFaultEntry> Faults,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BriefLayerFacts? LayerHeight,
    BriefCostTrend CostTrend);

public sealed record AnalyticsBriefOverall(
    int Total,
    int Fail,
    double FailRate,
    RateInterval FailRateCi,
    double AvgCostFen,
    double FilamentG,
    double EnergyKwh);

public sealed record BriefRankedEntry(
    string Key,
    int K,
    int N,
    double Rate,
    IReadOnlyList<double> Ci,
    double PValue,
    bool Significant);

public sealed record BriefSkippedEntry(string Key, int K, int N);

public sealed record BriefRankFacts(
    IReadOnlyList<BriefRankedEntry> Ranked,
    IReadOnlyList<BriefSkippedEntry> Skipped,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Worst,
    double FleetRate);

public sealed record BriefFaultEntry(string Name, int N, RateInterval Ci);

public sealed record BriefLayerBucket(double Lh, int N, double AvgDur);

public sealed record BriefLayerFacts(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] CorrelationResult? Raw,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] PartialCorrelationResult? Partial,
    IReadOnlyList<BriefLayerBucket> Buckets);

public sealed record BriefCostTrend(
    double TotalFen,
    double FailLossFen,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] MannKendallResult? Trend);
