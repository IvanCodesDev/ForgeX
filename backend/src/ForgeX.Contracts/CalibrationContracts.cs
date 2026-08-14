using System.Text.Json.Serialization;

namespace ForgeX.Contracts;

public sealed record CalibrationTrainingRequestDto(
    string? SchemaVersion,
    CalibrationScopeRequestDto? Scope,
    IReadOnlyList<CalibrationSampleRequestDto>? Samples,
    [property: JsonPropertyName("holdout_samples")] IReadOnlyList<CalibrationSampleRequestDto>? HoldoutSamples,
    CalibrationThresholdsRequestDto? Thresholds);

public sealed record CalibrationScopeRequestDto(
    [property: JsonPropertyName("machine_id")] string? MachineId,
    string? Firmware);

public sealed record CalibrationSampleRequestDto(
    string? Id,
    [property: JsonPropertyName("planned_time_sec")] double? PlannedTimeSec,
    [property: JsonPropertyName("planned_sec")] double? PlannedSec,
    [property: JsonPropertyName("actual_time_sec")] double? ActualTimeSec,
    [property: JsonPropertyName("actual_sec")] double? ActualSec,
    [property: JsonPropertyName("machine_id")] string? MachineId,
    string? Firmware);

public sealed record CalibrationThresholdsRequestDto(
    [property: JsonPropertyName("min_drift_samples")] int? MinDriftSamples,
    [property: JsonPropertyName("max_mape")] double? MaxMape,
    [property: JsonPropertyName("max_bias")] double? MaxBias);

public sealed record CalibrationAuthorityEngineDto(string Name, string Version);

public sealed record CalibrationAuthorityResponseDto(
    string SchemaVersion,
    CalibrationAuthorityEngineDto Engine,
    object Training);
