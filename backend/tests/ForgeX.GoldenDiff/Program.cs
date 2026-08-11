using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ForgeX.Domain;
using ForgeX.GoldenDiff;
using ForgeX.Simulation;

return await GoldenDiffProgram.RunAsync(CancellationToken.None);

internal static class GoldenDiffProgram
{
    public static async Task<int> RunAsync(CancellationToken cancellationToken)
    {
        try
        {
            var repositoryRoot = GoldenRepository.LocateRoot();
            var goldenPath = Path.Combine(repositoryRoot, "tests", "golden", "stage0-golden.json");
            var layerPlanGoldenPath = Path.Combine(repositoryRoot, "tests", "golden", "stage5-layer-plan-golden.json");
            var artifactPath = Path.Combine(repositoryRoot, "backend", "artifacts", "gcode-golden-diff.json");
            var (goldenCases, goldenSha256) = await GoldenRepository.ReadCasesAsync(
                goldenPath,
                cancellationToken);
            var (layerPlanCases, layerPlanGoldenSha256) = await GoldenRepository.ReadLayerPlanCasesAsync(
                layerPlanGoldenPath,
                cancellationToken);

            var analyzer = new StreamingGCodeAnalyzer();
            var fields = new List<FieldDiff>();
            GCodeAnalysisResult? contractBaseline = null;
            GoldenCase? contractBaselineCase = null;
            string? contractBaselineFixture = null;

            foreach (var goldenCase in goldenCases)
            {
                var fixturePath = GoldenRepository.ResolveFixture(repositoryRoot, goldenCase);
                var rawSha256 = await HashFileAsync(fixturePath, cancellationToken);
                try
                {
                    await using var stream = new FileStream(
                        fixturePath,
                        FileMode.Open,
                        FileAccess.Read,
                        FileShare.Read,
                        64 * 1024,
                        FileOptions.Asynchronous | FileOptions.SequentialScan);
                    var result = await analyzer.AnalyzeAsync(
                        stream,
                        CreateOptions(goldenCase),
                        cancellationToken);

                    fields.AddRange(GoldenComparator.Compare(
                        goldenCase,
                        ToView(result),
                        result.EngineVersion));
                    fields.AddRange(GoldenComparator.CompareLayerPlan(
                        goldenCase,
                        FindLayerPlanCase(goldenCase, layerPlanCases),
                        result,
                        result.EngineVersion));

                    contractBaseline ??= result;
                    contractBaselineCase ??= goldenCase;
                    contractBaselineFixture ??= fixturePath;
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    fields.Add(GoldenComparator.AnalysisFailure(
                        goldenCase,
                        $"{exception.GetType().Name}: {exception.Message}",
                        rawSha256,
                        StreamingGCodeAnalyzer.EngineVersion));
                }
            }

            var contractChecks = contractBaseline is not null
                && contractBaselineCase is not null
                && contractBaselineFixture is not null
                ? await RunContractChecksAsync(
                    analyzer,
                    contractBaselineCase,
                    contractBaselineFixture,
                    contractBaseline,
                    cancellationToken)
                :
                [
                    new ContractCheck(
                        "contract-baseline",
                        false,
                        "No Golden case completed, so streaming contract probes could not run.",
                        StreamingGCodeAnalyzer.EngineVersion),
                ];

            var caseSummaries = goldenCases
                .Select(goldenCase =>
                {
                    var caseFields = fields
                        .Where(field => field.CaseId == goldenCase.Id)
                        .ToArray();
                    var passed = caseFields.Count(field => field.Pass);
                    return new GoldenCaseSummary(
                        goldenCase.Id,
                        goldenCase.InputPath,
                        caseFields.Length,
                        passed,
                        caseFields.Length - passed,
                        caseFields.Length > 0 && passed == caseFields.Length);
                })
                .ToArray();

            var passedFieldCount = fields.Count(field => field.Pass);
            var allContractChecksPass = contractChecks.All(check => check.Pass);
            var pass = passedFieldCount == fields.Count && allContractChecksPass;
            var report = new GoldenDiffReport(
                Format: "forgex-gcode-golden-diff",
                SchemaVersion: 1,
                GeneratedAtUtc: DateTimeOffset.UtcNow,
                EngineVersion: StreamingGCodeAnalyzer.EngineVersion,
                GoldenPath: Path.GetRelativePath(repositoryRoot, goldenPath).Replace('\\', '/'),
                GoldenSha256: goldenSha256,
                GoldenCaseCount: goldenCases.Count,
                LayerPlanGoldenPath: Path.GetRelativePath(repositoryRoot, layerPlanGoldenPath).Replace('\\', '/'),
                LayerPlanGoldenSha256: layerPlanGoldenSha256,
                LayerPlanGoldenCaseCount: layerPlanCases.Count,
                FieldCount: fields.Count,
                PassedFieldCount: passedFieldCount,
                FailedFieldCount: fields.Count - passedFieldCount,
                Pass: pass,
                Cases: caseSummaries,
                Fields: fields,
                ContractChecks: contractChecks);

            await GoldenReportWriter.WriteAsync(artifactPath, report, cancellationToken);

            foreach (var summary in caseSummaries)
            {
                Console.WriteLine(
                    $"[{(summary.Pass ? "PASS" : "FAIL")}] {summary.CaseId}: "
                    + $"{summary.PassedFieldCount}/{summary.FieldCount} fields");
            }

            foreach (var check in contractChecks)
            {
                Console.WriteLine($"[{(check.Pass ? "PASS" : "FAIL")}] contract/{check.Name}: {check.Detail}");
            }

            Console.WriteLine(
                $"GoldenDiff: {(pass ? "PASS" : "FAIL")} — "
                + $"{passedFieldCount}/{fields.Count} fields, "
                + $"artifact={artifactPath}");
            return pass ? 0 : 1;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            Console.Error.WriteLine($"GoldenDiff infrastructure failure: {exception}");
            return 1;
        }
    }

    private static GCodeAnalysisOptions CreateOptions(GoldenCase goldenCase) =>
        new(
            BedSizeMm: goldenCase.BedSizeMm,
            CoordinateOrigin: ParseOrigin(goldenCase.CoordinateOrigin),
            MaterialDensityGPerCm3: goldenCase.MaterialDensityGPerCm3);

    private static LayerPlanGoldenCase FindLayerPlanCase(
        GoldenCase goldenCase,
        IReadOnlyList<LayerPlanGoldenCase> layerPlanCases)
    {
        var matches = layerPlanCases
            .Where(layerCase =>
                string.Equals(layerCase.InputPath, goldenCase.InputPath, StringComparison.Ordinal)
                && string.Equals(layerCase.CoordinateOrigin, goldenCase.CoordinateOrigin, StringComparison.Ordinal)
                && layerCase.BedSizeMm == goldenCase.BedSizeMm)
            .ToArray();
        return matches.Length == 1
            ? matches[0]
            : throw new InvalidDataException(
                $"Expected exactly one layer-plan Golden case for {goldenCase.Id}; found {matches.Length}.");
    }

    private static CoordinateOrigin ParseOrigin(string value) =>
        value switch
        {
            "corner" => CoordinateOrigin.Corner,
            "center" => CoordinateOrigin.Center,
            _ => throw new InvalidDataException($"Unsupported Golden coordinate origin: {value}"),
        };

    private static ActualAnalysisView ToView(GCodeAnalysisResult result)
    {
        var claims = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var (key, value) in result.Claims)
        {
            if (IsNumericClaim(key)
                && double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number))
            {
                claims[key] = number;
            }
            else
            {
                claims[key] = value;
            }
        }

        return new ActualAnalysisView(
            result.Sha256,
            result.TotalLayers,
            result.HeightMm,
            result.CoordinateOrigin.ToString().ToLowerInvariant(),
            new Dictionary<string, double>(StringComparer.Ordinal)
            {
                ["minX"] = result.Bounds.MinX,
                ["maxX"] = result.Bounds.MaxX,
                ["minY"] = result.Bounds.MinY,
                ["maxY"] = result.Bounds.MaxY,
            },
            new Dictionary<string, double>(StringComparer.Ordinal)
            {
                ["extLenMm"] = result.Statistics.ExtrusionLengthMm,
                ["travelMm"] = result.Statistics.TravelLengthMm,
                ["timeSec"] = result.Statistics.TimeSeconds,
                ["volumeCm3"] = result.Statistics.VolumeCm3,
                ["filamentM"] = result.Statistics.FilamentLengthM,
                ["filamentG"] = result.Statistics.FilamentMassG,
            },
            claims,
            [.. result.Warnings.Select(warning => warning.Message)],
            [.. result.PathTypeCounts
                .Where(entry => entry.Value > 0)
                .Select(entry => entry.Key)
                .Order(StringComparer.Ordinal)]);
    }

    private static bool IsNumericClaim(string key) =>
        key is "timeSec" or "filamentMm" or "filamentG" or "layerHeightMm";

    private static async Task<IReadOnlyList<ContractCheck>> RunContractChecksAsync(
        StreamingGCodeAnalyzer analyzer,
        GoldenCase baselineCase,
        string baselineFixture,
        GCodeAnalysisResult baseline,
        CancellationToken cancellationToken)
    {
        var checks = new List<ContractCheck>
        {
            await RunProbeAsync(
                "malformed-input",
                () => CheckMalformedAsync(analyzer, cancellationToken)),
            await RunProbeAsync(
                "pre-cancelled",
                () => CheckCancellationAsync(analyzer)),
            await RunProbeAsync(
                "non-seekable-stream",
                () => CheckNonSeekableAsync(
                    analyzer,
                    baselineCase,
                    baselineFixture,
                    baseline,
                    cancellationToken)),
            await RunProbeAsync(
                "crlf-utf8-byte-boundary",
                () => CheckCrLfUtf8BoundaryAsync(
                    analyzer,
                    baselineCase,
                    baselineFixture,
                    baseline,
                    cancellationToken)),
            await RunProbeAsync(
                "profile-summary",
                () => CheckProfileSummaryAsync(
                    analyzer,
                    baselineCase,
                    baselineFixture,
                    cancellationToken)),
            await RunProbeAsync(
                "profile-id-validation",
                () => CheckProfileIdValidationAsync(analyzer, cancellationToken)),
            await RunProbeAsync(
                "layer-plan-invariants",
                () => Task.FromResult(CheckLayerPlanInvariants(baseline))),
            await RunProbeAsync(
                "toolpath-visualization-invariants",
                () => Task.FromResult(CheckToolpathVisualizationInvariants(baseline))),
            await RunProbeAsync(
                "toolpath-visualization-budget",
                () => CheckToolpathVisualizationBudgetAsync(analyzer, cancellationToken)),
            await RunProbeAsync(
                "layer-limit",
                () => CheckLayerLimitAsync(analyzer, cancellationToken)),
        };
        return checks;
    }

    private static async Task<ContractCheck> RunProbeAsync(
        string name,
        Func<Task<ContractCheck>> probe)
    {
        try
        {
            return await probe();
        }
        catch (Exception exception)
        {
            return ContractFailure(name, $"{exception.GetType().Name}: {exception.Message}");
        }
    }

    private static async Task<ContractCheck> CheckMalformedAsync(
        StreamingGCodeAnalyzer analyzer,
        CancellationToken cancellationToken)
    {
        var malformed = Encoding.UTF8.GetBytes("; malformed: 无挤出路径\r\nG90\r\nG28\r\nG1 X10 Y10 F1200\r\n");
        await using var stream = new ThrottledNonSeekableStream(new MemoryStream(malformed, writable: false), 1);
        try
        {
            await analyzer.AnalyzeAsync(stream, new GCodeAnalysisOptions(), cancellationToken);
            return ContractFailure("malformed-input", "Malformed input unexpectedly produced a result.");
        }
        catch (GCodeAnalysisException exception)
        {
            var pass = exception.Code == "GCODE_NO_EXTRUSION_PATH";
            return new ContractCheck(
                "malformed-input",
                pass,
                $"stableCode={exception.Code}",
                StreamingGCodeAnalyzer.EngineVersion);
        }
    }

    private static async Task<ContractCheck> CheckCancellationAsync(StreamingGCodeAnalyzer analyzer)
    {
        using var cancellationSource = new CancellationTokenSource();
        cancellationSource.Cancel();
        await using var stream = new MemoryStream(Encoding.UTF8.GetBytes("G28\n"), writable: false);
        try
        {
            await analyzer.AnalyzeAsync(stream, new GCodeAnalysisOptions(), cancellationSource.Token);
            return ContractFailure("pre-cancelled", "Pre-cancelled analysis unexpectedly produced a result.");
        }
        catch (OperationCanceledException)
        {
            return new ContractCheck(
                "pre-cancelled",
                true,
                "OperationCanceledException observed before parsing.",
                StreamingGCodeAnalyzer.EngineVersion);
        }
    }

    private static async Task<ContractCheck> CheckNonSeekableAsync(
        StreamingGCodeAnalyzer analyzer,
        GoldenCase baselineCase,
        string baselineFixture,
        GCodeAnalysisResult baseline,
        CancellationToken cancellationToken)
    {
        await using var file = new FileStream(
            baselineFixture,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            4096,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        await using var stream = new ThrottledNonSeekableStream(file, 7);
        var actual = await analyzer.AnalyzeAsync(stream, CreateOptions(baselineCase), cancellationToken);
        var pass = actual.Sha256 == baseline.Sha256 && SemanticallyEquivalent(actual, baseline);
        return new ContractCheck(
            "non-seekable-stream",
            pass,
            $"canSeek={stream.CanSeek}; shaMatch={actual.Sha256 == baseline.Sha256}; semanticMatch={SemanticallyEquivalent(actual, baseline)}",
            StreamingGCodeAnalyzer.EngineVersion);
    }

    private static async Task<ContractCheck> CheckCrLfUtf8BoundaryAsync(
        StreamingGCodeAnalyzer analyzer,
        GoldenCase baselineCase,
        string baselineFixture,
        GCodeAnalysisResult baseline,
        CancellationToken cancellationToken)
    {
        var original = await File.ReadAllTextAsync(baselineFixture, Encoding.UTF8, cancellationToken);
        var normalized = original.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
        var crlfText = "; UTF-8 边界：喷头与热床\r\n" + normalized.Replace("\n", "\r\n", StringComparison.Ordinal);
        var bytes = Encoding.UTF8.GetBytes(crlfText);
        var expectedSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
        await using var stream = new ThrottledNonSeekableStream(new MemoryStream(bytes, writable: false), 1);
        var actual = await analyzer.AnalyzeAsync(stream, CreateOptions(baselineCase), cancellationToken);
        var semanticMatch = SemanticallyEquivalent(actual, baseline);
        var shaMatch = actual.Sha256 == expectedSha256;
        return new ContractCheck(
            "crlf-utf8-byte-boundary",
            semanticMatch && shaMatch,
            $"maxReadBytes=1; shaMatch={shaMatch}; semanticMatch={semanticMatch}",
            StreamingGCodeAnalyzer.EngineVersion);
    }

    private static async Task<ContractCheck> CheckProfileSummaryAsync(
        StreamingGCodeAnalyzer analyzer,
        GoldenCase baselineCase,
        string baselineFixture,
        CancellationToken cancellationToken)
    {
        var options = CreateOptions(baselineCase) with
        {
            MachineProfileId = "delta",
            MaterialProfileId = "PETG",
        };
        var first = await AnalyzeFixtureAsync(analyzer, baselineFixture, options, cancellationToken);
        var second = await AnalyzeFixtureAsync(analyzer, baselineFixture, options, cancellationToken);
        var changed = await AnalyzeFixtureAsync(
            analyzer,
            baselineFixture,
            options with { MaterialProfileId = "ABS" },
            cancellationToken);
        var profile = first.Profile;
        var valuesMatch =
            profile.MachineProfileId == options.MachineProfileId &&
            profile.MaterialProfileId == options.MaterialProfileId &&
            profile.BedSizeMm == options.BedSizeMm &&
            profile.CoordinateOrigin == options.CoordinateOrigin &&
            profile.FilamentDensityGPerCm3 == options.MaterialDensityGPerCm3;
        var fingerprintShape = profile.Fingerprint.Length == 64 &&
            profile.Fingerprint.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
        var deterministic = profile.Fingerprint == second.Profile.Fingerprint;
        var sensitive = profile.Fingerprint != changed.Profile.Fingerprint;
        return new ContractCheck(
            "profile-summary",
            valuesMatch && fingerprintShape && deterministic && sensitive,
            $"valuesMatch={valuesMatch}; fingerprintShape={fingerprintShape}; deterministic={deterministic}; materialSensitive={sensitive}",
            StreamingGCodeAnalyzer.EngineVersion);
    }

    private static async Task<ContractCheck> CheckProfileIdValidationAsync(
        StreamingGCodeAnalyzer analyzer,
        CancellationToken cancellationToken)
    {
        await using var stream = new MemoryStream(
            Encoding.UTF8.GetBytes("G90\nM82\nG1 X0 Y0 Z0.2 F1200\nG1 X10 Y10 E1 F900\n"),
            writable: false);
        try
        {
            await analyzer.AnalyzeAsync(
                stream,
                new GCodeAnalysisOptions(MachineProfileId: "../invalid"),
                cancellationToken);
            return ContractFailure("profile-id-validation", "Invalid Profile identifier unexpectedly produced a result.");
        }
        catch (GCodeAnalysisException exception)
        {
            var pass = exception.Code == "GCODE_INVALID_OPTIONS";
            return new ContractCheck(
                "profile-id-validation",
                pass,
                $"stableCode={exception.Code}",
                StreamingGCodeAnalyzer.EngineVersion);
        }
    }

    private static ContractCheck CheckLayerPlanInvariants(GCodeAnalysisResult result)
    {
        var sequential = result.Layers.Select(static layer => layer.Index).SequenceEqual(Enumerable.Range(0, result.Layers.Count));
        var sorted = result.Layers.Zip(result.Layers.Skip(1), static (left, right) => left.ZMm < right.ZMm).All(static value => value);
        var pathCountsMatch = result.Layers.All(static layer => layer.PathCount == layer.PathTypeCounts.Values.Sum());
        var extrusionMatches = Math.Abs(result.Layers.Sum(static layer => layer.ExtrusionLengthMm) - result.Statistics.ExtrusionLengthMm) <= 1e-9;
        var aggregateTypes = result.Layers
            .SelectMany(static layer => layer.PathTypeCounts)
            .GroupBy(static entry => entry.Key, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.Sum(static entry => entry.Value), StringComparer.Ordinal);
        var typesMatch = aggregateTypes.Count == result.PathTypeCounts.Count &&
            aggregateTypes.All(entry => result.PathTypeCounts.GetValueOrDefault(entry.Key) == entry.Value);
        var countAndHeightMatch = result.Layers.Count == result.TotalLayers &&
            Math.Abs(result.Layers[^1].ZMm - result.HeightMm) <= 1e-9;
        var pass = sequential && sorted && pathCountsMatch && extrusionMatches && typesMatch && countAndHeightMatch;
        return new ContractCheck(
            "layer-plan-invariants",
            pass,
            $"sequential={sequential}; sorted={sorted}; pathCounts={pathCountsMatch}; extrusion={extrusionMatches}; types={typesMatch}; countHeight={countAndHeightMatch}",
            StreamingGCodeAnalyzer.EngineVersion);
    }

    private static ContractCheck CheckToolpathVisualizationInvariants(GCodeAnalysisResult result)
    {
        var visualization = result.Visualization;
        if (visualization is null)
        {
            return ContractFailure("toolpath-visualization-invariants", "Visualization is missing.");
        }

        var layerAligned = visualization.Layers.Count == result.Layers.Count &&
            visualization.Layers.Select(static layer => layer.Index).SequenceEqual(Enumerable.Range(0, result.Layers.Count));
        var contiguous = visualization.Layers
            .Select((layer, index) => layer.SegmentOffset == visualization.Layers.Take(index).Sum(static item => item.SegmentCount))
            .All(static value => value);
        var countsMatch = visualization.Layers.Sum(static layer => layer.SegmentCount) == visualization.SegmentCount &&
            visualization.Layers.Sum(static layer => layer.SourceSegmentCount) == visualization.SourceSegmentCount;
        var payloadMatches = visualization.Encoding == "forgex-toolpath-f32le-v1" &&
            visualization.RecordStrideBytes == 20 &&
            visualization.Data.Length == visualization.SegmentCount * visualization.RecordStrideBytes;
        var recordsValid = true;
        for (var index = 0; index < visualization.SegmentCount; index++)
        {
            var record = visualization.Data.AsSpan(index * visualization.RecordStrideBytes, visualization.RecordStrideBytes);
            recordsValid &= float.IsFinite(BinaryPrimitives.ReadSingleLittleEndian(record));
            recordsValid &= float.IsFinite(BinaryPrimitives.ReadSingleLittleEndian(record[4..]));
            recordsValid &= float.IsFinite(BinaryPrimitives.ReadSingleLittleEndian(record[8..]));
            recordsValid &= float.IsFinite(BinaryPrimitives.ReadSingleLittleEndian(record[12..]));
            var typeIndex = BinaryPrimitives.ReadInt32LittleEndian(record[16..]);
            recordsValid &= typeIndex >= 0 && typeIndex < visualization.PathTypes.Count;
        }

        var pass = layerAligned && contiguous && countsMatch && payloadMatches && recordsValid;
        return new ContractCheck(
            "toolpath-visualization-invariants",
            pass,
            $"layerAligned={layerAligned}; contiguous={contiguous}; counts={countsMatch}; payload={payloadMatches}; records={recordsValid}; segments={visualization.SegmentCount}/{visualization.SourceSegmentCount}",
            StreamingGCodeAnalyzer.EngineVersion);
    }

    private static async Task<ContractCheck> CheckToolpathVisualizationBudgetAsync(
        StreamingGCodeAnalyzer analyzer,
        CancellationToken cancellationToken)
    {
        var builder = new StringBuilder("G90\nM83\nG1 X0 Y0 Z0.2 F1200\n");
        for (var index = 1; index <= 10; index++)
        {
            builder.AppendLine(FormattableString.Invariant($"G1 X{index} Y{index} E0.1 F900"));
        }
        await using var stream = new MemoryStream(Encoding.UTF8.GetBytes(builder.ToString()), writable: false);
        var result = await analyzer.AnalyzeAsync(
            stream,
            new GCodeAnalysisOptions(MaxLayers: 2, MaxVisualizationSegments: 4),
            cancellationToken);
        var visualization = result.Visualization!;
        var pass = visualization.SourceSegmentCount == 10 &&
            visualization.SegmentCount is > 0 and <= 4 &&
            visualization.Truncated &&
            visualization.SamplingStride > 1 &&
            visualization.Layers.Count == 1 &&
            visualization.Layers[0].SourceSegmentCount == 10 &&
            visualization.Data.Length <= 4 * 20;
        return new ContractCheck(
            "toolpath-visualization-budget",
            pass,
            $"segments={visualization.SegmentCount}/{visualization.SourceSegmentCount}; stride={visualization.SamplingStride}; bytes={visualization.Data.Length}",
            StreamingGCodeAnalyzer.EngineVersion);
    }

    private static async Task<ContractCheck> CheckLayerLimitAsync(
        StreamingGCodeAnalyzer analyzer,
        CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(
            "G90\nM82\nG1 X0 Y0 Z0.2 F1200\nG1 X10 Y10 E1 F900\nG1 Z0.4\nG1 X20 Y20 E2 F900\n");
        await using var stream = new MemoryStream(bytes, writable: false);
        try
        {
            await analyzer.AnalyzeAsync(
                stream,
                new GCodeAnalysisOptions(MaxLayers: 1),
                cancellationToken);
            return ContractFailure("layer-limit", "Layer limit unexpectedly accepted a second extrusion layer.");
        }
        catch (GCodeAnalysisException exception)
        {
            var pass = exception.Code == "GCODE_MAX_LAYERS_EXCEEDED";
            return new ContractCheck(
                "layer-limit",
                pass,
                $"stableCode={exception.Code}",
                StreamingGCodeAnalyzer.EngineVersion);
        }
    }

    private static async Task<GCodeAnalysisResult> AnalyzeFixtureAsync(
        StreamingGCodeAnalyzer analyzer,
        string fixturePath,
        GCodeAnalysisOptions options,
        CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(
            fixturePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            64 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        return await analyzer.AnalyzeAsync(stream, options, cancellationToken);
    }

    private static bool SemanticallyEquivalent(GCodeAnalysisResult left, GCodeAnalysisResult right)
    {
        var leftView = ToView(left) with { Sha256 = string.Empty };
        var rightView = ToView(right) with { Sha256 = string.Empty };
        return JsonSerializer.Serialize(leftView) == JsonSerializer.Serialize(rightView);
    }

    private static ContractCheck ContractFailure(string name, string detail) =>
        new(name, false, detail, StreamingGCodeAnalyzer.EngineVersion);

    private static async Task<string> HashFileAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            16 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        var digest = await SHA256.HashDataAsync(stream, cancellationToken);
        return Convert.ToHexStringLower(digest);
    }
}

internal sealed class ThrottledNonSeekableStream(Stream inner, int maximumReadSize) : Stream
{
    private readonly Stream _inner = inner ?? throw new ArgumentNullException(nameof(inner));
    private readonly int _maximumReadSize = maximumReadSize > 0
        ? maximumReadSize
        : throw new ArgumentOutOfRangeException(nameof(maximumReadSize));

    public override bool CanRead => _inner.CanRead;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override void Flush()
    {
    }

    public override int Read(byte[] buffer, int offset, int count) =>
        _inner.Read(buffer, offset, Math.Min(count, _maximumReadSize));

    public override ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default) =>
        _inner.ReadAsync(buffer[..Math.Min(buffer.Length, _maximumReadSize)], cancellationToken);

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _inner.Dispose();
        }

        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await _inner.DisposeAsync();
        GC.SuppressFinalize(this);
    }
}
