using System.Text.Json.Serialization;

namespace ForgeX.Contracts;

public sealed record AnalyticsReportRequestDto(
    string? SchemaVersion,
    string? Question,
    IReadOnlyList<AnalyticsRowRequestDto>? Rows,
    AnalyticsProvenanceRequestDto? Provenance);

public sealed record AnalyticsRowRequestDto(
    [property: JsonPropertyName("job_id")] string? JobId,
    string? Date,
    [property: JsonPropertyName("machine_id")] string? MachineId,
    [property: JsonPropertyName("model_name")] string? ModelName,
    string? Material,
    [property: JsonPropertyName("layer_height_mm")] double? LayerHeightMm,
    [property: JsonPropertyName("duration_min")] double? DurationMin,
    [property: JsonPropertyName("filament_g")] double? FilamentG,
    [property: JsonPropertyName("cost_fen")] double? CostFen,
    string? Status,
    [property: JsonPropertyName("fail_reason")] string? FailReason,
    [property: JsonPropertyName("energy_kwh")] double? EnergyKwh);

public sealed record AnalyticsGeneratorRequestDto(
    string? Name,
    int? Version,
    long? Seed);

public sealed record AnalyticsProvenanceRequestDto(
    string? Source,
    bool? Synthetic,
    string? Badge,
    string? Note,
    AnalyticsGeneratorRequestDto? Generator,
    string? DatasetKey,
    int? RowCount);

public sealed record AnalyticsAuthorityEngineDto(
    string Name,
    string Version);

public sealed record AnalyticsAuthorityResponseDto(
    string SchemaVersion,
    AnalyticsAuthorityEngineDto Engine,
    object Report);
