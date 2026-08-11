namespace ForgeX.Contracts;

public sealed record GCodeAnalysisResponse(
    string SchemaVersion,
    GCodeEngineDto Engine,
    GCodeInputSummaryDto Input,
    GCodeProfileSummaryDto Profile,
    GCodeAnalyzeParametersDto Parameters,
    GCodeAnalysisSummaryDto Summary,
    GCodeBoundsDto Bounds,
    IReadOnlyList<GCodeLayerSummaryDto> Layers,
    GCodeToolpathVisualizationDto Visualization,
    IReadOnlyDictionary<string, string> Claims,
    IReadOnlyDictionary<string, long> PathTypeCounts,
    IReadOnlyList<GCodeWarningDto> Warnings);

public sealed record GCodeEngineDto(string Version, string Source);

public sealed record GCodeInputSummaryDto(string Sha256, long BytesRead, long LinesRead);

public sealed record GCodeProfileSummaryDto(
    string MachineProfileId,
    string MaterialProfileId,
    double BedSizeMm,
    string CoordinateOrigin,
    double FilamentDensityGPerCm3,
    string Fingerprint);

public sealed record GCodeAnalyzeParametersDto(
    double BedSizeMm,
    string CoordinateOrigin,
    double FilamentDensityGPerCm3);

public sealed record GCodeAnalysisSummaryDto(
    int TotalLayers,
    double HeightMm,
    double ExtrusionLengthMm,
    double TravelLengthMm,
    double EstimatedTimeSeconds,
    double VolumeCm3,
    double FilamentLengthM,
    double FilamentMassG);

public sealed record GCodeBoundsDto(double MinX, double MaxX, double MinY, double MaxY);

public sealed record GCodeLayerSummaryDto(
    int Index,
    double ZMm,
    long PathCount,
    double ExtrusionLengthMm,
    double TravelLengthMm,
    double TimeSeconds,
    double FilamentLengthMm,
    IReadOnlyDictionary<string, long> PathTypeCounts);

public sealed record GCodeToolpathVisualizationDto(
    string Encoding,
    int RecordStrideBytes,
    long SourceSegmentCount,
    int SegmentCount,
    bool Truncated,
    long SamplingStride,
    IReadOnlyList<string> PathTypes,
    IReadOnlyList<GCodeToolpathLayerDto> Layers,
    string DataBase64);

public sealed record GCodeToolpathLayerDto(
    int Index,
    long SourceSegmentCount,
    int SegmentOffset,
    int SegmentCount);

public sealed record GCodeWarningDto(string Code, string Message);
