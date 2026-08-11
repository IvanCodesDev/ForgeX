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
            var artifactPath = Path.Combine(repositoryRoot, "backend", "artifacts", "gcode-golden-diff.json");
            var (goldenCases, goldenSha256) = await GoldenRepository.ReadCasesAsync(
                goldenPath,
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
