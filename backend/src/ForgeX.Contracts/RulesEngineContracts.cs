using System.Text.Json;

namespace ForgeX.Contracts;

// Stage 8.3：Node 规则计算腿迁 C# 的内部端点契约（Node 迁移期专用，不进公开 OpenAPI 文档，
// 与 Stage 8.1 shares / analysis-tasks 的处理一致）。payload 用 object/JsonElement 承载：
// 原始数据行的值域（字段缺席 vs null vs 0）在定型 DTO 里无法保真。

public sealed record DatasetNormalizeRequestDto(
    string? SchemaVersion,
    string? CsvText);

public sealed record DatasetNormalizeResponseDto(
    string SchemaVersion,
    AnalyticsAuthorityEngineDto Engine,
    object Rows,
    IReadOnlyList<string> Errors,
    string Csv);

public sealed record DatasetMetaResponseDto(
    string SchemaVersion,
    AnalyticsAuthorityEngineDto Engine,
    IReadOnlyList<string> Fields,
    int MinSample,
    object Provenance);

public sealed record DatasetFarmResponseDto(
    string SchemaVersion,
    AnalyticsAuthorityEngineDto Engine,
    string Csv,
    object Rows,
    object Provenance);

public sealed record AnalyticsBriefRequestDto(
    string? SchemaVersion,
    JsonElement? Rows);

public sealed record AnalyticsBriefResponseDto(
    string SchemaVersion,
    AnalyticsAuthorityEngineDto Engine,
    string Text,
    object Facts);

public sealed record CalibrationValidateRequestDto(
    string? SchemaVersion,
    JsonElement? Bundle);

public sealed record CalibrationValidateResponseDto(
    string SchemaVersion,
    AnalyticsAuthorityEngineDto Engine,
    bool Ok,
    IReadOnlyList<string> Errors);
