using System.Text.Json;
using System.Text.Json.Serialization;

namespace ForgeX.Contracts;

/// <summary>
/// Read-model of a Node analysis task persisted in forgex.node_analysis_tasks.
/// During Stage 8.1 the Node runtime keeps writing these records (it still owns the
/// computation); ForgeX.Api serves history reads and event streaming from the shared
/// PostgreSQL row, which is how analysis-task SSE joins the jobs event model.
/// </summary>
public sealed record AnalysisTaskSnapshotDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("question")] string Question,
    [property: JsonPropertyName("datasourceId")] string DatasourceId,
    [property: JsonPropertyName("engine")] string Engine,
    [property: JsonPropertyName("provider")] string Provider,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("progress")] double Progress,
    [property: JsonPropertyName("phase")] string Phase,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("lastEventSeq")] long LastEventSeq,
    [property: JsonPropertyName("report")] JsonElement? Report,
    [property: JsonPropertyName("error")] string? Error,
    [property: JsonPropertyName("upstreamTaskId")] string? UpstreamTaskId,
    [property: JsonPropertyName("createdAtUtc")] DateTimeOffset CreatedAtUtc,
    [property: JsonPropertyName("finishedAtUtc")] DateTimeOffset? FinishedAtUtc,
    [property: JsonPropertyName("expiresAtUtc")] DateTimeOffset ExpiresAtUtc,
    [property: JsonPropertyName("links")] AnalysisTaskLinksDto Links);

public sealed record AnalysisTaskLinksDto(
    [property: JsonPropertyName("self")] string Self,
    [property: JsonPropertyName("events")] string Events);

public sealed record AnalysisTaskListResponseDto(
    [property: JsonPropertyName("items")] IReadOnlyList<AnalysisTaskSnapshotDto> Items);
