using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ForgeX.GoldenDiff;

internal sealed record GoldenCase(
    string Id,
    string InputPath,
    string ExpectedSha256,
    double BedSizeMm,
    string CoordinateOrigin,
    double MaterialDensityGPerCm3,
    double NumericAbsoluteTolerance,
    double NumericRelativeTolerance,
    JsonElement Expected);

internal sealed record ActualAnalysisView(
    string Sha256,
    int TotalLayers,
    double HeightMm,
    string CoordinateOrigin,
    IReadOnlyDictionary<string, double> Bounds,
    IReadOnlyDictionary<string, double> Statistics,
    IReadOnlyDictionary<string, object> Claims,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<string> PathTypes);

internal sealed record FieldDiff(
    string CaseId,
    string Field,
    object? Expected,
    object? Actual,
    double? AbsDelta,
    double? RelDelta,
    string Limit,
    bool Pass,
    string InputSha256,
    string EngineVersion);

internal sealed record GoldenCaseSummary(
    string CaseId,
    string InputPath,
    int FieldCount,
    int PassedFieldCount,
    int FailedFieldCount,
    bool Pass);

internal sealed record ContractCheck(
    string Name,
    bool Pass,
    string Detail,
    string EngineVersion);

internal sealed record GoldenDiffReport(
    string Format,
    int SchemaVersion,
    DateTimeOffset GeneratedAtUtc,
    string EngineVersion,
    string GoldenPath,
    string GoldenSha256,
    int GoldenCaseCount,
    int FieldCount,
    int PassedFieldCount,
    int FailedFieldCount,
    bool Pass,
    IReadOnlyList<GoldenCaseSummary> Cases,
    IReadOnlyList<FieldDiff> Fields,
    IReadOnlyList<ContractCheck> ContractChecks);

internal static class GoldenRepository
{
    public const int RequiredGCodeCaseCount = 8;

    public static string LocateRoot()
    {
        foreach (var start in new[] { Environment.CurrentDirectory, AppContext.BaseDirectory })
        {
            var current = new DirectoryInfo(Path.GetFullPath(start));
            while (current is not null)
            {
                var candidate = Path.Combine(current.FullName, "tests", "golden", "stage0-golden.json");
                if (File.Exists(candidate))
                {
                    return current.FullName;
                }

                current = current.Parent;
            }
        }

        throw new DirectoryNotFoundException(
            "Repository root containing tests/golden/stage0-golden.json was not found.");
    }

    public static async Task<(IReadOnlyList<GoldenCase> Cases, string GoldenSha256)> ReadCasesAsync(
        string goldenPath,
        CancellationToken cancellationToken)
    {
        var bytes = await File.ReadAllBytesAsync(goldenPath, cancellationToken);
        var goldenSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
        using var document = JsonDocument.Parse(bytes);

        var root = document.RootElement;
        var cases = root.GetProperty("cases")
            .EnumerateArray()
            .Where(item => string.Equals(
                item.GetProperty("category").GetString(),
                "gcode",
                StringComparison.Ordinal))
            .Select(ReadCase)
            .ToArray();

        if (cases.Length != RequiredGCodeCaseCount)
        {
            throw new InvalidDataException(
                $"Golden file must contain exactly {RequiredGCodeCaseCount} G-code cases; found {cases.Length}.");
        }

        var duplicateId = cases
            .GroupBy(item => item.Id, StringComparer.Ordinal)
            .FirstOrDefault(group => group.Count() > 1);
        if (duplicateId is not null)
        {
            throw new InvalidDataException($"Duplicate Golden case id: {duplicateId.Key}");
        }

        return (cases, goldenSha256);
    }

    public static string ResolveFixture(string repositoryRoot, GoldenCase goldenCase)
    {
        var root = Path.GetFullPath(repositoryRoot)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        var fixture = Path.GetFullPath(Path.Combine(repositoryRoot, goldenCase.InputPath));

        if (!fixture.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException(
                $"Golden fixture escapes the repository root: {goldenCase.InputPath}");
        }

        if (!File.Exists(fixture))
        {
            throw new FileNotFoundException(
                $"Golden fixture does not exist: {goldenCase.InputPath}",
                fixture);
        }

        return fixture;
    }

    private static GoldenCase ReadCase(JsonElement item)
    {
        var input = item.GetProperty("input");
        if (!string.Equals(input.GetProperty("type").GetString(), "file", StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                $"G-code case {item.GetProperty("id").GetString()} must reference a file input.");
        }

        var parameters = item.GetProperty("parameters");
        var tolerance = item.GetProperty("tolerance");

        return new GoldenCase(
            RequiredString(item, "id"),
            RequiredString(input, "path"),
            RequiredString(input, "sha256"),
            parameters.GetProperty("bedSize").GetDouble(),
            RequiredString(parameters, "origin"),
            parameters.GetProperty("densityG").GetDouble(),
            tolerance.GetProperty("numericAbs").GetDouble(),
            tolerance.GetProperty("numericRel").GetDouble(),
            item.GetProperty("expected").Clone());
    }

    private static string RequiredString(JsonElement value, string propertyName)
    {
        var result = value.GetProperty(propertyName).GetString();
        return !string.IsNullOrWhiteSpace(result)
            ? result
            : throw new InvalidDataException($"Golden property {propertyName} must be a non-empty string.");
    }
}

internal static class GoldenComparator
{
    public static IReadOnlyList<FieldDiff> Compare(
        GoldenCase goldenCase,
        ActualAnalysisView actual,
        string engineVersion)
    {
        var fields = new List<FieldDiff>();
        var expected = goldenCase.Expected;

        AddExact(
            fields,
            goldenCase,
            "input.sha256",
            goldenCase.ExpectedSha256,
            actual.Sha256,
            actual.Sha256,
            engineVersion);

        AddInteger(
            fields,
            goldenCase,
            "totalLayers",
            expected.GetProperty("totalLayers").GetInt32(),
            actual.TotalLayers,
            actual.Sha256,
            engineVersion);

        AddNumber(
            fields,
            goldenCase,
            "height",
            expected.GetProperty("height").GetDouble(),
            actual.HeightMm,
            actual.Sha256,
            engineVersion);

        AddExact(
            fields,
            goldenCase,
            "coordinateOrigin",
            expected.GetProperty("coordinateOrigin").GetString(),
            actual.CoordinateOrigin,
            actual.Sha256,
            engineVersion);

        AddNumericObject(
            fields,
            goldenCase,
            "bounds",
            expected.GetProperty("bounds"),
            actual.Bounds,
            actual.Sha256,
            engineVersion);

        AddNumericObject(
            fields,
            goldenCase,
            "stats",
            expected.GetProperty("stats"),
            actual.Statistics,
            actual.Sha256,
            engineVersion);

        AddClaims(
            fields,
            goldenCase,
            expected.GetProperty("claims"),
            actual.Claims,
            actual.Sha256,
            engineVersion);

        AddStringSet(
            fields,
            goldenCase,
            "warnings",
            ReadStringArray(expected.GetProperty("warnings")),
            actual.Warnings,
            actual.Sha256,
            engineVersion);

        AddStringSet(
            fields,
            goldenCase,
            "pathTypes",
            ReadStringArray(expected.GetProperty("pathTypes")),
            actual.PathTypes,
            actual.Sha256,
            engineVersion);

        return fields;
    }

    public static FieldDiff AnalysisFailure(
        GoldenCase goldenCase,
        string actual,
        string inputSha256,
        string engineVersion) =>
        new(
            goldenCase.Id,
            "$analysis",
            "successful analysis",
            actual,
            null,
            null,
            "no exception",
            false,
            inputSha256,
            engineVersion);

    private static void AddNumericObject(
        List<FieldDiff> fields,
        GoldenCase goldenCase,
        string prefix,
        JsonElement expected,
        IReadOnlyDictionary<string, double> actual,
        string inputSha256,
        string engineVersion)
    {
        var expectedNames = expected.EnumerateObject()
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var actualNames = actual.Keys.Order(StringComparer.Ordinal).ToArray();

        AddStringSet(
            fields,
            goldenCase,
            $"{prefix}.$keys",
            expectedNames,
            actualNames,
            inputSha256,
            engineVersion);

        foreach (var property in expected.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal))
        {
            actual.TryGetValue(property.Name, out var actualValue);
            AddNumber(
                fields,
                goldenCase,
                $"{prefix}.{property.Name}",
                property.Value.GetDouble(),
                actualValue,
                inputSha256,
                engineVersion,
                actual.ContainsKey(property.Name));
        }
    }

    private static void AddClaims(
        List<FieldDiff> fields,
        GoldenCase goldenCase,
        JsonElement expected,
        IReadOnlyDictionary<string, object> actual,
        string inputSha256,
        string engineVersion)
    {
        var expectedNames = expected.EnumerateObject()
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var actualNames = actual.Keys.Order(StringComparer.Ordinal).ToArray();

        AddStringSet(
            fields,
            goldenCase,
            "claims.$keys",
            expectedNames,
            actualNames,
            inputSha256,
            engineVersion);

        foreach (var property in expected.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal))
        {
            var present = actual.TryGetValue(property.Name, out var actualValue);
            if (property.Value.ValueKind == JsonValueKind.Number)
            {
                var numericActual = present ? Convert.ToDouble(actualValue) : 0d;
                AddNumber(
                    fields,
                    goldenCase,
                    $"claims.{property.Name}",
                    property.Value.GetDouble(),
                    numericActual,
                    inputSha256,
                    engineVersion,
                    present);
                continue;
            }

            AddExact(
                fields,
                goldenCase,
                $"claims.{property.Name}",
                JsonScalar(property.Value),
                present ? actualValue : null,
                inputSha256,
                engineVersion,
                present);
        }
    }

    private static void AddNumber(
        List<FieldDiff> fields,
        GoldenCase goldenCase,
        string field,
        double expected,
        double actual,
        string inputSha256,
        string engineVersion,
        bool present = true)
    {
        double? absoluteDelta = present ? Math.Abs(actual - expected) : null;
        double? relativeDelta = present
            ? expected == 0d
                ? absoluteDelta == 0d ? 0d : null
                : absoluteDelta / Math.Abs(expected)
            : null;
        var pass = present
            && double.IsFinite(actual)
            && absoluteDelta <= goldenCase.NumericAbsoluteTolerance
            || present
            && double.IsFinite(actual)
            && relativeDelta <= goldenCase.NumericRelativeTolerance;

        fields.Add(new FieldDiff(
            goldenCase.Id,
            field,
            expected,
            present ? actual : null,
            absoluteDelta,
            relativeDelta,
            $"abs <= {goldenCase.NumericAbsoluteTolerance:R} OR rel <= {goldenCase.NumericRelativeTolerance:R}",
            pass,
            inputSha256,
            engineVersion));
    }

    private static void AddInteger(
        List<FieldDiff> fields,
        GoldenCase goldenCase,
        string field,
        int expected,
        int actual,
        string inputSha256,
        string engineVersion)
    {
        var delta = Math.Abs((double)actual - expected);
        fields.Add(new FieldDiff(
            goldenCase.Id,
            field,
            expected,
            actual,
            delta,
            expected == 0 ? (delta == 0 ? 0d : null) : delta / Math.Abs(expected),
            "exact integer",
            expected == actual,
            inputSha256,
            engineVersion));
    }

    private static void AddExact(
        List<FieldDiff> fields,
        GoldenCase goldenCase,
        string field,
        object? expected,
        object? actual,
        string inputSha256,
        string engineVersion,
        bool present = true)
    {
        fields.Add(new FieldDiff(
            goldenCase.Id,
            field,
            expected,
            present ? actual : null,
            null,
            null,
            "exact",
            present && Equals(expected, actual),
            inputSha256,
            engineVersion));
    }

    private static void AddStringSet(
        List<FieldDiff> fields,
        GoldenCase goldenCase,
        string field,
        IEnumerable<string> expected,
        IEnumerable<string> actual,
        string inputSha256,
        string engineVersion)
    {
        var normalizedExpected = NormalizeSet(expected);
        var normalizedActual = NormalizeSet(actual);
        fields.Add(new FieldDiff(
            goldenCase.Id,
            field,
            normalizedExpected,
            normalizedActual,
            null,
            null,
            "exact ordinal set",
            normalizedExpected.SequenceEqual(normalizedActual, StringComparer.Ordinal),
            inputSha256,
            engineVersion));
    }

    private static string[] NormalizeSet(IEnumerable<string> values) =>
        [.. values
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)];

    private static string[] ReadStringArray(JsonElement value) =>
        [.. value.EnumerateArray().Select(item => item.GetString() ?? string.Empty)];

    private static object? JsonScalar(JsonElement value) =>
        value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Null => null,
            _ => value.GetRawText(),
        };
}

internal static class GoldenReportWriter
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = true,
    };

    public static async Task WriteAsync(
        string artifactPath,
        GoldenDiffReport report,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(artifactPath)!);
        var temporaryPath = artifactPath + ".tmp";
        await using (var stream = new FileStream(
            temporaryPath,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            16 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan))
        {
            await JsonSerializer.SerializeAsync(stream, report, SerializerOptions, cancellationToken);
            await stream.FlushAsync(cancellationToken);
        }

        File.Move(temporaryPath, artifactPath, overwrite: true);

        await using var verificationStream = new FileStream(
            artifactPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            16 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var verificationDocument = await JsonDocument.ParseAsync(
            verificationStream,
            cancellationToken: cancellationToken);
        if (!verificationDocument.RootElement.TryGetProperty("format", out var format)
            || format.GetString() != report.Format)
        {
            throw new InvalidDataException("Golden diff artifact failed its reopen verification.");
        }
    }
}
