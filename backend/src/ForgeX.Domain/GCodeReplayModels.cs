using System.Text.Json.Serialization;

namespace ForgeX.Domain;

public sealed record GCodeTimelineBasis(string JobId, string InputSha256, string ProfileFingerprint,
    string AnalysisEngineVersion, double SourceMotionSeconds, double NetFilamentLengthM, double NetFilamentMassG);

public sealed record GCodeTimelineLayer(int Sequence, int LayerIndex, double ZMm, double StartSeconds,
    double EndSeconds, double DurationSeconds, long PathCount, double PositiveExtrusionMm, double CompletedPositiveExtrusionMm);

public sealed record GCodeLayerTimeline(string SchemaVersion, string ModelVersion, string Fingerprint,
    GCodeTimelineBasis Basis, double LeadingMotionSeconds, double TotalSeconds, double TotalPositiveExtrusionMm,
    int TotalLayers, int Offset, int Limit,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? NextOffset,
    IReadOnlyList<GCodeTimelineLayer> Layers, IReadOnlyList<string> Warnings);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record GCodeReplayInputs([property: JsonRequired] double ElapsedSeconds);

public sealed record GCodeReplayCheckpoint(string SchemaVersion, string ModelVersion, string Fingerprint,
    GCodeTimelineBasis Basis, double ElapsedSeconds, double RemainingSeconds, string Phase, int CompletedLayerCount,
    double CompletedPositiveExtrusionMm,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] GCodeTimelineLayer? ActiveLayer,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] double? LayerElapsedSeconds,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] double? LayerFraction);

public sealed class GCodeReplayException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
