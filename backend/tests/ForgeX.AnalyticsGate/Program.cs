using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using ForgeX.Analytics;

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
