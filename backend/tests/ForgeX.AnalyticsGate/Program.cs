using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using ForgeX.Analytics;
using ForgeX.Analytics.Calibration;

return await AnalyticsGateProgram.RunAsync(CancellationToken.None);

internal static class AnalyticsGateProgram
{
    private const string EngineVersion = "forgex-analytics-csharp/1.3.0";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    public static async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        try
        {
            var root = LocateRoot();
            var goldenPath = Path.Combine(root, "tests", "golden", "stage4-analytics-golden.json");
            var artifactPath = Path.Combine(root, "backend", "artifacts", "analytics-golden-diff.json");
            var goldenBytes = await File.ReadAllBytesAsync(goldenPath, cancellationToken);
            var golden = JsonNode.Parse(goldenBytes)?.AsObject()
                ?? throw new InvalidDataException("Stage 4 analytics golden must be a JSON object.");
            var tolerance = golden["tolerance"]?.AsObject()
                ?? throw new InvalidDataException("Golden tolerance is missing.");
            var absTolerance = tolerance["numericAbs"]?.GetValue<double>() ?? 1e-9;
            var relTolerance = tolerance["numericRel"]?.GetValue<double>() ?? 1e-9;
            var fields = new List<FieldDiff>();

            CompareCsvCases(golden, fields, absTolerance, relTolerance);
            CompareStatistics(golden, fields, absTolerance, relTolerance);
            await CompareDatasetAsync(root, golden, fields, absTolerance, relTolerance, cancellationToken);
            await CompareReportsAsync(root, golden, fields, absTolerance, relTolerance, cancellationToken);
            CompareCalibration(fields, absTolerance, relTolerance);
            await CompareRulesLegAsync(root, fields, absTolerance, relTolerance, cancellationToken);

            var passed = fields.Count(static field => field.Pass);
            var report = new AnalyticsGateReport(
                "forgex-analytics-golden-diff",
                1,
                DateTimeOffset.UtcNow,
                EngineVersion,
                Path.GetRelativePath(root, goldenPath).Replace('\\', '/'),
                Convert.ToHexStringLower(SHA256.HashData(goldenBytes)),
                fields.Count,
                passed,
                fields.Count - passed,
                passed == fields.Count,
                fields);
            Directory.CreateDirectory(Path.GetDirectoryName(artifactPath)!);
            await File.WriteAllTextAsync(
                artifactPath,
                JsonSerializer.Serialize(report, JsonOptions) + Environment.NewLine,
                cancellationToken);

            foreach (var group in fields.GroupBy(static field => field.CaseId, StringComparer.Ordinal))
            {
                Console.WriteLine(
                    $"[{(group.All(static field => field.Pass) ? "PASS" : "FAIL")}] {group.Key}: " +
                    $"{group.Count(static field => field.Pass)}/{group.Count()} fields");
            }
            Console.WriteLine(
                $"AnalyticsGate: {(report.Pass ? "PASS" : "FAIL")} — {passed}/{fields.Count} fields, " +
                $"artifact={artifactPath}");
            return report.Pass ? 0 : 1;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"AnalyticsGate failed: {exception}");
            return 1;
        }
    }

    private static void CompareCsvCases(
        JsonObject golden,
        List<FieldDiff> fields,
        double absTolerance,
        double relTolerance)
    {
        foreach (var caseNode in RequiredArray(golden, "csvCases"))
        {
            var item = caseNode?.AsObject() ?? throw new InvalidDataException("CSV case must be an object.");
            var caseId = $"csv/{RequiredString(item, "id")}";
            var actual = AnalyticsCsvParser.Parse(RequiredString(item, "input"));
            var expected = item["expected"]?.AsObject() ?? throw new InvalidDataException($"{caseId} expected missing.");
            var expectedRows = RequiredArray(expected, "rows");
            var expectedErrors = RequiredArray(expected, "errors");
            AddExact(fields, caseId, "rows.length", expectedRows.Count, actual.Rows.Count);
            AddExact(fields, caseId, "errors.length", expectedErrors.Count, actual.Errors.Count);
            for (var index = 0; index < Math.Min(expectedErrors.Count, actual.Errors.Count); index++)
            {
                AddExact(fields, caseId, $"errors[{index}]", expectedErrors[index]?.GetValue<string>(), actual.Errors[index]);
            }
            for (var index = 0; index < Math.Min(expectedRows.Count, actual.Rows.Count); index++)
            {
                CompareCsvRow(
                    caseId,
                    index,
                    expectedRows[index]?.AsObject() ?? throw new InvalidDataException("Expected CSV row must be an object."),
                    actual.Rows[index],
                    fields,
                    absTolerance,
                    relTolerance);
            }
        }

        var limitCase = golden["csvLimitCase"]?.AsObject()
            ?? throw new InvalidDataException("csvLimitCase is missing.");
        var requestedRows = limitCase["input"]?["rowCount"]?.GetValue<int>()
            ?? throw new InvalidDataException("csvLimitCase rowCount is missing.");
        var lines = new string[requestedRows + 1];
        lines[0] = "machine_id,status,duration_min";
        for (var index = 0; index < requestedRows; index++)
        {
            lines[index + 1] = $"M-{index % 2},success,{index + 1}";
        }
        var limitResult = AnalyticsCsvParser.Parse(string.Join('\n', lines));
        var limitExpected = limitCase["expected"]!.AsObject();
        AddExact(
            fields,
            "csv/row-limit",
            "rows.length",
            limitExpected["rowCount"]!.GetValue<int>(),
            limitResult.Rows.Count);
        var limitErrors = RequiredArray(limitExpected, "errors");
        AddExact(fields, "csv/row-limit", "errors.length", limitErrors.Count, limitResult.Errors.Count);
        for (var index = 0; index < Math.Min(limitErrors.Count, limitResult.Errors.Count); index++)
        {
            AddExact(
                fields,
                "csv/row-limit",
                $"errors[{index}]",
                limitErrors[index]?.GetValue<string>(),
                limitResult.Errors[index]);
        }
    }

    private static void CompareCsvRow(
        string caseId,
        int index,
        JsonObject expected,
        AnalyticsRow actual,
        List<FieldDiff> fields,
        double absTolerance,
        double relTolerance)
    {
        var actualValues = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["job_id"] = actual.JobId,
            ["date"] = actual.Date,
            ["machine_id"] = actual.MachineId,
            ["model_name"] = actual.ModelName,
            ["material"] = actual.Material,
            ["layer_height_mm"] = actual.LayerHeightMm,
            ["duration_min"] = actual.DurationMin,
            ["filament_g"] = actual.FilamentG,
            ["cost_fen"] = actual.CostFen,
            ["status"] = actual.Status == AnalyticsStatus.Fail ? "fail" : "success",
            ["fail_reason"] = actual.FailReason,
            ["energy_kwh"] = actual.EnergyKwh,
        };
        foreach (var property in expected)
        {
            if (!actualValues.TryGetValue(property.Key, out var actualValue))
            {
                fields.Add(FieldDiff.Fail(caseId, $"rows[{index}].{property.Key}", NodeText(property.Value), "<unsupported>"));
                continue;
            }
            var field = $"rows[{index}].{property.Key}";
            if (property.Value is JsonValue value && value.TryGetValue<double>(out var expectedNumber))
            {
                AddNumber(fields, caseId, field, expectedNumber, Convert.ToDouble(actualValue), absTolerance, relTolerance);
            }
            else AddExact(fields, caseId, field, property.Value?.GetValue<string>(), actualValue?.ToString());
        }
    }

    private static void CompareStatistics(
        JsonObject golden,
        List<FieldDiff> fields,
        double absTolerance,
        double relTolerance)
    {
        foreach (var caseNode in RequiredArray(golden, "wilsonCases"))
        {
            var item = caseNode!.AsObject();
            var input = item["input"]!.AsObject();
            var k = input["k"]!.GetValue<int>();
            var n = input["n"]!.GetValue<int>();
            var confidence = input["confidence"]!.GetValue<double>();
            CompareNode(
                $"wilson/{k}-{n}-{confidence}",
                item["expected"],
                JsonSerializer.SerializeToNode(AnalyticsStatistics.Wilson(k, n, confidence), JsonOptions),
                fields,
                absTolerance,
                relTolerance);
        }
        foreach (var caseNode in RequiredArray(golden, "fisherCases"))
        {
            var item = caseNode!.AsObject();
            var input = item["input"]!.AsObject();
            var a = input["a"]!.GetValue<int>();
            var b = input["b"]!.GetValue<int>();
            var c = input["c"]!.GetValue<int>();
            var d = input["d"]!.GetValue<int>();
            CompareNode(
                $"fisher/{a}-{b}-{c}-{d}",
                item["expected"],
                JsonSerializer.SerializeToNode(AnalyticsStatistics.FisherExact(a, b, c, d), JsonOptions),
                fields,
                absTolerance,
                relTolerance);
        }
        foreach (var caseNode in RequiredArray(golden, "pearsonCases"))
        {
            var item = caseNode!.AsObject();
            var input = item["input"]!.AsObject();
            var pairs = RequiredArray(input, "pairs")
                .Select(static node => node!.AsArray())
                .Select(static pair => new NumericPair(
                    pair[0]!.GetValue<double>(),
                    pair[1]!.GetValue<double>()))
                .ToArray();
            var options = input["options"]?.AsObject();
            var degreesOfFreedom = options?["df"]?.GetValue<int>();
            var alpha = options?["alpha"]?.GetValue<double>() ?? AnalyticsStatistics.DefaultAlpha;
            CompareNode(
                $"pearson/{RequiredString(input, "id")}",
                item["expected"],
                JsonSerializer.SerializeToNode(
                    AnalyticsStatistics.Pearson(pairs, degreesOfFreedom, alpha),
                    JsonOptions),
                fields,
                absTolerance,
                relTolerance);
        }
        foreach (var caseNode in RequiredArray(golden, "partialCorrelationCases"))
        {
            var item = caseNode!.AsObject();
            var input = item["input"]!.AsObject();
            var xKey = RequiredString(input, "xKey");
            var yKey = RequiredString(input, "yKey");
            var controlKeys = RequiredArray(input, "controlKeys")
                .Select(static node => node!.GetValue<string>())
                .ToArray();
            var observations = new List<PartialCorrelationObservation>();
            foreach (var rowNode in RequiredArray(input, "rows"))
            {
                var row = rowNode!.AsObject();
                if (!row.TryGetPropertyValue(xKey, out var xNode) ||
                    !row.TryGetPropertyValue(yKey, out var yNode) ||
                    !TryJsNumber(xNode, out var x) ||
                    !TryJsNumber(yNode, out var y)) continue;
                observations.Add(new PartialCorrelationObservation(
                    x,
                    y,
                    [.. controlKeys.Select(key =>
                        row.TryGetPropertyValue(key, out var control) ? JsString(control) : "undefined")]));
            }
            CompareNode(
                $"partial/{RequiredString(input, "id")}",
                item["expected"],
                JsonSerializer.SerializeToNode(
                    AnalyticsStatistics.PartialCorrelation(observations, controlKeys),
                    JsonOptions),
                fields,
                absTolerance,
                relTolerance);
        }
        foreach (var caseNode in RequiredArray(golden, "mannKendallCases"))
        {
            var item = caseNode!.AsObject();
            var input = item["input"]!.AsObject();
            var series = RequiredArray(input, "series")
                .Select(static node => node!.GetValue<double>())
                .ToArray();
            var alpha = input["options"]?["alpha"]?.GetValue<double>() ?? AnalyticsStatistics.DefaultAlpha;
            CompareNode(
                $"mann-kendall/{RequiredString(input, "id")}",
                item["expected"],
                JsonSerializer.SerializeToNode(AnalyticsStatistics.MannKendall(series, alpha), JsonOptions),
                fields,
                absTolerance,
                relTolerance);
        }
        var ranking = golden["rankCase"]?.AsObject() ?? throw new InvalidDataException("rankCase is missing.");
        var rankInput = ranking["input"]!.AsObject();
        var groups = RequiredArray(rankInput, "groups")
            .Select(static node => node!.AsObject())
            .Select(static item => new RateGroup(
                item["key"]!.GetValue<string>(),
                item["k"]!.GetValue<int>(),
                item["n"]!.GetValue<int>()))
            .ToArray();
        var result = AnalyticsStatistics.RankByRate(
            groups,
            rankInput["minSample"]!.GetValue<int>(),
            rankInput["alpha"]!.GetValue<double>());
        CompareNode(
            "rank/rates",
            ranking["expected"],
            JsonSerializer.SerializeToNode(result, JsonOptions),
            fields,
            absTolerance,
            relTolerance);
    }

    private static async Task CompareDatasetAsync(
        string root,
        JsonObject golden,
        List<FieldDiff> fields,
        double absTolerance,
        double relTolerance,
        CancellationToken cancellationToken)
    {
        var dataset = golden["dataset"]?.AsObject() ?? throw new InvalidDataException("dataset is missing.");
        var relativePath = RequiredString(dataset, "path");
        var fullPath = Path.GetFullPath(Path.Combine(root, relativePath));
        if (!fullPath.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Dataset path escapes repository root.");
        }
        var bytes = await File.ReadAllBytesAsync(fullPath, cancellationToken);
        AddExact(
            fields,
            "dataset/print-farm-400",
            "sha256",
            RequiredString(dataset, "sha256"),
            Convert.ToHexStringLower(SHA256.HashData(bytes)));
        var parsed = AnalyticsCsvParser.Parse(System.Text.Encoding.UTF8.GetString(bytes));
        var expected = dataset["expected"]!.AsObject();
        AddExact(fields, "dataset/print-farm-400", "rowCount", expected["rowCount"]!.GetValue<int>(), parsed.Rows.Count);
        CompareNode(
            "dataset/print-farm-400/errors",
            expected["errors"],
            JsonSerializer.SerializeToNode(parsed.Errors, JsonOptions),
            fields,
            absTolerance,
            relTolerance);
        CompareNode(
            "dataset/print-farm-400/kpis",
            expected["kpis"],
            JsonSerializer.SerializeToNode(AnalyticsKpiEngine.Calculate(parsed.Rows), JsonOptions),
            fields,
            absTolerance,
            relTolerance);
    }

    private static async Task CompareReportsAsync(
        string root,
        JsonObject golden,
        List<FieldDiff> fields,
        double absTolerance,
        double relTolerance,
        CancellationToken cancellationToken)
    {
        foreach (var caseNode in RequiredArray(golden, "reportCases"))
        {
            var item = caseNode!.AsObject();
            var input = item["input"]!.AsObject();
            string csv;
            if (input["datasetPath"] is JsonValue datasetPathValue &&
                datasetPathValue.TryGetValue<string>(out var relativePath))
            {
                var fullPath = Path.GetFullPath(Path.Combine(root, relativePath));
                if (!fullPath.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("Report dataset path escapes repository root.");
                }
                csv = await File.ReadAllTextAsync(fullPath, cancellationToken);
            }
            else
            {
                csv = RequiredString(input, "csv");
            }

            var parsed = AnalyticsCsvParser.Parse(csv);
            if (parsed.Rows.Count == 0)
            {
                throw new InvalidDataException($"Report case {RequiredString(item, "id")} has no valid rows.");
            }
            var provenance = input["provenance"]?.Deserialize<AnalyticsProvenance>(JsonOptions);
            var report = AnalyticsReportEngine.AnalyzeMigratedIntent(
                RequiredString(input, "question"),
                parsed.Rows,
                provenance);
            CompareNode(
                $"report/{RequiredString(item, "id")}",
                item["expected"],
                JsonSerializer.SerializeToNode(report, JsonOptions),
                fields,
                absTolerance,
                relTolerance);
        }
    }

    private static void CompareCalibration(List<FieldDiff> fields, double absTolerance, double relTolerance)
    {
        var samples = new[]
        {
            new CalibrationSample("job-1", 100, 215, "FX-TEST", "Marlin"),
            new CalibrationSample("job-2", 200, 340, "FX-TEST", "Marlin"),
            new CalibrationSample("job-3", 400, 590, "FX-TEST", "Marlin"),
            new CalibrationSample("job-4", 800, 1090, "FX-TEST", "Marlin"),
        };
        var result = CalibrationTrainer.Train(samples, new CalibrationScope("FX-TEST", "Marlin"));
        AddExact(fields, "calibration/exact", "format", "forgex-time-calibration", result.Format);
        AddExact(fields, "calibration/exact", "method", "theil-sen", result.Method);
        AddExact(fields, "calibration/exact", "scope.machineId", "FX-TEST", result.Scope.MachineId);
        AddExact(fields, "calibration/exact", "scope.firmware", "Marlin", result.Scope.Firmware);
        AddNumber(fields, "calibration/exact", "coefficients.motionScale", 1.25, result.Coefficients.MotionScale, absTolerance, relTolerance);
        AddNumber(fields, "calibration/exact", "coefficients.fixedOverheadSec", 90, result.Coefficients.FixedOverheadSec, absTolerance, relTolerance);
        AddNumber(fields, "calibration/exact", "trainingMetrics.maeSec", 0, result.TrainingMetrics.MaeSec, absTolerance, relTolerance);
        AddExact(fields, "calibration/exact", "crossValidation.sampleCount", 4, result.CrossValidation?.SampleCount);
        var outlier = samples.Append(new CalibrationSample("paused-job", 600, 3000, "FX-TEST", "Marlin")).ToArray();
        var robust = CalibrationTrainer.Train(outlier, new CalibrationScope("FX-TEST", "Marlin"));
        AddNumber(fields, "calibration/outlier", "coefficients.motionScale", 1.25, robust.Coefficients.MotionScale, 0.05, relTolerance);
        fields.Add(new FieldDiff("calibration/outlier", "trainingMetrics.maxApe", ">0.5", robust.TrainingMetrics.MaxApe.ToString("G15", System.Globalization.CultureInfo.InvariantCulture), null, null, 0, robust.TrainingMetrics.MaxApe > 0.5));
    }

    // 与 Node JSON.stringify 同形态输出（中文不转义、引号用 \"），仅用于断言文本比对。
    private static readonly JsonSerializerOptions RawRowJsonOptions = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// Stage 8.3 规则计算腿断言。期望值全部由经典 JS/Node 实测生成
    /// （V8 String(number)/toFixed、brief.js 简报文本 SHA、calibration-registry 错误串），
    /// 是 C# 与经典实现之间的静态跨语言金样；完整语料级双跑由 verify-rules-authority 工具承担。
    /// </summary>
    private static async Task CompareRulesLegAsync(
        string root,
        List<FieldDiff> fields,
        double absTolerance,
        double relTolerance,
        CancellationToken cancellationToken)
    {
        // ── JsFormat：ECMA Number::toString / toFixed（V8 实测期望）────────────
        (double Value, string Expected)[] numberCases =
        [
            (0.1, "0.1"), (123, "123"), (-0d, "0"), (1e21, "1e+21"), (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"), (1e-7, "1e-7"), (1.2345678901234568e20, "123456789012345680000"),
            (-1234.5678, "-1234.5678"), (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"),
            (0.5, "0.5"), (100.6, "100.6"), (204.5, "204.5"),
        ];
        foreach (var (value, expected) in numberCases)
        {
            AddExact(fields, "rules/js-format", $"Number({expected})", expected, JsFormat.Number(value));
        }
        (double Value, int Digits, string Expected)[] fixedCases =
        [
            (0.125, 2, "0.13"), (-0.125, 2, "-0.13"), (2.5, 0, "3"), (-2.5, 0, "-3"),
            (1.005, 2, "1.00"), (0.615, 2, "0.61"), (1.0049999999999999, 2, "1.00"),
            (99.995, 2, "100.00"), (-99.995, 2, "-100.00"), (0.1, 1, "0.1"),
            (12.36, 1, "12.4"), (7.575, 2, "7.58"), (0, 2, "0.00"),
        ];
        foreach (var (value, digits, expected) in fixedCases)
        {
            AddExact(
                fields,
                "rules/js-format",
                $"toFixed({value.ToString("R", System.Globalization.CultureInfo.InvariantCulture)},{digits})",
                expected,
                JsFormat.ToFixed(value, digits));
        }

        // ── farm 数据集：字节指纹 + 解析/再序列化闭环 ───────────────────────────
        AddExact(
            fields,
            "rules/farm",
            "csv.sha256",
            "71be7cb1f832754ee964920d7d2e0b76ba1831418ac9df79683168df68667f25",
            Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(FarmDataset.Csv))));
        AddExact(fields, "rules/farm", "rows.length", 400, FarmDataset.Rows.Count);
        AddExact(
            fields,
            "rules/farm",
            "toCsv(parse(csv)) == csv",
            true,
            RawDatasetCsv.ToCsv(FarmDataset.Rows) == FarmDataset.Csv);

        // ── 原始 CSV 解析：缺席 vs 零、cost_cny 换算、行错误文案、引号转义 ─────────
        var absent = RawDatasetCsv.Parse("material,status\nPLA,success");
        AddExact(
            fields,
            "rules/raw-csv",
            "absent.row",
            """{"material":"PLA","status":"success","fail_reason":""}""",
            absent.Rows[0].ToJsonObject().ToJsonString(RawRowJsonOptions));
        AddExact(
            fields,
            "rules/raw-csv",
            "absent.csv",
            "job_id,date,machine_id,model_name,material,layer_height_mm,duration_min,filament_g,cost_fen,status,fail_reason,energy_kwh\n,,,,PLA,,,,,success,,",
            RawDatasetCsv.ToCsv(absent.Rows));
        var zero = RawDatasetCsv.Parse("material,status,duration_min\nPLA,success,");
        AddExact(
            fields,
            "rules/raw-csv",
            "zero.row",
            """{"material":"PLA","status":"success","duration_min":0,"fail_reason":""}""",
            zero.Rows[0].ToJsonObject().ToJsonString(RawRowJsonOptions));
        AddExact(
            fields,
            "rules/raw-csv",
            "zero.csv",
            "job_id,date,machine_id,model_name,material,layer_height_mm,duration_min,filament_g,cost_fen,status,fail_reason,energy_kwh\n,,,,PLA,,0,,,success,,",
            RawDatasetCsv.ToCsv(zero.Rows));
        var cny = RawDatasetCsv.Parse("material,status,成本\nPLA,success,1.155");
        AddExact(
            fields,
            "rules/raw-csv",
            "cny.row",
            """{"material":"PLA","status":"success","cost_fen":116,"fail_reason":""}""",
            cny.Rows[0].ToJsonObject().ToJsonString(RawRowJsonOptions));
        var dirty = RawDatasetCsv.Parse("machine_id,status,duration_min\nM1,weird,5\nM2,success,abc\nM3,fail,3");
        AddExact(fields, "rules/raw-csv", "dirty.errors[0]", "第 2 行：status 取值无效（weird）", dirty.Errors[0]);
        AddExact(fields, "rules/raw-csv", "dirty.errors[1]", "第 3 行：duration_min 不是有效数值（abc）", dirty.Errors[1]);
        AddExact(fields, "rules/raw-csv", "dirty.rows.length", 1, dirty.Rows.Count);
        AddExact(
            fields,
            "rules/raw-csv",
            "dirty.rows[0]",
            """{"machine_id":"M3","status":"fail","duration_min":3}""",
            dirty.Rows[0].ToJsonObject().ToJsonString(RawRowJsonOptions));
        var quoted = RawDatasetCsv.Parse(
            "machine_id,status,fail_reason\n\"M,1\",fail,\"含\"\"引号\"\"与,逗号\"\nM2,success,ignored");
        AddExact(
            fields,
            "rules/raw-csv",
            "quoted.rows[0]",
            """{"machine_id":"M,1","status":"fail","fail_reason":"含\"引号\"与,逗号"}""",
            quoted.Rows[0].ToJsonObject().ToJsonString(RawRowJsonOptions));
        AddExact(
            fields,
            "rules/raw-csv",
            "quoted.csv",
            "job_id,date,machine_id,model_name,material,layer_height_mm,duration_min,filament_g,cost_fen,status,fail_reason,energy_kwh\n,,\"M,1\",,,,,,,fail,\"含\"\"引号\"\"与,逗号\",\n,,M2,,,,,,,success,,",
            RawDatasetCsv.ToCsv(quoted.Rows));

        // ── 统计简报：文本与经典 brief.js 逐字节一致（SHA-256 金样）──────────────
        var brief = AnalyticsBriefEngine.Build(FarmDataset.Rows);
        AddExact(
            fields,
            "rules/brief",
            "text.sha256",
            "79d55c394290817aefa13e68a800bf0c1db4842b9791a989c941a415a8bed63a",
            Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(brief.Text))));
        AddExact(fields, "rules/brief", "text.length", 1762, brief.Text.Length);
        string[] expectedHead =
        [
            "## 数据集概况",
            "- 记录数：400",
            "- 时间跨度：2026-06-29 → 2026-07-19（21 天）",
            "- 总体失败率：17.5%（95%CI 14.1–21.5%）（70/400）",
            "- 良品平均成本：¥1.27；耗材合计 3.97 kg；能耗 52.7 kWh",
            "",
        ];
        var actualLines = brief.Text.Split('\n');
        for (var index = 0; index < expectedHead.Length; index++)
        {
            AddExact(fields, "rules/brief", $"text.lines[{index}]", expectedHead[index], actualLines[index]);
        }
        AddExact(fields, "rules/brief", "facts.machines.ranked.length", 8, brief.Facts.Machines.Ranked.Count);
        AddExact(fields, "rules/brief", "facts.machines.skipped.length", 0, brief.Facts.Machines.Skipped.Count);
        AddExact(fields, "rules/brief", "facts.machines.worst", "FX-256-01", brief.Facts.Machines.Worst);
        AddExact(
            fields,
            "rules/brief",
            "facts.faults",
            "堵料:23|断料:19|悬垂塌陷:16|热失控:8|翘边:4",
            string.Join('|', brief.Facts.Faults.Select(static fault => $"{fault.Name}:{fault.N}")));
        AddExact(fields, "rules/brief", "facts.dateRange.label", "2026-06-29 → 2026-07-19（21 天）", brief.Facts.DateRange?.Label);
        AddNumber(fields, "rules/brief", "facts.overall.failRateCi.lo", 0.1409042015930453, brief.Facts.Overall.FailRateCi.Lo, absTolerance, relTolerance);
        AddNumber(fields, "rules/brief", "facts.overall.avgCostFen", 127, brief.Facts.Overall.AvgCostFen, absTolerance, relTolerance);
        AddNumber(fields, "rules/brief", "facts.overall.filamentG", 3968.3000000000015, brief.Facts.Overall.FilamentG, absTolerance, relTolerance);
        AddNumber(fields, "rules/brief", "facts.overall.energyKwh", 52.68999999999994, brief.Facts.Overall.EnergyKwh, absTolerance, relTolerance);
        var layer = brief.Facts.LayerHeight ?? throw new InvalidDataException("farm brief layerHeight missing.");
        AddExact(
            fields,
            "rules/brief",
            "facts.layerHeight.buckets",
            "0.12:72:55|0.2:200:33|0.28:58:25",
            string.Join('|', layer.Buckets.Select(static bucket =>
                $"{JsFormat.Number(bucket.Lh)}:{bucket.N}:{JsFormat.Number(bucket.AvgDur)}")));
        var partial = layer.Partial ?? throw new InvalidDataException("farm brief partial missing.");
        AddNumber(fields, "rules/brief", "facts.layerHeight.partial.r", -0.8341227545194032, partial.R, absTolerance, relTolerance);
        AddExact(fields, "rules/brief", "facts.layerHeight.partial.n", 330, partial.N);
        AddExact(fields, "rules/brief", "facts.layerHeight.partial.groups", 12, partial.Groups);
        var trend = brief.Facts.CostTrend.Trend ?? throw new InvalidDataException("farm brief trend missing.");
        AddExact(fields, "rules/brief", "facts.costTrend.trend.n", 21, trend.N);
        AddExact(fields, "rules/brief", "facts.costTrend.trend.S", -6L, trend.S);
        AddNumber(fields, "rules/brief", "facts.costTrend.trend.pValue", 0.879987818000241, trend.PValue, absTolerance, relTolerance);
        AddExact(fields, "rules/brief", "facts.costTrend.trend.direction", "flat", trend.Direction);
        AddNumber(fields, "rules/brief", "facts.costTrend.totalFen", 42024, brief.Facts.CostTrend.TotalFen, absTolerance, relTolerance);
        AddNumber(fields, "rules/brief", "facts.costTrend.failLossFen", 1945, brief.Facts.CostTrend.FailLossFen, absTolerance, relTolerance);

        // ── 校准包验证器：例包通过 + 错误串逐字节一致 ───────────────────────────
        var examplePath = Path.Combine(root, "contracts", "calibration", "example-bundle.json");
        using (var example = JsonDocument.Parse(await File.ReadAllBytesAsync(examplePath, cancellationToken)))
        {
            var checkedExample = CalibrationBundleValidator.Validate(example.RootElement);
            AddExact(fields, "rules/calibration-validate", "example.ok", true, checkedExample.Ok);
            AddExact(fields, "rules/calibration-validate", "example.errors.length", 0, checkedExample.Errors.Count);
        }
        AssertValidator(
            fields,
            "bad1",
            """
            {"format":"x","version":2,"id":"ab","revision":0,"createdAt":"not-a-date",
             "provenance":"weird","source":{"license":"","note":"short","extra":1},"models":[]}
            """,
            [
                "format 必须是 forgex-calibration-bundle", "version 必须是 1", "bundle.id 格式无效",
                "revision 必须是正整数", "createdAt 必须是 ISO 日期", "provenance 不受支持",
                "source 含未知字段 extra", "source.license 必填", "source.note 至少 20 个字符",
                "models 至少需要一项",
            ]);
        AssertValidator(
            fields,
            "bad2",
            $$"""
            {"format":"forgex-calibration-bundle","version":1,"id":"bundle.one","revision":2,
             "createdAt":"2026-08-01T00:00:00Z","provenance":"real-anonymized",
             "source":{"license":"CC0","note":"一份用于门禁断言的真实来源说明文字，超过二十个字符。"},
             "models":[{
               "id":"model-a","status":"active","algorithm":"theil-sen","trainedAt":"2026-08-01",
               "trainingSetSha256":"{{new string('a', 64)}}",
               "scope":{"machineId":"FX-1","firmware":"Marlin","material":null},
               "coefficients":{"motionScale":20,"fixedOverheadSec":-1,"sampleCount":2},
               "validation":{"holdoutSamples":null,"mape":2,"maxApe":9,"medianBias":-3,"evaluatedAt":"2026-08-02"},
               "thresholds":{"maxMape":0.9,"maxBias":0.005,"minDriftSamples":1}
             },{
               "id":"model-a","status":"demonstration-only","algorithm":"other","trainedAt":"bad",
               "trainingSetSha256":"ZZ","scope":{"machineId":" ","firmware":""},
               "coefficients":{"motionScale":1,"fixedOverheadSec":10,"sampleCount":3},
               "validation":{"holdoutSamples":5,"mape":0.1,"maxApe":0.2,"medianBias":0,"evaluatedAt":"2026-08-02T10:00:00+08:00"},
               "thresholds":{"maxMape":0.2,"maxBias":0.2,"minDriftSamples":3},
               "unknownField":true
             }]}
            """,
            [
                "models[0].coefficients.motionScale 超出 0.1–10",
                "models[0].coefficients.fixedOverheadSec 超出 0–7200",
                "models[0].coefficients.sampleCount 至少为 3",
                "models[0].validation.holdoutSamples 必须是非负整数",
                "models[0].validation.mape 超出 0–1",
                "models[0].validation.maxApe 超出 0–5",
                "models[0].validation.medianBias 超出 -1–1",
                "models[0].thresholds.maxMape 超出 0.01–0.5",
                "models[0].thresholds.maxBias 超出 0.01–0.5",
                "models[0].thresholds.minDriftSamples 至少为 3",
                "models[0] active 模型至少需要 5 个 holdout",
                "models[0] holdout 指标未通过启用阈值",
                "models[1] 含未知字段 unknownField",
                "models[1].id 重复",
                "models[1].algorithm 仅支持 theil-sen",
                "models[1].trainedAt 必须是 ISO 日期",
                "models[1].trainingSetSha256 必须是 SHA-256",
                "models[1].scope.machineId 必填",
                "models[1].scope.firmware 必填",
                "models[1] demonstration-only 必须使用 synthetic-conformance",
            ]);
        AssertValidator(fields, "bad3", "\"not-an-object\"", ["bundle 必须是对象"]);
    }

    private static void AssertValidator(
        List<FieldDiff> fields,
        string caseId,
        string bundleJson,
        string[] expectedErrors)
    {
        using var document = JsonDocument.Parse(bundleJson);
        var result = CalibrationBundleValidator.Validate(document.RootElement);
        AddExact(fields, $"rules/calibration-validate/{caseId}", "ok", false, result.Ok);
        AddExact(fields, $"rules/calibration-validate/{caseId}", "errors.length", expectedErrors.Length, result.Errors.Count);
        for (var index = 0; index < Math.Min(expectedErrors.Length, result.Errors.Count); index++)
        {
            AddExact(fields, $"rules/calibration-validate/{caseId}", $"errors[{index}]", expectedErrors[index], result.Errors[index]);
        }
    }

    private static void CompareNode(
        string caseId,
        JsonNode? expected,
        JsonNode? actual,
        List<FieldDiff> fields,
        double absTolerance,
        double relTolerance,
        string field = "$")
    {
        if (expected is null || actual is null)
        {
            AddExact(fields, caseId, field, NodeText(expected), NodeText(actual));
            return;
        }
        if (expected is JsonObject expectedObject && actual is JsonObject actualObject)
        {
            foreach (var property in expectedObject)
            {
                actualObject.TryGetPropertyValue(property.Key, out var actualValue);
                CompareNode(caseId, property.Value, actualValue, fields, absTolerance, relTolerance, $"{field}.{property.Key}");
            }
            return;
        }
        if (expected is JsonArray expectedArray && actual is JsonArray actualArray)
        {
            AddExact(fields, caseId, $"{field}.length", expectedArray.Count, actualArray.Count);
            for (var index = 0; index < Math.Min(expectedArray.Count, actualArray.Count); index++)
            {
                CompareNode(
                    caseId,
                    expectedArray[index],
                    actualArray[index],
                    fields,
                    absTolerance,
                    relTolerance,
                    $"{field}[{index}]");
            }
            return;
        }
        if (expected is JsonValue expectedValue && expectedValue.TryGetValue<double>(out var expectedNumber) &&
            actual is JsonValue actualJsonValue && actualJsonValue.TryGetValue<double>(out var actualNumber))
        {
            AddNumber(fields, caseId, field, expectedNumber, actualNumber, absTolerance, relTolerance);
            return;
        }
        AddExact(fields, caseId, field, NodeText(expected), NodeText(actual));
    }

    private static void AddNumber(
        List<FieldDiff> fields,
        string caseId,
        string field,
        double expected,
        double actual,
        double absTolerance,
        double relTolerance)
    {
        var delta = Math.Abs(actual - expected);
        var relative = Math.Abs(expected) > double.Epsilon ? delta / Math.Abs(expected) : delta;
        var limit = Math.Max(absTolerance, Math.Abs(expected) * relTolerance);
        fields.Add(new FieldDiff(
            caseId,
            field,
            expected.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
            actual.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
            delta,
            relative,
            limit,
            delta <= limit));
    }

    private static void AddExact(List<FieldDiff> fields, string caseId, string field, object? expected, object? actual)
    {
        var expectedText = expected?.ToString() ?? "null";
        var actualText = actual?.ToString() ?? "null";
        fields.Add(new FieldDiff(caseId, field, expectedText, actualText, null, null, 0, expectedText == actualText));
    }

    private static string NodeText(JsonNode? node) => node?.ToJsonString() ?? "null";

    private static bool TryJsNumber(JsonNode? node, out double value)
    {
        if (node is null)
        {
            value = 0;
            return true;
        }
        if (node is JsonValue jsonValue)
        {
            if (jsonValue.TryGetValue<double>(out value)) return double.IsFinite(value);
            if (jsonValue.TryGetValue<bool>(out var boolean))
            {
                value = boolean ? 1 : 0;
                return true;
            }
            if (jsonValue.TryGetValue<string>(out var text))
            {
                text = text.Trim();
                if (text.Length == 0)
                {
                    value = 0;
                    return true;
                }
                return double.TryParse(
                    text,
                    System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out value) && double.IsFinite(value);
            }
        }
        value = 0;
        return false;
    }

    private static string JsString(JsonNode? node)
    {
        if (node is null) return "null";
        if (node is not JsonValue value) return node.ToJsonString();
        if (value.TryGetValue<string>(out var text)) return text;
        if (value.TryGetValue<bool>(out var boolean)) return boolean ? "true" : "false";
        if (value.TryGetValue<double>(out var number))
        {
            return number.ToString("G15", System.Globalization.CultureInfo.InvariantCulture);
        }
        return node.ToJsonString();
    }

    private static JsonArray RequiredArray(JsonObject value, string property) =>
        value[property]?.AsArray() ?? throw new InvalidDataException($"{property} must be an array.");

    private static string RequiredString(JsonObject value, string property) =>
        value[property]?.GetValue<string>() ?? throw new InvalidDataException($"{property} must be a string.");

    private static string LocateRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "package.json")) &&
                Directory.Exists(Path.Combine(current.FullName, "backend")))
            {
                return current.FullName;
            }
            current = current.Parent;
        }
        throw new DirectoryNotFoundException("Repository root was not found.");
    }
}

internal sealed record FieldDiff(
    string CaseId,
    string Field,
    string Expected,
    string Actual,
    double? AbsDelta,
    double? RelDelta,
    double Limit,
    bool Pass)
{
    public static FieldDiff Fail(string caseId, string field, string expected, string actual) =>
        new(caseId, field, expected, actual, null, null, 0, false);
}

internal sealed record AnalyticsGateReport(
    string Format,
    int SchemaVersion,
    DateTimeOffset GeneratedAtUtc,
    string EngineVersion,
    string GoldenPath,
    string GoldenSha256,
    int FieldCount,
    int PassedFieldCount,
    int FailedFieldCount,
    bool Pass,
    IReadOnlyList<FieldDiff> Fields);
