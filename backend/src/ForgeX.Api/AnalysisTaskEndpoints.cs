using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using ForgeX.Analytics;
using ForgeX.Application;
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
    /// <summary>Node routes/analyze.js: readJson(req, 8 * 1024) and MAX_QUESTION = 500.</summary>
    private const long MaxCreateBodyBytes = 8L * 1024;
    private const int MaxQuestionLength = 500;
    private static readonly JsonSerializerOptions EventJsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Registers the analysis-task routes; shared by Program.cs and the ResourceGate so both wire the same handlers.</summary>
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/analysis-tasks", CreateAsync)
            .WithName("CreateAnalysisTask")
            .Accepts<AnalysisTaskCreateRequestDto>("application/json")
            .Produces<AnalysisTaskAcceptedDto>(StatusCodes.Status202Accepted)
            .Produces<ApiProblem>(StatusCodes.Status400BadRequest, "application/problem+json")
            .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
            .Produces<ApiProblem>(StatusCodes.Status404NotFound, "application/problem+json")
            .ExcludeFromDescription();

        app.MapGet("/api/v1/analysis-tasks", ListAsync)
            .WithName("ListAnalysisTasks")
            .Produces<AnalysisTaskListResponseDto>()
            .Produces<ApiProblem>(StatusCodes.Status400BadRequest, "application/problem+json")
            .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json");

        app.MapGet("/api/v1/analysis-tasks/{id}", GetAsync)
            .WithName("GetAnalysisTask")
            .Produces<AnalysisTaskSnapshotDto>()
            .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
            .Produces<ApiProblem>(StatusCodes.Status404NotFound, "application/problem+json");

        app.MapGet("/api/v1/analysis-tasks/{id}/events", EventsAsync)
            .WithName("StreamAnalysisTaskEvents")
            .Produces(StatusCodes.Status200OK, contentType: "text/event-stream")
            .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
            .Produces<ApiProblem>(StatusCodes.Status404NotFound, "application/problem+json");
    }

    /// <summary>
    /// Stage 8.6c-2b (rules-engine leg): create and start a task. Validation repeats Node's POST
    /// /api/analyze checks with the same messages; the dataset is resolved under the caller's
    /// tenant / owner (foreign or missing → 404, the C# convention); stale "running" rows of this
    /// owner are recovered first (Node's ready()); then the task is persisted as running and queued.
    /// </summary>
    public static async Task<IResult> CreateAsync(
        HttpContext context,
        PostgresAnalysisTaskRepository tasks,
        AnalysisTaskQueue queue,
        AnalysisTaskRuntime runtime,
        AnalysisTaskOptions options,
        AnalysisProviderSelection providers,
        AnalysisCostGate gate)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var body = await EndpointBodies.ReadJsonAsync<AnalysisTaskCreateRequestDto>(context, MaxCreateBodyBytes, "请求体过大");
        if (body.Problem is not null)
        {
            return body.Problem;
        }

        // Caller-supplied endpoint beats the process provider (Node: request-level > OPENAI_* > rules).
        var (override_, overrideError) = AiEndpoint.Parse(body.Value?.Ai?.BaseUrl, body.Value?.Ai?.ApiKey, body.Value?.Ai?.Model);
        if (overrideError is not null)
        {
            return ApiProblemResults.Create(context, 400, "invalid_ai_endpoint", overrideError);
        }

        var (accepted, error) = await TryCreateAsync(
            context,
            caller,
            body.Value?.Question ?? string.Empty,
            body.Value?.DatasourceId,
            override_,
            new AnalysisTaskCreationDeps(tasks, queue, runtime, options, providers, gate));
        return error is not null
            ? ApiProblemResults.Create(context, error.Status, error.Code, error.Title)
            : Results.Json(accepted, statusCode: StatusCodes.Status202Accepted);
    }

    /// <summary>Everything the creation core needs; the facade (Stage 8.6d) resolves these itself from the service provider.</summary>
    internal sealed record AnalysisTaskCreationDeps(
        PostgresAnalysisTaskRepository Tasks,
        AnalysisTaskQueue Queue,
        AnalysisTaskRuntime Runtime,
        AnalysisTaskOptions Options,
        AnalysisProviderSelection Providers,
        AnalysisCostGate Gate);

    /// <summary>A rejection the caller renders in its own dialect: problem+json internally, Node's {error} on the public facade.</summary>
    internal sealed record FacadeError(int Status, string Code, string Title);

    /// <summary>
    /// Shared creation core (Node routes/analyze.js after identity / rate limit): question checks with Node's
    /// messages, dataset resolved under the caller's tenant / owner, stale-running recovery, quota pre-check,
    /// running row persisted, work item queued. Returns either the 202 payload or a rejection.
    /// </summary>
    internal static async Task<(AnalysisTaskAcceptedDto? Accepted, FacadeError? Error)> TryCreateAsync(
        HttpContext context,
        ForgeXCallerContext caller,
        string rawQuestion,
        string? rawDatasourceId,
        AiEndpoint? override_,
        AnalysisTaskCreationDeps deps)
    {
        var (tasks, queue, runtime, options, providers, gate) = deps;
        var question = JsValue.Trim(rawQuestion);
        if (question.Length == 0)
        {
            return (null, new FacadeError(400, "question_required", "question 不能为空"));
        }
        if (question.Length > MaxQuestionLength)
        {
            return (null, new FacadeError(400, "question_too_long", "question 超过 " + MaxQuestionLength + " 字"));
        }

        var endpoint = override_ ?? providers.ProcessEndpoint;
        var providerId = endpoint is null ? AnalysisProviderSelection.RulesId : AnalysisProviderSelection.OpenAiId;

        var datasourceId = string.IsNullOrEmpty(rawDatasourceId) ? "sample" : rawDatasourceId!;
        var datasources = context.RequestServices.GetService<IDatasourceRepository>();
        var datasource = await DatasourceEndpoints.ResolveAsync(datasources, caller.TenantId, caller.OwnerId, datasourceId, context.RequestAborted);
        if (datasource is null)
        {
            return (null, new FacadeError(404, "datasource_not_found", "数据源不存在或已过期，请重新上传"));
        }

        var now = DateTimeOffset.UtcNow;
        await tasks.RecoverStaleAsync(
            caller.TenantId,
            caller.OwnerId,
            now - TimeSpan.FromMilliseconds(options.StaleRunningMs),
            runtime.LiveIds,
            context.RequestAborted);

        // Node routes/analyze.js: the quota pre-check tells the caller up front whether AI will be used —
        // the gate is consulted again (and consumed) when the task actually runs.
        var verdict = endpoint is null ? null : gate.Check(caller.OwnerId);

        var id = "t_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
        var record = new AnalysisTaskRecord(
            id,
            caller.TenantId,
            caller.OwnerId,
            question,
            datasource.Id,
            providerId,
            providerId,
            caller.TenantId,
            "running",
            0,
            "running",
            string.Empty,
            null,
            null,
            null,
            "[]",
            now,
            null,
            now + TimeSpan.FromMilliseconds(options.TtlMs),
            now);
        await tasks.UpsertAsync(record, context.RequestAborted);
        // Node: datasourceKey = ds.cacheKey || ds.contentSha256 || ds.id (the sample carries its digest as both).
        var datasourceKey = datasource.CacheKey.Length > 0 ? datasource.CacheKey
            : datasource.ContentSha256.Length > 0 ? datasource.ContentSha256 : datasource.Id;
        await queue.EnqueueAsync(
            new AnalysisTaskWorkItem(
                record,
                datasource.Rows.Clone(),
                datasource.Provenance.Clone(),
                datasourceKey,
                endpoint,
                providerId,
                override_?.CacheVariant ?? string.Empty),
            context.RequestAborted);

        var accepted = new AnalysisTaskAcceptedDto(
            id,
            providerId,
            WillUseAi: verdict is { Ok: true },
            Quota: verdict is null ? null : new AnalysisQuotaDto(verdict.Ok, verdict.Remaining, verdict.Reason),
            new AnalysisTaskLinksDto($"/api/v1/analysis-tasks/{id}", $"/api/v1/analysis-tasks/{id}/events"));
        return (accepted, null);
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
