using System.Globalization;
using System.Text.Json;
using ForgeX.Contracts;
using ForgeX.Infrastructure;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.1: read side of Node analysis tasks served by C#. The Node runtime still
/// executes the analysis and upserts a snapshot per progress event into
/// forgex.node_analysis_tasks; these endpoints give history reads and SSE streaming
/// in the same wire format as the G-code jobs event model (id/event/data frames,
/// Last-Event-ID resume, heartbeat comments, close on terminal status).
/// </summary>
internal static class AnalysisTaskEndpoints
{
    private const int DefaultLimit = 50;
    private const int MaxLimit = 200;
    private static readonly JsonSerializerOptions EventJsonOptions = new(JsonSerializerDefaults.Web);

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
