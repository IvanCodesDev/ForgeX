using System.Globalization;

namespace ForgeX.Analytics;

public static class AnalyticsReportEngine
{
    private const int MinSample = AnalyticsStatistics.DefaultMinSample;
    private const string LocalRulesEngine = "local-rules";

    private static readonly string[] Supported =
    [
        "机台故障率排行与归因",
        "材料失败率对比",
        "层高与打印时长的关系",
        "成本趋势与拆解",
        "失败批次归因",
    ];

    private static readonly Dictionary<string, string> FaultActions =
        new(StringComparer.Ordinal)
        {
            ["堵料"] = "指向热端：检查积碳与内壁粗糙度，核对喷嘴温度是否低于材料推荐值、体积流量是否超出材料上限。",
            ["断料"] = "指向送料链路：检查挤出齿轮咬合与磨损、料架阻力，以及料盘余量是否长期偏低。",
            ["热失控"] = "指向加热系统：核查加热器有效功率与热敏电阻固定。这类故障有安全风险，优先处理。",
            ["翘边"] = "指向首层附着：核查热床温度是否低于材料下限、环境温度与风扰，以及是否需要封闭腔体。",
            ["悬垂塌陷"] = "指向支撑策略：核查悬垂面是否启用支撑，以及冷却/层高/速度是否足以成形桥接段。",
        };

    private static readonly (string Id, string[] Keywords)[] Intents =
    [
        ("machine_fault", ["机台", "哪台", "故障率", "设备", "机器", "保养", "维护"]),
        ("material_cmp", ["材料", "pla", "petg", "abs", "tpu", "对比", "差多少", "失败率差"]),
        ("corr_layer", ["层高", "相关", "相关性", "表面", "时长关系"]),
        ("cost_trend", ["成本", "耗材成本", "趋势", "花了", "费用", "单件"]),
        ("fail_root", ["失败", "共性", "归因", "原因", "为什么失败", "失败批次"]),
    ];

    public static AnalyticsCostProfile DefaultCostProfile { get; } = new(
        "cn-retail-2026q3",
        "中国大陆零售参考价（2026Q3）",
        "主流电商耗材零售均价 + 民用商业电价的量级估算，非权威数据；请按自己的采购成本替换",
        new Dictionary<string, double>(StringComparer.Ordinal)
        {
            ["PLA"] = 6900,
            ["PETG"] = 8900,
            ["ABS"] = 7900,
            ["TPU"] = 15900,
        },
        8000,
        60,
        12);

    public static AnalyticsReport AnalyzeMigratedIntent(
        string question,
        IReadOnlyList<AnalyticsRow> rows,
        AnalyticsProvenance? provenance = null,
        AnalyticsCostProfile? costProfile = null)
    {
        ArgumentNullException.ThrowIfNull(question);
        ArgumentNullException.ThrowIfNull(rows);
        if (rows.Count == 0)
        {
            return new AnalyticsReport(
                1,
                "无数据",
                "当前数据集为空，请先载入示例数据或上传 CSV",
                "insufficient-data",
                [],
                null,
                [],
                "empty",
                null,
                0,
                LocalRulesEngine,
                provenance);
        }

        var (matchedId, matchedScore) = MatchIntent(question);
        var body = matchedId switch
        {
            "machine_fault" => MachineFaultReport(rows),
            "material_cmp" => MaterialComparisonReport(rows),
            "corr_layer" => CorrelationReport(rows),
            "cost_trend" => CostTrendReport(rows, costProfile ?? DefaultCostProfile),
            "fail_root" => FailureRootReport(rows),
            _ => OverviewReport(rows, matchedScore > 0),
        };
        return new AnalyticsReport(
            1,
            body.Title,
            body.Verdict,
            body.Confidence,
            body.Sections,
            body.Chart,
            body.Evidence,
            matchedId,
            matchedScore > 0,
            rows.Count,
            LocalRulesEngine,
            provenance,
            body.Highlight);
    }

    private static ReportBody MachineFaultReport(IReadOnlyList<AnalyticsRow> rows)
    {
        var groups = GroupRows(rows, static row => row.MachineId);
        var byMachine = groups.ToDictionary(static group => group.Key, static group => group.Rows, StringComparer.Ordinal);
        var ranking = RankByRate(groups);
        var evidence = new List<AnalyticsEvidence>();
        var items = new List<AnalyticsChartItem>();
        foreach (var group in ranking.Ranked)
        {
            items.Add(new AnalyticsChartItem(
                group.Key,
                group.Rate,
                $"{group.K}/{group.N} 失败 · 95%CI {Percent(group.Ci.Lo)}–{Percent(group.Ci.Hi)}",
                false,
                group.Ci.Lo,
                group.Ci.Hi));
        }
        foreach (var skipped in ranking.Skipped)
        {
            items.Add(new AnalyticsChartItem(
                skipped.Key,
                skipped.Ci.P,
                $"{skipped.K}/{skipped.N} 失败 · {skipped.Reason}，不参与排名",
                true,
                skipped.Ci.Lo,
                skipped.Ci.Hi));
        }
        items = [.. items.OrderByDescending(static item => item.Value)];

        var top = ranking.Ranked.Count > 0 ? ranking.Ranked[0] : null;
        var sections = new List<AnalyticsReportSection>();
        if (top is null)
        {
            sections.Add(new AnalyticsReportSection(
                "为什么没有排名",
                [
                    $"参与排名需要每台机 ≥ {MinSample} 个任务，当前没有任何机台达标。",
                    ranking.Skipped.Count > 0
                        ? "样本不足的机台：" + string.Join("、", ranking.Skipped.Select(static item => $"{item.Key}（n={item.N}）"))
                        : "数据集中没有机台字段。",
                    "继续积累数据后重新提问即可得到排名。",
                ]));
            return new ReportBody(
                "机台故障率排行",
                $"样本不足：没有机台达到 {MinSample} 个任务的最小样本量，无法给出可信排名",
                "insufficient-data",
                sections,
                new AnalyticsChart("bar-rate", "机台故障率", items),
                evidence,
                null);
        }

        sections.Add(new AnalyticsReportSection(
            "失败率排行（含 95% 置信区间）",
            [.. ranking.Ranked.Select((group, index) =>
                $"{index + 1}. {group.Key}：{FormatRateInterval(group.Ci)}，n={group.N}" +
                (group.Significant ? $"　← 显著高于其余机台（{FormatP(group.PValue)}）" : string.Empty))]));

        var failures = byMachine[top.Key]
            .Where(static row => row.Status == AnalyticsStatus.Fail)
            .ToArray();
        var reasons = GroupRows(failures, static row => row.FailReason)
            .Select(static group => new CountGroup(group.Key, group.Rows.Count))
            .OrderByDescending(static group => group.Count)
            .ToArray();
        sections.Add(new AnalyticsReportSection(
            $"故障归因（{top.Key}，n={top.N}）",
            reasons.Length > 0
                ? [.. reasons.Select(reason =>
                    $"{reason.Name} × {reason.Count}（占该机台失败 " +
                    $"{FormatRateInterval(AnalyticsStatistics.Wilson(reason.Count, failures.Length))}）")]
                : ["该机台无失败记录"]));

        var advice = new List<string>();
        if (top.Significant)
        {
            advice.Add(
                $"{top.Key} 的失败率 {FormatRateInterval(top.Ci)} 显著高于其余机台合计 " +
                $"{Percent(top.VsRest.Rate)}（{top.VsRest.K}/{top.VsRest.N}），" +
                $"Fisher 精确检验 {FormatP(top.PValue)}，优势比 {Fixed(top.OddsRatio!.Value, 2)}。");
            evidence.Add(new AnalyticsEvidence(
                $"{top.Key} 的失败率显著高于其余机台",
                "Fisher 精确检验（2×2，双侧）",
                top.N + top.VsRest.N,
                top.OddsRatio,
                [top.Ci.Lo, top.Ci.Hi],
                top.PValue));
        }
        else
        {
            advice.Add(
                $"{top.Key} 的失败率 {FormatRateInterval(top.Ci)} 排第一，但与其余机台（" +
                $"{Percent(top.VsRest.Rate)}）的差异**未达统计显著**（{FormatP(top.PValue)}）——" +
                "以现有样本量还不能断定它更差，把它当线索而不是结论。");
            advice.Add(
                $"需要多少数据才能判定：各机台样本量翻倍后重新分析，或对该机台专项跟踪 " +
                $"{Math.Max(20, top.N)} 个任务。");
            evidence.Add(new AnalyticsEvidence(
                $"{top.Key} 排名第一但差异未达显著",
                "Fisher 精确检验（2×2，双侧）",
                top.N + top.VsRest.N,
                null,
                [top.Ci.Lo, top.Ci.Hi],
                top.PValue));
        }

        if (reasons.Length > 0 && failures.Length > 0)
        {
            var dominant = AnalyticsStatistics.Wilson(reasons[0].Count, failures.Length);
            if (dominant.Lo > 0.4)
            {
                FaultActions.TryGetValue(reasons[0].Name, out var tip);
                advice.Add(
                    $"「{reasons[0].Name}」占该机台失败的 {FormatRateInterval(dominant)}，" +
                    $"区间下界已超 40%，可判定为主因。{tip ?? string.Empty}");
                evidence.Add(new AnalyticsEvidence(
                    $"「{reasons[0].Name}」是 {top.Key} 的主导故障类型",
                    "Wilson 置信区间下界 > 40%",
                    failures.Length,
                    null,
                    [dominant.Lo, dominant.Hi],
                    null));
            }
            else if (reasons.Length > 1)
            {
                advice.Add(
                    $"故障类型分散（最高一类占比区间 {FormatRateInterval(dominant)}，" +
                    "下界未超 40%），无法判定单一主因，建议逐单排查。");
            }
        }
        if (ranking.Skipped.Count > 0)
        {
            sections.Add(new AnalyticsReportSection(
                "未参与排名",
                [
                    $"以下机台样本不足 {MinSample} 个任务：" +
                    string.Join("、", ranking.Skipped.Select(static item => $"{item.Key}（n={item.N}）")),
                ]));
        }
        sections.Add(new AnalyticsReportSection("建议", advice));

        return new ReportBody(
            "机台故障率排行",
            top.Significant
                ? $"{top.Key} 故障率最高且显著高于其余机台：{FormatRateInterval(top.Ci)}" +
                  $"（{top.K}/{top.N}，{FormatP(top.PValue)}）" +
                  (reasons.Length > 0 ? $"，主要故障：{reasons[0].Name} × {reasons[0].Count}" : string.Empty)
                : $"{top.Key} 故障率排第一（{FormatRateInterval(top.Ci)}，{top.K}/{top.N}），" +
                  $"但与其余机台的差异未达统计显著（{FormatP(top.PValue)}），证据不足以判定它更差",
            Confidence(rows.Count, top.Significant),
            sections,
            new AnalyticsChart("bar-rate", "机台故障率（误差线为 95%CI）", items),
            evidence,
            new AnalyticsHighlight("machine", top.Key));
    }

    private static ReportBody MaterialComparisonReport(IReadOnlyList<AnalyticsRow> rows)
    {
        var materialGroups = GroupRows(rows, static row => row.Material);
        var byMaterial = materialGroups.ToDictionary(static group => group.Key, static group => group.Rows, StringComparer.Ordinal);
        var ranking = RankByRate(materialGroups);
        var evidence = new List<AnalyticsEvidence>();
        var sections = new List<AnalyticsReportSection>();
        var items = new List<AnalyticsChartItem>();
        foreach (var group in ranking.Ranked)
        {
            var stats = Aggregate(byMaterial[group.Key]);
            items.Add(new AnalyticsChartItem(
                group.Key,
                group.Rate,
                $"{group.K}/{group.N} 失败 · 95%CI {Percent(group.Ci.Lo)}–{Percent(group.Ci.Hi)}" +
                $" · 良品均本 ¥{FormatYuan(stats.AvgCostFen)}",
                false,
                group.Ci.Lo,
                group.Ci.Hi));
        }
        foreach (var skipped in ranking.Skipped)
        {
            items.Add(new AnalyticsChartItem(
                skipped.Key,
                skipped.Ci.P,
                $"{skipped.K}/{skipped.N} · {skipped.Reason}",
                true,
                skipped.Ci.Lo,
                skipped.Ci.Hi));
        }
        items = [.. items.OrderByDescending(static item => item.Value)];

        var top = ranking.Ranked.Count > 0 ? ranking.Ranked[0] : null;
        if (top is null)
        {
            return new ReportBody(
                "材料失败率对比",
                $"样本不足：没有材料达到 {MinSample} 个任务的最小样本量，无法比较",
                "insufficient-data",
                [new AnalyticsReportSection(
                    "为什么无法比较",
                    [.. ranking.Skipped.Select(static item => $"{item.Key}：n={item.N}，{item.Reason}")])],
                new AnalyticsChart("bar-rate", "各材料失败率", items),
                evidence);
        }

        var materialLines = ranking.Ranked.Select((group, index) =>
        {
            var stats = Aggregate(byMaterial[group.Key]);
            return $"{index + 1}. {group.Key}：失败率 {FormatRateInterval(group.Ci)}，n={group.N}" +
                $"，良品均本 ¥{FormatYuan(stats.AvgCostFen)}" +
                (group.Significant ? $"　← 显著高于其余材料（{FormatP(group.PValue)}）" : string.Empty);
        }).Concat(ranking.Skipped.Select(static item =>
            $"{item.Key}：n={item.N}，{item.Reason}，不参与排名")).ToArray();
        sections.Add(new AnalyticsReportSection("各材料表现（含 95% 置信区间）", materialLines));

        var pairLines = new List<string>();
        for (var left = 0; left < ranking.Ranked.Count; left++)
        {
            for (var right = left + 1; right < ranking.Ranked.Count; right++)
            {
                var a = ranking.Ranked[left];
                var b = ranking.Ranked[right];
                var comparison = AnalyticsStatistics.CompareRates(a.K, a.N, b.K, b.N);
                if (!comparison.Significant) continue;
                pairLines.Add(
                    $"{a.Key} vs {b.Key}：{Percent(a.Rate)} vs {Percent(b.Rate)}，" +
                    $"差 {Fixed(comparison.Diff * 100, 1)} 个百分点（{FormatP(comparison.PValue)}，" +
                    $"优势比 {Fixed(comparison.OddsRatio!.Value, 2)}）");
                evidence.Add(new AnalyticsEvidence(
                    $"{a.Key} 的失败率显著高于 {b.Key}",
                    "Fisher 精确检验（2×2，双侧）",
                    a.N + b.N,
                    comparison.OddsRatio,
                    null,
                    comparison.PValue));
            }
        }
        sections.Add(new AnalyticsReportSection(
            "两两对比（仅列统计显著的差异）",
            pairLines.Count > 0
                ? pairLines
                : ["各材料之间的差异均未达统计显著——以现有样本量还分不出高下。"]));

        RowGroup? focus = null;
        AggregateStats? focusStats = null;
        foreach (var model in GroupRows(rows, static row => row.ModelName))
        {
            var stats = Aggregate(model.Rows);
            if (stats.Total < MinSample || stats.Fail == 0) continue;
            if (focus is null || (double)stats.Fail / stats.Total > (double)focusStats!.Fail / focusStats.Total)
            {
                focus = model;
                focusStats = stats;
            }
        }
        if (focus is not null)
        {
            var subRanking = RankByRate(GroupRows(focus.Rows, static row => row.Material));
            var subLines = subRanking.Ranked
                .Select(static group => $"{group.Key}：{FormatRateInterval(group.Ci)}，n={group.N}")
                .Concat(subRanking.Skipped.Select(static item => $"{item.Key}：n={item.N}，样本不足"))
                .ToArray();
            sections.Add(new AnalyticsReportSection(
                $"失败率最高的模型「{focus.Key}」上的分材料表现（n={focusStats!.Total}）",
                subLines.Length > 0 ? subLines : ["该模型下无足够样本"]));
        }

        var advice = new List<string>();
        if (top.Significant)
        {
            advice.Add(
                $"{top.Key} 的失败率 {FormatRateInterval(top.Ci)} 显著高于其余材料合计 " +
                $"{Percent(top.VsRest.Rate)}（{FormatP(top.PValue)}）：优先核查该材料的温度窗口、" +
                "床温下限与环境条件（高收缩材料对腔体与风扰尤其敏感）。");
            evidence.Add(new AnalyticsEvidence(
                $"{top.Key} 的失败率显著高于其余材料",
                "Fisher 精确检验（2×2，双侧）",
                top.N + top.VsRest.N,
                top.OddsRatio,
                [top.Ci.Lo, top.Ci.Hi],
                top.PValue));
        }
        else
        {
            advice.Add(
                $"{top.Key} 失败率排第一（{FormatRateInterval(top.Ci)}），但与其余材料的差异" +
                $"未达统计显著（{FormatP(top.PValue)}），不足以据此调整材料选型。");
        }
        if (ranking.Skipped.Count > 0)
        {
            advice.Add(
                "样本不足未参与排名：" + string.Join("、", ranking.Skipped.Select(static item => item.Key)) +
                $"（各需 ≥ {MinSample} 个任务）。");
        }
        sections.Add(new AnalyticsReportSection("建议", advice));

        return new ReportBody(
            "材料失败率对比",
            top.Significant
                ? $"失败率最高的材料是 {top.Key}：{FormatRateInterval(top.Ci)}（n={top.N}），" +
                  $"显著高于其余材料（{FormatP(top.PValue)}）"
                : $"{top.Key} 失败率排第一（{FormatRateInterval(top.Ci)}，n={top.N}），" +
                  $"但差异未达统计显著（{FormatP(top.PValue)}）",
            Confidence(rows.Count, top.Significant),
            sections,
            new AnalyticsChart("bar-rate", "各材料失败率（误差线为 95%CI）", items),
            evidence);
    }

    private static ReportBody CorrelationReport(IReadOnlyList<AnalyticsRow> rows)
    {
        var successful = rows
            .Where(static row =>
                row.Status == AnalyticsStatus.Success &&
                row.LayerHeightMm > 0 &&
                row.DurationMin > 0)
            .ToArray();
        var sections = new List<AnalyticsReportSection>();
        var evidence = new List<AnalyticsEvidence>();
        var raw = AnalyticsStatistics.Pearson(
            [.. successful.Select(static row => new NumericPair(row.LayerHeightMm, row.DurationMin))]);
        var partial = AnalyticsStatistics.PartialCorrelation(
            [.. successful.Select(static row => new PartialCorrelationObservation(
                row.LayerHeightMm,
                row.DurationMin,
                [row.Material ?? "undefined", row.ModelName ?? "undefined"]))],
            ["material", "model_name"]);

        var chartItems = new List<AnalyticsChartItem>();
        var layerLines = new List<string>();
        foreach (var group in successful.GroupBy(static row => row.LayerHeightMm).OrderBy(static group => group.Key))
        {
            var count = group.Count();
            var averageDuration = JsRound(group.Sum(static row => row.DurationMin) / Math.Max(1, count));
            var weak = count < MinSample;
            var label = Fixed(group.Key, 2) + "mm";
            chartItems.Add(new AnalyticsChartItem(
                label,
                averageDuration,
                $"平均 {averageDuration} 分钟 · n={count}" + (weak ? "（样本不足）" : ""),
                weak));
            layerLines.Add(
                $"{label}：平均时长 {averageDuration} 分钟，n={count}" + (weak ? "　← 样本不足" : ""));
        }
        sections.Add(new AnalyticsReportSection(
            "分层高统计（成功任务）",
            layerLines.Count > 0 ? layerLines : ["无有效样本"]));
        var chart = new AnalyticsChart("bar-value", "各层高平均时长（分钟）", chartItems);

        if (raw is null)
        {
            return new ReportBody(
                "层高与打印时长关系",
                $"有效成功样本仅 {successful.Length} 条（需 ≥4），无法计算相关性",
                "insufficient-data",
                sections,
                chart,
                evidence);
        }

        var comparisonLines = new List<string>
        {
            $"未控制混杂：r={Fixed(raw.R, 3)}（{DescribeR(raw.R)}，n={raw.N}，95%CI " +
            $"{Fixed(raw.Ci95![0], 3)}–{Fixed(raw.Ci95[1], 3)}，{FormatP(raw.PValue)}）",
        };
        evidence.Add(new AnalyticsEvidence(
            "层高与时长的粗相关",
            "Pearson + Fisher-z 正态近似",
            raw.N,
            raw.R,
            raw.Ci95,
            raw.PValue));

        var confounded = true;
        if (partial is not null)
        {
            comparisonLines.Add(
                $"控制材料与模型后：r={Fixed(partial.R, 3)}（{DescribeR(partial.R)}，有效样本 {partial.N}，" +
                $"{partial.Groups} 个「材料×模型」组，95%CI {Fixed(partial.Ci95![0], 3)}–" +
                $"{Fixed(partial.Ci95[1], 3)}，{FormatP(partial.PValue)}）");
            evidence.Add(new AnalyticsEvidence(
                "层高与时长的偏相关（控制材料与模型）",
                partial.Method,
                partial.N,
                partial.R,
                partial.Ci95,
                partial.PValue));

            var shift = Math.Abs(raw.R - partial.R);
            confounded = shift > 0.15;
            comparisonLines.Add(confounded
                ? $"两者相差 {Fixed(shift, 2)}——说明粗相关里有相当一部分来自材料/模型差异，应以偏相关为准。"
                : $"两者接近（相差 {Fixed(shift, 2)}），混杂影响不大。");
        }
        else
        {
            comparisonLines.Add("控制材料与模型后有效样本不足，无法计算偏相关——粗相关可能被混杂因素支配，请谨慎解读。");
        }
        sections.Add(new AnalyticsReportSection("相关性（两个口径对照）", comparisonLines));
        sections.Add(new AnalyticsReportSection(
            "读数说明",
            [
                "相关不等于因果：以上只描述数据中的共变关系，不能推断「调大层高就会更快」。",
                "要验证因果，需要固定其他参数只改层高的对照实验。",
                partial is not null
                    ? "偏相关口径：按「材料×模型」组内中心化后求相关，自由度已扣除组数。"
                    : "当前样本无法支撑偏相关计算。",
            ]));

        var effectiveSignificant = partial?.Significant ?? raw.Significant;
        var verdict = partial is not null
            ? $"控制材料与模型后，层高与打印时长 r={Fixed(partial.R, 2)}（{DescribeR(partial.R)}，" +
              $"n={partial.N}，{FormatP(partial.PValue)}）；未控制时为 r={Fixed(raw.R, 2)}，" +
              "两者差异说明混杂因素的影响程度"
            : $"层高与打印时长 r={Fixed(raw.R, 2)}（{DescribeR(raw.R)}，n={raw.N}，" +
              $"{FormatP(raw.PValue)}）；未控制材料与模型差异，仅供参考";
        return new ReportBody(
            "层高与打印时长关系",
            verdict,
            Confidence(successful.Length, effectiveSignificant, confounded),
            sections,
            chart,
            evidence);
    }

    private static ReportBody CostTrendReport(
        IReadOnlyList<AnalyticsRow> rows,
        AnalyticsCostProfile profile)
    {
        var grouped = new Dictionary<string, List<AnalyticsRow>>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            var key = string.IsNullOrEmpty(row.Date) ? "未知" : row.Date;
            if (!grouped.TryGetValue(key, out var bucket))
            {
                bucket = [];
                grouped.Add(key, bucket);
            }
            bucket.Add(row);
        }

        var dates = grouped.Keys.Order(StringComparer.Ordinal).ToArray();
        var chartItems = new List<AnalyticsChartItem>();
        var series = new List<double>();
        var totalFen = 0d;
        foreach (var date in dates)
        {
            var stats = Aggregate(grouped[date]);
            totalFen += stats.CostFen;
            series.Add(stats.CostFen / 100);
            chartItems.Add(new AnalyticsChartItem(
                date.Length > 5 ? date[5..] : string.Empty,
                stats.CostFen / 100,
                $"{date} · ¥{FormatYuan(stats.CostFen)} · {stats.Total} 件"));
        }

        var materialFen = 0d;
        foreach (var row in rows)
        {
            var unit = profile.MaterialDefaultFenPerKg;
            if (row.Material is not null &&
                profile.MaterialFenPerKg.TryGetValue(row.Material, out var price) &&
                price != 0)
            {
                unit = price;
            }
            materialFen += row.FilamentG / 1000 * unit;
        }
        var all = Aggregate(rows);
        var failureLossFen = rows
            .Where(static row => row.Status == AnalyticsStatus.Fail)
            .Sum(static row => row.CostFen);
        var range = DateRange(rows);
        var trend = AnalyticsStatistics.MannKendall(series);
        var sections = new List<AnalyticsReportSection>();
        var evidence = new List<AnalyticsEvidence>();
        var trendDirection = trend is null ? string.Empty : TrendWord(trend.Direction);
        if (trend is not null)
        {
            sections.Add(new AnalyticsReportSection(
                "趋势检验",
                [
                    $"每日成本：{trendDirection}（Mann-Kendall τ={Fixed(trend.Tau, 3)}，" +
                    $"{FormatP(trend.PValue)}，{trend.N} 个日期点）",
                    trend.Significant
                        ? "该趋势在 95% 水平下统计显著。"
                        : "日间波动尚不能判定为趋势——不要据此推断成本正在变化。",
                ]));
            evidence.Add(new AnalyticsEvidence(
                "每日成本" + trendDirection,
                trend.Method!,
                trend.N,
                trend.Tau,
                null,
                trend.PValue));
        }
        else
        {
            sections.Add(new AnalyticsReportSection("趋势检验", ["日期点少于 4 个，无法做趋势检验。"]));
        }

        var roundedMaterialFen = JsRound(materialFen);
        var lossInterval = AnalyticsStatistics.Wilson(all.Fail, all.Total);
        sections.Add(new AnalyticsReportSection(
            "成本拆解",
            [
                $"耗材成本 ≈ ¥{FormatYuan(roundedMaterialFen)}（占 {Percent(totalFen != 0 ? materialFen / totalFen : 0)}）",
                $"能耗 + 机时折旧 ≈ ¥{FormatYuan(Math.Max(0, totalFen - roundedMaterialFen))}",
                $"失败损耗 ¥{FormatYuan(failureLossFen)}（占总成本 " +
                $"{Percent(totalFen != 0 ? failureLossFen / totalFen : 0)}；失败率 {FormatRateInterval(lossInterval)}）",
            ]));

        var advice = new List<string>();
        if (failureLossFen > 0 && lossInterval.P > 0)
        {
            var saveFen = JsRound(failureLossFen * (1 - lossInterval.Lo / lossInterval.P));
            advice.Add(
                $"失败损耗占总成本 {Percent(totalFen != 0 ? failureLossFen / totalFen : 0)}。" +
                $"失败率的 95% 区间是 {Percent(lossInterval.Lo)}–{Percent(lossInterval.Hi)}，" +
                $"即便只压到区间下界也约可节省 ¥{FormatYuan(saveFen)}。");
        }
        else
        {
            advice.Add("本期无失败损耗。");
        }
        advice.Add("以上金额按下方口径换算；换成你自己的采购价与电价后结论可能变化。");
        sections.Add(new AnalyticsReportSection("建议", advice));
        sections.Add(new AnalyticsReportSection(
            "计价口径",
            [
                $"{profile.Label}（{profile.Id}）",
                "材料 " + string.Join("、", profile.MaterialFenPerKg.Select(static item =>
                    $"{item.Key} ¥{Fixed(item.Value / 100, 0)}/kg")),
                $"电价 ¥{Fixed(profile.PowerFenPerKwh / 100, 2)}/kWh · 机时折旧 " +
                $"¥{Fixed(profile.MachineFenPerHour / 100, 2)}/h",
                "出处：" + profile.Source,
            ]));

        return new ReportBody(
            "成本趋势与拆解",
            $"期间（{range?.Label ?? "时间范围未知"}）总成本 ¥{FormatYuan(totalFen)}，" +
            $"良品平均单件 ¥{FormatYuan(all.AvgCostFen)}，失败损耗 ¥{FormatYuan(failureLossFen)}" +
            $"（占 {Percent(totalFen != 0 ? failureLossFen / totalFen : 0)}）" +
            (trend is not null ? $"；每日成本{trendDirection}（{FormatP(trend.PValue)}）" : string.Empty),
            Confidence(rows.Count, trend?.Significant),
            sections,
            new AnalyticsChart("line", "每日成本（元）", chartItems),
            evidence);
    }

    private static ReportBody FailureRootReport(IReadOnlyList<AnalyticsRow> rows)
    {
        var failures = rows.Where(static row => row.Status == AnalyticsStatus.Fail).ToArray();
        var evidence = new List<AnalyticsEvidence>();
        var sections = new List<AnalyticsReportSection>();
        var reasons = GroupRows(failures, static row => row.FailReason)
            .Select(static group => new CountGroup(group.Key, group.Rows.Count))
            .OrderByDescending(static group => group.Count)
            .ToArray();
        var chartItems = reasons
            .Select(static reason => new AnalyticsChartItem(
                reason.Name,
                reason.Count,
                $"{reason.Count} 次"))
            .ToArray();
        sections.Add(new AnalyticsReportSection(
            "故障类型分布",
            reasons.Length > 0
                ? [.. reasons.Select(reason =>
                    $"{reason.Name}：{reason.Count} 次（占失败 " +
                    $"{FormatRateInterval(AnalyticsStatistics.Wilson(reason.Count, failures.Length))}）")]
                : ["无失败记录"]));

        var machineGroups = GroupRows(rows, static row => row.MachineId);
        var ranking = RankByRate(machineGroups);
        var byMachine = machineGroups.ToDictionary(static group => group.Key, static group => group.Rows, StringComparer.Ordinal);
        var crossLines = new List<string>();
        if (failures.Length > 0)
        {
            var failedMachineGroups = GroupRows(failures, static row => row.MachineId);
            RowGroup? mostCount = null;
            foreach (var machine in failedMachineGroups)
            {
                if (mostCount is null || machine.Rows.Count > mostCount.Rows.Count) mostCount = machine;
            }
            if (mostCount is not null)
            {
                var all = Aggregate(byMachine[mostCount.Key]);
                crossLines.Add(
                    $"失败「次数」最多：{mostCount.Key}（{mostCount.Rows.Count} 次）—— " +
                    $"但它的失败「率」是 {FormatRateInterval(AnalyticsStatistics.Wilson(all.Fail, all.Total))}（n={all.Total}）");
            }
            if (ranking.Worst is not null)
            {
                var worst = ranking.Worst;
                crossLines.Add(
                    $"失败「率」最高且显著：{worst.Key}（{FormatRateInterval(worst.Ci)}，n={worst.N}，" +
                    $"{FormatP(worst.PValue)}）—— 这台才是该优先保养的");
                evidence.Add(new AnalyticsEvidence(
                    $"{worst.Key} 的失败率显著高于其余机台",
                    "Fisher 精确检验（2×2，双侧）",
                    worst.N + worst.VsRest.N,
                    null,
                    [worst.Ci.Lo, worst.Ci.Hi],
                    worst.PValue));
            }
            else if (ranking.Ranked.Count > 0)
            {
                var top = ranking.Ranked[0];
                crossLines.Add(
                    $"失败率最高的是 {top.Key}（{FormatRateInterval(top.Ci)}），" +
                    $"但与其余机台的差异未达统计显著（{FormatP(top.PValue)}），暂不能断定该优先保养谁");
            }

            var failedModelGroups = GroupRows(failures, static row => row.ModelName);
            RowGroup? worstModel = null;
            foreach (var model in failedModelGroups)
            {
                if (worstModel is null || model.Rows.Count > worstModel.Rows.Count) worstModel = model;
            }
            if (worstModel is not null)
            {
                var allModels = GroupRows(rows, static row => row.ModelName)
                    .ToDictionary(static group => group.Key, static group => group.Rows, StringComparer.Ordinal);
                var modelStats = Aggregate(allModels[worstModel.Key]);
                crossLines.Add(
                    $"失败次数最多的模型：{worstModel.Key}（{worstModel.Rows.Count} 次，失败率 " +
                    $"{FormatRateInterval(AnalyticsStatistics.Wilson(modelStats.Fail, modelStats.Total))}，n={modelStats.Total}）");
            }
        }
        sections.Add(new AnalyticsReportSection(
            "共性交叉（次数 vs 比率）",
            crossLines.Count > 0 ? crossLines : ["无失败记录"]));

        var tips = new List<string>();
        foreach (var reason in reasons)
        {
            var interval = AnalyticsStatistics.Wilson(reason.Count, failures.Length);
            if (interval.Lo < 0.2) continue;
            if (FaultActions.TryGetValue(reason.Name, out var action))
            {
                tips.Add($"{reason.Name}（占 {FormatRateInterval(interval)}）：{action}");
            }
        }
        if (tips.Count == 0)
        {
            tips.Add(failures.Length > 0
                ? "没有任何故障类型的占比区间下界超过 20%，故障分散，无单一处置重点。"
                : "本期无失败记录。");
        }
        sections.Add(new AnalyticsReportSection("针对性处置", tips));

        var topInterval = reasons.Length > 0
            ? AnalyticsStatistics.Wilson(reasons[0].Count, failures.Length)
            : null;
        var highlight = ranking.Worst is not null
            ? new AnalyticsHighlight("machine", ranking.Worst.Key)
            : ranking.Ranked.Count > 0
                ? new AnalyticsHighlight("machine", ranking.Ranked[0].Key)
                : null;
        return new ReportBody(
            "失败批次归因",
            reasons.Length > 0
                ? $"TOP 故障：{reasons[0].Name}（{reasons[0].Count} 次，占失败 {FormatRateInterval(topInterval!)}）" +
                  (ranking.Worst is not null
                      ? $"；{ranking.Worst.Key} 的失败率显著高于其余机台（{FormatP(ranking.Worst.PValue)}），应优先保养"
                      : "；各机台失败率差异未达统计显著，暂无法指定优先保养对象")
                : "本数据集无失败记录",
            failures.Length > 0 ? Confidence(rows.Count, ranking.Worst is not null) : "insufficient-data",
            sections,
            new AnalyticsChart("bar-value", "故障类型次数", chartItems),
            evidence,
            highlight);
    }

    private static ReportBody OverviewReport(IReadOnlyList<AnalyticsRow> rows, bool matched)
    {
        var kpis = AnalyticsKpiEngine.Calculate(rows);
        var items = new List<AnalyticsChartItem>();
        var lines = new List<string>();
        foreach (var model in GroupRows(rows, static row => row.ModelName))
        {
            var stats = Aggregate(model.Rows);
            var failureRate = stats.Total > 0 ? (double)stats.Fail / stats.Total : 0;
            items.Add(new AnalyticsChartItem(
                model.Key,
                stats.Total,
                $"{stats.Total} 件 · 失败率 {Percent(failureRate)}"));
            lines.Add(
                $"{model.Key}：{stats.Total} 件，失败率 {Percent(failureRate)}" +
                (stats.Total < MinSample ? "　← 样本不足" : string.Empty));
        }

        var sections = new List<AnalyticsReportSection>();
        if (!matched)
        {
            sections.Add(new AnalyticsReportSection(
                "没有匹配到分析维度",
                [
                    "本引擎是规则引擎（非 AI），只能回答下列维度的问题：",
                    .. Supported.Select(static item => "· " + item),
                    "以下是数据集的总体情况，供参考。",
                ]));
        }
        sections.Add(new AnalyticsReportSection("分模型产量", lines));
        sections.Add(new AnalyticsReportSection(
            "可以这样问",
            [.. Supported.Select(static item => "· " + item)]));

        return new ReportBody(
            matched ? "生产概览" : "未识别的问题 · 生产概览",
            (matched ? string.Empty : "未能识别问题对应的分析维度，以下为总体概览：") +
            $"共 {kpis.Total} 个任务" +
            (kpis.DateRange is not null ? $"（{kpis.DateRange.Label}）" : string.Empty) +
            $"，良率 {Percent(kpis.Yield)}，良品平均成本 ¥{FormatYuan(kpis.AvgCostFen)}" +
            (kpis.WorstMachine is not null
                ? $"；失败率最高 {kpis.WorstMachine.Id}（{Percent(kpis.WorstMachine.FailRate)}，n={kpis.WorstMachine.N}）"
                : string.Empty),
            Confidence(rows.Count),
            sections,
            new AnalyticsChart("bar-value", "分模型任务量", items),
            [],
            kpis.WorstMachine is not null ? new AnalyticsHighlight("machine", kpis.WorstMachine.Id) : null);
    }

    private static (string Id, int Score) MatchIntent(string question)
    {
        var normalized = question.ToLowerInvariant();
        var best = (Id: "overview", Score: 0);
        foreach (var (id, keywords) in Intents)
        {
            var score = keywords.Count(keyword => normalized.Contains(keyword, StringComparison.Ordinal));
            if (score > best.Score) best = (id, score);
        }
        return best;
    }

    private static string Confidence(int total, bool? significant = null, bool confounded = false)
    {
        if (total == 0) return "insufficient-data";
        if (significant == false || confounded) return "low";
        if (significant == true) return total >= 60 ? "high" : "medium";
        if (total < 30) return "low";
        return total < 100 ? "medium" : "high";
    }

    private static string DescribeR(double value)
    {
        var absolute = Math.Abs(value);
        if (absolute < 0.2) return "几乎无线性相关";
        var strength = absolute >= 0.7 ? "强" : absolute >= 0.4 ? "中等" : "弱";
        return strength + (value < 0 ? "负" : "正") + "相关";
    }

    private static string FormatP(double value)
    {
        if (!double.IsFinite(value)) return "—";
        if (value < 0.0001) return "p<0.0001";
        if (value < 0.001) return "p<0.001";
        return "p=" + Fixed(value, value < 0.01 ? 4 : 3);
    }

    private static string FormatRateInterval(RateInterval interval) =>
        $"{Percent(interval.P)}（95%CI {Fixed(interval.Lo * 100, 1)}–{Fixed(interval.Hi * 100, 1)}%）";

    private static string TrendWord(string direction) => direction switch
    {
        "up" => "上升",
        "down" => "下降",
        _ => "无显著趋势",
    };

    private static string Percent(double value) => Fixed(value * 100, 1) + "%";

    private static string FormatYuan(double fen) => Fixed(fen / 100, 2);

    private static string Fixed(double value, int digits) =>
        value.ToString($"F{digits}", CultureInfo.InvariantCulture);

    private static long JsRound(double value) => checked((long)Math.Floor(value + 0.5));

    private static List<RowGroup> GroupRows(
        IEnumerable<AnalyticsRow> rows,
        Func<AnalyticsRow, string?> keySelector)
    {
        var groups = new List<RowGroup>();
        var indexes = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            var rawKey = keySelector(row);
            var key = string.IsNullOrEmpty(rawKey) ? "未知" : rawKey;
            if (!indexes.TryGetValue(key, out var index))
            {
                index = groups.Count;
                indexes.Add(key, index);
                groups.Add(new RowGroup(key, []));
            }
            groups[index].Rows.Add(row);
        }
        return groups;
    }

    private static RateRanking RankByRate(IReadOnlyList<RowGroup> groups) =>
        AnalyticsStatistics.RankByRate(
            [.. groups.Select(static group =>
            {
                var stats = Aggregate(group.Rows);
                return new RateGroup(group.Key, stats.Fail, stats.Total);
            })],
            MinSample);

    private static AggregateStats Aggregate(IEnumerable<AnalyticsRow> rows)
    {
        var total = 0;
        var failures = 0;
        var duration = 0d;
        var filament = 0d;
        var cost = 0d;
        var energy = 0d;
        foreach (var row in rows)
        {
            total++;
            if (row.Status == AnalyticsStatus.Fail) failures++;
            duration += row.DurationMin;
            filament += row.FilamentG;
            cost += row.CostFen;
            energy += row.EnergyKwh;
        }
        var successes = total - failures;
        return new AggregateStats(
            total,
            failures,
            duration,
            filament,
            cost,
            energy,
            successes > 0 ? JsRound(cost / successes) : 0);
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
        return new AnalyticsDateRange(from, to, days, days <= 1 ? from : $"{from} → {to}（{days} 天）");
    }

    private sealed record ReportBody(
        string Title,
        string Verdict,
        string Confidence,
        IReadOnlyList<AnalyticsReportSection> Sections,
        AnalyticsChart? Chart,
        IReadOnlyList<AnalyticsEvidence> Evidence,
        AnalyticsHighlight? Highlight = null);

    private sealed record RowGroup(
        string Key,
        List<AnalyticsRow> Rows);

    private sealed record CountGroup(
        string Name,
        int Count);

    private sealed record AggregateStats(
        int Total,
        int Fail,
        double DurationMin,
        double FilamentG,
        double CostFen,
        double EnergyKwh,
        long AvgCostFen);
}
