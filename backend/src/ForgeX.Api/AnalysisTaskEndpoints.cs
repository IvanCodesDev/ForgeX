using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using ForgeX.Analytics;
using ForgeX.Contracts;
using ForgeX.Infrastructure;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.1: read side of Node analysis tasks served by C# (history and SSE
/// streaming in the same wire format as the G-code jobs event model — id/event/data
/// frames, Last-Event-ID resume, heartbeat comments, close on terminal status).
/// Stage 8.3: the rules-leg compute moves here too. POST creates the task, runs the
/// deterministic ForgeX.Analytics report engine, and upserts one snapshot per
/// progress event into forgex.node_analysis_tasks exactly like the Node store, so
/// the existing read/SSE endpoints and the Node gateway serve C#-computed tasks
/// without any wire change. AI narration legs stay on the Node providers.
/// </summary>
internal static class AnalysisTaskEndpoints
{
    private const int DefaultLimit = 50;
    private const int MaxLimit = 200;
    private const int MaxDatasourceIdLength = 128;
    private const string RulesEngineId = "server-rules";
    private static readonly JsonSerializerOptions EventJsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task<IResult> CreateAsync(
        HttpContext context,
        PostgresAnalysisTaskRepository tasks,
        AnalysisTaskAuthorityOptions options)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var mediaType = context.Request.ContentType?.Split(';', 2)[0].Trim();
        if (!string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase))
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status415UnsupportedMediaType,
                "unsupported_media_type",
                "Unsupported media type",
                "Use Content-Type: application/json.");
        }

        if (context.Request.ContentLength is > AnalyticsEndpoints.MaxRequestBytes)
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status413PayloadTooLarge,
                "analysis_task_payload_too_large",
                "Analysis task payload is too large",
                $"The request body limit is {AnalyticsEndpoints.MaxRequestBytes} bytes.");
        }

        var maxBodySizeFeature = context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
        if (maxBodySizeFeature is { IsReadOnly: false })
        {
            maxBodySizeFeature.MaxRequestBodySize = AnalyticsEndpoints.MaxRequestBytes;
        }

        AnalysisTaskCreateRequestDto? request;
        try
        {
            request = await context.Request.ReadFromJsonAsync<AnalysisTaskCreateRequestDto>(
                cancellationToken: context.RequestAborted);
        }
        catch (JsonException exception)
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status400BadRequest,
                "invalid_analysis_task_json",
                "Analysis task request JSON is invalid",
                exception.Message);
        }
        catch (BadHttpRequestException exception)
        {
            return ApiProblemResults.Create(
                context,
                exception.StatusCode,
                exception.StatusCode == StatusCodes.Status413PayloadTooLarge
                    ? "analysis_task_payload_too_large"
                    : "invalid_analysis_task_request",
                exception.StatusCode == StatusCodes.Status413PayloadTooLarge
                    ? "Analysis task payload is too large"
                    : "Analysis task request is invalid",
                exception.Message);
        }

        // Rows/question/provenance ride the exact analytics-report contract.
        var analyticsShape = request is null
            ? null
            : new AnalyticsReportRequestDto(request.SchemaVersion, request.Question, request.Rows, request.Provenance);
        if (!AnalyticsEndpoints.TryValidate(analyticsShape, out var question, out var rows, out var provenance, out var errors))
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status400BadRequest,
                "invalid_analysis_task_request",
                "Analysis task request is invalid",
                errors.Values.SelectMany(static messages => messages).FirstOrDefault(),
                errors);
        }

        var datasourceId = request!.DatasourceId ?? string.Empty;
        if (datasourceId.Length is < 1 or > MaxDatasourceIdLength)
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status400BadRequest,
                "invalid_datasource_id",
                $"datasourceId must contain 1 to {MaxDatasourceIdLength} characters");
        }

        // Same id shape as the Node TaskStore: "t_" + 16 lowercase hex characters.
        var id = "t_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
        var run = new TaskRun(caller.TenantId, caller.OwnerId, id, question, datasourceId, options.TaskTtl);

        // One upsert per state change, mirroring the Node store write cadence:
        // initial running snapshot, one per progress event, then the terminal event.
        await tasks.UpsertAsync(run.Snapshot(), context.RequestAborted);
        run.Emit("authority", "C# Analytics 权威规则引擎计算中", 0.25);
        await tasks.UpsertAsync(run.Snapshot(), context.RequestAborted);

        try
        {
            var report = AnalyticsReportEngine.AnalyzeMigratedIntent(question, rows, provenance);
            run.Emit("complete", "C# Analytics 权威结果已生成", 1);
            await tasks.UpsertAsync(run.Snapshot(), context.RequestAborted);
            run.Finish(ComposeReportJson(report, id));
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            run.Fail(exception.Message is { Length: > 0 } message ? message : "分析失败");
        }

        await tasks.UpsertAsync(run.Snapshot(), context.RequestAborted);
        var record = await tasks.GetAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted);
        if (record is null)
        {
            return ApiProblemResults.Create(context, 500, "analysis_task_persist_failed", "Analysis task snapshot was not persisted");
        }

        using var events = JsonDocument.Parse(record.EventsJson);
        return Results.Json(
            new AnalysisTaskCreateResponseDto(ToSnapshot(record), events.RootElement.Clone()),
            statusCode: StatusCodes.Status201Created);
    }

    /// <summary>
    /// Mirrors the report a rules-leg task carries when Node routes through the C#
    /// analytics authority (csharpAnalyticsProvider + TaskStore._run): the engine
    /// DTO plus engine/authorityEngine/statsBy overrides and taskId/cached fields.
    /// </summary>
    private static string ComposeReportJson(AnalyticsReport report, string taskId)
    {
        var node = JsonSerializer.SerializeToNode(report, AnalyticsEndpoints.ResponseJsonOptions)!.AsObject();
        node["engine"] = RulesEngineId;
        node["authorityEngine"] = new JsonObject
        {
            ["name"] = "forgex-analytics-csharp",
            ["version"] = AnalyticsEndpoints.EngineVersion,
        };
        node["statsBy"] = "csharp-analytics-authority";
        node["taskId"] = taskId;
        node["cached"] = false;
        return node.ToJsonString(AnalyticsEndpoints.ResponseJsonOptions);
    }

    /// <summary>
    /// In-flight task state translated to AnalysisTaskRecord snapshots with the same
    /// event and snapshot field semantics as the Node TaskStore (emit/_snapshot/_finish/_fail).
    /// </summary>
    private sealed class TaskRun
    {
        private readonly string _tenantId;
        private readonly string _ownerId;
        private readonly string _id;
        private readonly string _question;
        private readonly string _datasourceId;
        private readonly DateTimeOffset _createdAt = DateTimeOffset.UtcNow;
        private readonly TimeSpan _ttl;
        private readonly JsonArray _events = [];
        private long _sequence;
        private string _status = "running";
        private double _progress;
        private string _phase = "running";
        private string _message = string.Empty;
        private string? _reportJson;
        private string? _error;
        private DateTimeOffset? _finishedAt;

        public TaskRun(string tenantId, string ownerId, string id, string question, string datasourceId, TimeSpan ttl)
        {
            _tenantId = tenantId;
            _ownerId = ownerId;
            _id = id;
            _question = question;
            _datasourceId = datasourceId;
            _ttl = ttl;
        }

        public void Emit(string stage, string message, double progress)
        {
            _events.Add(new JsonObject
            {
                ["seq"] = ++_sequence,
                ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["stage"] = stage,
                ["message"] = message,
                ["progress"] = progress,
            });
            _phase = stage.Length > 64 ? stage[..64] : stage;
            _message = message;
            _progress = Math.Clamp(progress, 0, 1);
        }

        public void Finish(string reportJson)
        {
            _reportJson = reportJson;
            _status = "done";
            _finishedAt = DateTimeOffset.UtcNow;
            _events.Add(new JsonObject
            {
                ["seq"] = ++_sequence,
                ["ts"] = _finishedAt.Value.ToUnixTimeMilliseconds(),
                ["done"] = true,
                ["progress"] = 1,
                ["message"] = "分析完成",
            });
            _phase = "done";
            _message = "分析完成";
            _progress = 1;
        }

        public void Fail(string error)
        {
            _status = "failed";
            _error = error;
            _finishedAt = DateTimeOffset.UtcNow;
            _events.Add(new JsonObject
            {
                ["seq"] = ++_sequence,
                ["ts"] = _finishedAt.Value.ToUnixTimeMilliseconds(),
                ["done"] = true,
                ["error"] = error,
                ["message"] = "分析失败：" + error,
            });
            // Node's _snapshot quirk kept for parity: the failure event carries no
            // stage/progress, so phase stays "running" and progress falls back to 0.
            _phase = "running";
            _message = "分析失败：" + error;
            _progress = 0;
        }

        public AnalysisTaskRecord Snapshot() => new(
            _id,
            _tenantId,
            _ownerId,
            _question,
            _datasourceId,
            RulesEngineId,
            RulesEngineId,
            _tenantId,
            _status,
            _progress,
            _phase,
            _message,
            _reportJson,
            _error,
            null,
            _events.ToJsonString(EventJsonOptions),
            _createdAt,
            _finishedAt,
            _createdAt + _ttl,
            DateTimeOffset.UtcNow);
    }

    public static async Task<IResult> ListAsync(HttpContext context, PostgresAnalysisTaskRepository tasks)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var rawLimit = context.Request.Query["limit"].ToString();
        var limit = DefaultLimit;
        if (!string.IsNullOrEmpty(rawLimit) &&
            (!int.TryParse(rawLimit, NumberStyles.None, CultureInfo.InvariantCulture, out limit) ||
             limit < 1 || limit > MaxLimit))
        {
            return ApiProblemResults.Create(context, 400, "invalid_limit", $"limit must be between 1 and {MaxLimit}");
        }

        var records = await tasks.ListAsync(caller.TenantId, caller.OwnerId, limit, context.RequestAborted);
        return Results.Json(new AnalysisTaskListResponseDto(records.Select(ToSnapshot).ToArray()));
    }

    public static async Task<IResult> GetAsync(HttpContext context, string id, PostgresAnalysisTaskRepository tasks)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        if (!IsValidTaskId(id))
        {
            return NotFound(context);
        }

        var record = await tasks.GetAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted);
        return record is null ? NotFound(context) : Results.Json(ToSnapshot(record));
    }

    public static async Task EventsAsync(HttpContext context, string id, PostgresAnalysisTaskRepository tasks)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        if (!IsValidTaskId(id))
        {
            await NotFound(context).ExecuteAsync(context);
            return;
        }

        var record = await tasks.GetAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted);
        if (record is null)
        {
            await NotFound(context).ExecuteAsync(context);
            return;
        }

        var lastSequence = ParseLastEventId(context.Request.Headers["Last-Event-ID"].ToString());
        if (lastSequence < 0)
        {
            await ApiProblemResults.Create(context, 400, "invalid_last_event_id", "Last-Event-ID must be a non-negative integer").ExecuteAsync(context);
            return;
        }

        context.Response.StatusCode = 200;
        context.Response.ContentType = "text/event-stream; charset=utf-8";
        context.Response.Headers.CacheControl = "no-cache, no-store";
        context.Response.Headers["X-Accel-Buffering"] = "no";
        var heartbeatAt = DateTimeOffset.UtcNow.AddSeconds(10);

        while (!context.RequestAborted.IsCancellationRequested)
        {
            record = await tasks.GetAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted);
            if (record is null) return;

            var latest = lastSequence;
            using (var events = JsonDocument.Parse(record.EventsJson))
            {
                foreach (var item in events.RootElement.EnumerateArray())
                {
                    var sequence = item.TryGetProperty("seq", out var seq) && seq.ValueKind == JsonValueKind.Number
                        ? seq.GetInt64()
                        : 0;
                    if (sequence <= latest) continue;
                    var eventType = item.TryGetProperty("stage", out var stage) && stage.ValueKind == JsonValueKind.String
                        ? "progress"
                        : "message";
                    await WriteEventAsync(context.Response, sequence, eventType, item, context.RequestAborted);
                    latest = sequence;
                }
            }
            lastSequence = latest;

            if (record.Status is "done" or "failed")
            {
                // Terminal snapshot as the closing frame, mirroring the jobs stream shape.
                await WriteEventAsync(context.Response, lastSequence + 1, "done", ToSnapshot(record), context.RequestAborted);
                return;
            }

            if (DateTimeOffset.UtcNow >= heartbeatAt)
            {
                await context.Response.WriteAsync(": heartbeat\n\n", context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted);
                heartbeatAt = DateTimeOffset.UtcNow.AddSeconds(10);
            }

            await Task.Delay(500, context.RequestAborted);
        }
    }

    private static AnalysisTaskSnapshotDto ToSnapshot(AnalysisTaskRecord record)
    {
        JsonElement? report = null;
        if (record.ReportJson is { Length: > 0 } json && json != "null")
        {
            report = JsonSerializer.Deserialize<JsonElement>(json);
        }

        long lastSequence = 0;
        using (var events = JsonDocument.Parse(record.EventsJson))
        {
            foreach (var item in events.RootElement.EnumerateArray())
            {
                if (item.TryGetProperty("seq", out var seq) && seq.ValueKind == JsonValueKind.Number)
                {
                    lastSequence = Math.Max(lastSequence, seq.GetInt64());
                }
            }
        }

        return new AnalysisTaskSnapshotDto(
            record.Id,
            record.Question,
            record.DatasourceId,
            record.Engine,
            record.Provider,
            record.Status,
            record.Progress,
            record.Phase,
            record.Message,
            lastSequence,
            report,
            record.ErrorMessage,
            record.UpstreamTaskId,
            record.CreatedAt,
            record.FinishedAt,
            record.ExpiresAt,
            new AnalysisTaskLinksDto(
                $"/api/v1/analysis-tasks/{record.Id}",
                $"/api/v1/analysis-tasks/{record.Id}/events"));
    }

    private static IResult NotFound(HttpContext context) =>
        ApiProblemResults.Create(context, 404, "analysis_task_not_found", "Analysis task not found");

    /// <summary>Schema constraint: id varchar(64) matching ^[A-Za-z0-9_]+$.</summary>
    private static bool IsValidTaskId(string id) =>
        id.Length is > 0 and <= 64 &&
        id.All(static character => char.IsAsciiLetterOrDigit(character) || character == '_');

    private static long ParseLastEventId(string value) =>
        string.IsNullOrWhiteSpace(value) ? 0 :
        long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed >= 0 ? parsed : -1;

    private static async Task WriteEventAsync(HttpResponse response, long sequence, string eventType, object payload, CancellationToken cancellationToken)
    {
        await response.WriteAsync(
            $"id: {sequence}\nevent: {eventType}\ndata: {JsonSerializer.Serialize(payload, EventJsonOptions)}\n\n",
            cancellationToken);
        await response.Body.FlushAsync(cancellationToken);
    }
}

/// <summary>Stage 8.3 execution settings: task TTL matching the Node TASK_TTL_MS default.</summary>
internal sealed record AnalysisTaskAuthorityOptions(TimeSpan TaskTtl);
