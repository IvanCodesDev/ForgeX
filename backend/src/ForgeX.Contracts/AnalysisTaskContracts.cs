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

/// <summary>
/// Stage 8.6c-2b: create an analysis task on the C# authority (rules-engine leg). The Node
/// facade has already validated identity and question; C# validates again because it is the
/// authority, then executes the task in-process and persists the same snapshots Node did.
/// </summary>
public sealed record AnalysisTaskCreateRequestDto(
    [property: JsonPropertyName("question")] string? Question,
    [property: JsonPropertyName("datasourceId")] string? DatasourceId,
    [property: JsonPropertyName("ai")] AnalysisAiOverrideDto? Ai = null);

/// <summary>
/// Stage 8.6c-2b-ii: a caller-supplied OpenAI-compatible endpoint for this task only (Node
/// aiBaseUrl / aiApiKey / aiModel). The key lives in the request and the in-memory work item —
/// never in the persisted snapshot, a log line or any response.
/// </summary>
public sealed record AnalysisAiOverrideDto(
    [property: JsonPropertyName("baseUrl")] string? BaseUrl,
    [property: JsonPropertyName("apiKey")] string? ApiKey,
    [property: JsonPropertyName("model")] string? Model);

/// <summary>Node gate.check verdict as returned in the 202 (remaining null = unlimited).</summary>
public sealed record AnalysisQuotaDto(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("remaining")] long? Remaining,
    [property: JsonPropertyName("reason")] string? Reason);

/// <summary>
/// 202 body for a created task. Field names follow Node's POST /api/analyze response so the
/// facade only renames <c>id</c> → <c>taskId</c> and adds its own <c>authenticated</c> flag.
/// </summary>
public sealed record AnalysisTaskAcceptedDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("engine")] string Engine,
    [property: JsonPropertyName("willUseAi")] bool WillUseAi,
    [property: JsonPropertyName("quota")] AnalysisQuotaDto? Quota,
    [property: JsonPropertyName("links")] AnalysisTaskLinksDto Links);
