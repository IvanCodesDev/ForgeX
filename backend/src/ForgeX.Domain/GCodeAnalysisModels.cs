using System.Collections.ObjectModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace ForgeX.Domain;

/// <summary>Defines how XY coordinates in a G-code file relate to the print bed.</summary>
public enum CoordinateOrigin
{
    Corner = 0,
    Center = 1,
}

/// <summary>Limits and physical inputs for one authoritative G-code analysis.</summary>
public sealed record GCodeAnalysisOptions(
    double BedSizeMm = 256d,
    CoordinateOrigin CoordinateOrigin = CoordinateOrigin.Corner,
    double MaterialDensityGPerCm3 = 1.24d,
    long MaxInputBytes = 64L * 1024 * 1024,
    long MaxLines = 4_000_000L,
    int MaxLineLength = 1_048_576,
    string MachineProfileId = "unspecified-machine",
    string MaterialProfileId = "unspecified-material",
    int MaxLayers = 20_000,
    int MaxVisualizationSegments = 100_000,
    double MaterialPriceCnyPerKg = 0d,
    double NozzleTemperatureMinC = 0d,
    double NozzleTemperatureMaxC = 500d,
    double BedTemperatureMinC = 0d,
    double MaterialMaxSpeedMmPerSecond = 1000d,
    double MaterialMaxFlowMm3PerSecond = 100d)
{
    /// <summary>Compatibility alias used by the streaming implementation.</summary>
    public long MaxBytes => MaxInputBytes;
}

/// <summary>Stable identity and effective physical values for the selected Profile pair.</summary>
public sealed record GCodeProfileSummary(
    string MachineProfileId,
    string MaterialProfileId,
    double BedSizeMm,
    CoordinateOrigin CoordinateOrigin,
    double FilamentDensityGPerCm3,
    double MaterialPriceCnyPerKg,
    double NozzleTemperatureMinC,
    double NozzleTemperatureMaxC,
    double BedTemperatureMinC,
    double MaterialMaxSpeedMmPerSecond,
    double MaterialMaxFlowMm3PerSecond,
    string Fingerprint)
{
    public const string FingerprintVersion = "forgex-gcode-profile/2";

    public static GCodeProfileSummary Create(GCodeAnalysisOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var canonical = string.Join(
            '\n',
            FingerprintVersion,
            options.MachineProfileId,
            options.MaterialProfileId,
            options.BedSizeMm.ToString("R", CultureInfo.InvariantCulture),
            options.CoordinateOrigin.ToString().ToLowerInvariant(),
            options.MaterialDensityGPerCm3.ToString("R", CultureInfo.InvariantCulture),
            options.MaterialPriceCnyPerKg.ToString("R", CultureInfo.InvariantCulture),
            options.NozzleTemperatureMinC.ToString("R", CultureInfo.InvariantCulture),
            options.NozzleTemperatureMaxC.ToString("R", CultureInfo.InvariantCulture),
            options.BedTemperatureMinC.ToString("R", CultureInfo.InvariantCulture),
            options.MaterialMaxSpeedMmPerSecond.ToString("R", CultureInfo.InvariantCulture),
            options.MaterialMaxFlowMm3PerSecond.ToString("R", CultureInfo.InvariantCulture));
        var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
        return new GCodeProfileSummary(
            options.MachineProfileId,
            options.MaterialProfileId,
            options.BedSizeMm,
            options.CoordinateOrigin,
            options.MaterialDensityGPerCm3,
            options.MaterialPriceCnyPerKg,
            options.NozzleTemperatureMinC,
            options.NozzleTemperatureMaxC,
            options.BedTemperatureMinC,
            options.MaterialMaxSpeedMmPerSecond,
            options.MaterialMaxFlowMm3PerSecond,
            fingerprint);
    }
}

/// <summary>Centered XY bounds of all extrusion moves, in millimetres.</summary>
public sealed record GCodeBounds(
    double MinX,
    double MaxX,
    double MinY,
    double MaxY);

/// <summary>Totals recomputed from movement and extrusion commands.</summary>
public sealed record GCodeStatistics(
    double ExtrusionLengthMm,
    double TravelLengthMm,
    double TimeSeconds,
    double VolumeCm3,
    double FilamentLengthM,
    double FilamentMassG);

/// <summary>A stable machine-readable warning code and its operator-facing description.</summary>
public sealed record GCodeWarning(string Code, string Message);

/// <summary>Aggregated evidence for one parsed extrusion layer.</summary>
public sealed record GCodeLayerSummary(
    int Index,
    double ZMm,
    long PathCount,
    double ExtrusionLengthMm,
    double TravelLengthMm,
    double TimeSeconds,
    double FilamentLengthMm,
    IReadOnlyDictionary<string, long> PathTypeCounts);

/// <summary>A bounded layer slice within the packed visualization segment buffer.</summary>
public sealed record GCodeToolpathLayer(
    int Index,
    long SourceSegmentCount,
    int SegmentOffset,
    int SegmentCount);

/// <summary>
/// Display-only extrusion geometry. Each little-endian record contains four float32 XY values
/// followed by one int32 path-type index; summary and layer-plan fields remain authoritative.
/// </summary>
public sealed record GCodeToolpathVisualization(
    string Encoding,
    int RecordStrideBytes,
    long SourceSegmentCount,
    int SegmentCount,
    bool Truncated,
    long SamplingStride,
    IReadOnlyList<string> PathTypes,
    IReadOnlyList<GCodeToolpathLayer> Layers,
    byte[] Data);

/// <summary>Authoritative material quantity and direct filament-cost estimate.</summary>
public sealed record GCodeMaterialEstimate(
    string MaterialProfileId,
    double FilamentDiameterMm,
    double DensityGPerCm3,
    double VolumeCm3,
    double FilamentLengthM,
    double FilamentMassG,
    double PriceCnyPerKg,
    double MaterialCostCny);

/// <summary>One bounded, machine-readable preflight risk finding.</summary>
public sealed record GCodeRiskFinding(
    string Code,
    string Severity,
    string Message,
    double? Observed = null,
    double? Minimum = null,
    double? Maximum = null,
    string? Unit = null);

/// <summary>Deterministic preflight risk assessment derived from G-code and effective Profile limits.</summary>
public sealed record GCodeRiskAssessment(
    string Level,
    int Score,
    double? NozzleTemperatureC,
    double? BedTemperatureC,
    double MaxExtrusionSpeedMmPerSecond,
    double MaxVolumetricFlowMm3PerSecond,
    IReadOnlyList<GCodeRiskFinding> Findings);

/// <summary>The deterministic, auditable result of one streamed G-code analysis.</summary>
public sealed record GCodeAnalysisResult(
    string Sha256,
    string EngineVersion,
    string Source,
    GCodeProfileSummary Profile,
    CoordinateOrigin CoordinateOrigin,
    long BytesRead,
    long LinesRead,
    int TotalLayers,
    double HeightMm,
    GCodeBounds Bounds,
    GCodeStatistics Statistics,
    IReadOnlyDictionary<string, string> Claims,
    IReadOnlyDictionary<string, long> PathTypeCounts,
    IReadOnlyList<GCodeLayerSummary> Layers,
    IReadOnlyList<GCodeWarning> Warnings,
    GCodeToolpathVisualization? Visualization = null,
    GCodeMaterialEstimate? Material = null,
    GCodeRiskAssessment? Risk = null);

/// <summary>An analysis failure with a stable code suitable for API problem details.</summary>
public sealed class GCodeAnalysisException : Exception
{
    public GCodeAnalysisException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    public GCodeAnalysisException(string code, string message, Exception innerException)
        : base(message, innerException)
    {
        Code = code;
    }

    public string Code { get; }
}

/// <summary>Helpers for exposing owned collection snapshots as read-only contracts.</summary>
public static class GCodeReadOnly
{
    public static IReadOnlyDictionary<TKey, TValue> Dictionary<TKey, TValue>(
        IDictionary<TKey, TValue> source)
        where TKey : notnull
    {
        ArgumentNullException.ThrowIfNull(source);
        return new ReadOnlyDictionary<TKey, TValue>(new Dictionary<TKey, TValue>(source));
    }

    public static IReadOnlyList<T> List<T>(IEnumerable<T> source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return Array.AsReadOnly(source.ToArray());
    }
}
