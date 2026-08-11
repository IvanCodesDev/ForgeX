using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ForgeX.Application;
using ForgeX.Contracts;
using ForgeX.Domain;
using Microsoft.AspNetCore.Http.Features;

namespace ForgeX.Api;

internal static class GCodeJobEndpoints
{
    private const string SchemaVersion = "1.0";
    private static readonly JsonSerializerOptions EventJsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task<IResult> CreateAsync(
        HttpContext context,
        IContentObjectStore objects,
        IGCodeJobRepository repository,
        IGCodeJobQueue queue)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var mediaType = context.Request.ContentType?.Split(';', 2)[0].Trim();
        if (!string.Equals(mediaType, "application/x-gcode", StringComparison.OrdinalIgnoreCase))
        {
            return ApiProblemResults.Create(context, 415, "unsupported_media_type", "Unsupported media type", "Use Content-Type: application/x-gcode.");
        }

        if (context.Request.ContentLength is > GCodeEndpoints.MaxGCodeBytes)
        {
            return ApiProblemResults.Create(context, 413, "payload_too_large", "G-code payload is too large");
        }

        var bodyFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (bodyFeature is { IsReadOnly: false }) bodyFeature.MaxRequestBodySize = GCodeEndpoints.MaxGCodeBytes;

        if (!GCodeEndpoints.TryReadOptions(context.Request, out var options, out var errors))
        {
            return ApiProblemResults.Create(context, 400, "invalid_parameters", "Invalid analysis parameters", null, errors);
        }

        var idempotencyKey = context.Request.Headers["Idempotency-Key"].ToString();
        if (!IsValidIdempotencyKey(idempotencyKey))
        {
            return ApiProblemResults.Create(context, 400, "invalid_idempotency_key", "Invalid Idempotency-Key", "Use 1-128 ASCII letters, digits, '.', '_', ':', or '-'.");
        }

        StoredContentObject stored;
        try
        {
            stored = await objects.PutAsync(context.Request.Body, GCodeEndpoints.MaxGCodeBytes, context.RequestAborted);
        }
        catch (InvalidDataException exception) when (exception.Message == "GCODE_TOO_LARGE")
        {
            return ApiProblemResults.Create(context, 413, "payload_too_large", "G-code payload is too large");
        }

        var fingerprint = Fingerprint(stored.Sha256, options);
        var createdAt = DateTimeOffset.UtcNow;
        var initialEvent = new GCodeJobEvent(1, "progress", createdAt, GCodeJobStatus.Queued, 0, "queued");
        var candidate = new GCodeJobRecord(
            Guid.NewGuid().ToString("N"),
            string.IsNullOrEmpty(idempotencyKey) ? null : idempotencyKey,
            fingerprint,
            stored.Sha256,
            stored.Bytes,
            options,
            GCodeJobStatus.Queued,
            0,
            "queued",
            createdAt,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            [initialEvent],
            caller.TenantId,
            caller.OwnerId);
        var result = await repository.CreateOrGetAsync(candidate, context.RequestAborted);
        if (result.Conflict)
        {
            return ApiProblemResults.Create(context, 409, "idempotency_conflict", "Idempotency-Key is already bound to different input or parameters");
        }

        if (result.Created)
        {
            await queue.EnqueueAsync(result.Job.Id, context.RequestAborted);
        }

        var links = Links(result.Job.Id);
        context.Response.Headers.Location = links.Status;
        return Results.Json(
            new GCodeJobAcceptedResponse(
                SchemaVersion,
                result.Job.Id,
                Status(result.Job.Status),
                new GCodeInputSummaryDto(result.Job.InputSha256, result.Job.InputBytes, 0),
                links),
            statusCode: StatusCodes.Status202Accepted);
    }

    public static async Task<IResult> GetAsync(HttpContext context, string id, IGCodeJobRepository repository)
    {
        var job = await FindAsync(context, id, repository);
        return job is null ? NotFound(context) : Results.Ok(ToSnapshot(job));
    }

    public static async Task<IResult> CancelAsync(
        HttpContext context,
        string id,
        IGCodeJobRepository repository,
        GCodeJobRuntime runtime)
    {
        var job = await FindAsync(context, id, repository);
        if (job is null) return NotFound(context);
        if (IsTerminal(job.Status)) return Results.Ok(ToSnapshot(job));

        runtime.Cancel(id);
        var now = DateTimeOffset.UtcNow;
        job = Append(job with
        {
            Status = GCodeJobStatus.Cancelled,
            Phase = "cancelled",
            FinishedAtUtc = now,
            ErrorCode = "gcode_cancelled",
            ErrorMessage = "The analysis job was cancelled.",
        }, "terminal", now);
        await repository.SaveAsync(job, CancellationToken.None);
        return Results.Ok(ToSnapshot(job));
    }

    public static async Task EventsAsync(HttpContext context, string id, IGCodeJobRepository repository)
    {
        var job = await FindAsync(context, id, repository);
        if (job is null)
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
            var caller = CallerContextBoundary.GetRequired(context);
            job = await repository.GetOwnedAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted);
            if (job is null) return;
            foreach (var item in job.Events.Where(item => item.Sequence > lastSequence))
            {
                var payload = new GCodeJobEventDto(item.Sequence, item.Type, item.AtUtc, Status(item.Status), item.Progress, item.Phase, item.ErrorCode);
                await WriteEventAsync(context.Response, item.Sequence, item.Type, payload, context.RequestAborted);
                lastSequence = item.Sequence;
            }

            if (IsTerminal(job.Status) && lastSequence >= job.Events[^1].Sequence) return;
            if (DateTimeOffset.UtcNow >= heartbeatAt)
            {
                await context.Response.WriteAsync(": heartbeat\n\n", context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted);
                heartbeatAt = DateTimeOffset.UtcNow.AddSeconds(10);
            }

            await Task.Delay(200, context.RequestAborted);
        }
    }

    internal static GCodeJobRecord Append(GCodeJobRecord job, string type, DateTimeOffset atUtc)
    {
        var sequence = job.Events.Count == 0 ? 1 : job.Events[^1].Sequence + 1;
        var events = job.Events.Concat([new GCodeJobEvent(
            sequence,
            type,
            atUtc,
            job.Status,
            job.Progress,
            job.Phase,
            job.ErrorCode)]).ToArray();
        return job with { Events = events };
    }

    internal static GCodeJobSnapshotResponse ToSnapshot(GCodeJobRecord job) => new(
        SchemaVersion,
        job.Id,
        "gcode-analysis",
        Status(job.Status),
        job.Progress,
        job.Phase,
        job.Events.Count == 0 ? 0 : job.Events[^1].Sequence,
        job.CreatedAtUtc,
        job.StartedAtUtc,
        job.FinishedAtUtc,
        new GCodeInputSummaryDto(job.InputSha256, job.InputBytes, job.Result?.LinesRead ?? 0),
        job.EngineVersion,
        job.Result is null ? null : GCodeEndpoints.ToResponse(job.Result, job.Options),
        job.ErrorCode is null ? null : new GCodeJobErrorDto(job.ErrorCode, job.ErrorMessage ?? job.ErrorCode, job.TraceId),
        Links(job.Id));

    private static async Task<GCodeJobRecord?> FindAsync(HttpContext context, string id, IGCodeJobRepository repository)
    {
        if (id.Length != 32 || id.Any(static character => !char.IsAsciiHexDigit(character))) return null;
        var caller = CallerContextBoundary.GetRequired(context);
        return await repository.GetOwnedAsync(caller.TenantId, caller.OwnerId, id.ToLowerInvariant(), context.RequestAborted);
    }

    private static IResult NotFound(HttpContext context) =>
        ApiProblemResults.Create(context, 404, "job_not_found", "Analysis job not found");

    private static GCodeJobLinksDto Links(string id) => new(
        $"/api/v1/jobs/{id}",
        $"/api/v1/jobs/{id}/events",
        $"/api/v1/jobs/{id}/cancel");

    private static bool IsValidIdempotencyKey(string value) =>
        string.IsNullOrEmpty(value) || (value.Length <= 128 && value.All(static character =>
            char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or ':' or '-'));

    private static string Fingerprint(string sha256, GCodeAnalysisOptions options)
    {
        var canonical = FormattableString.Invariant($"{sha256}|{options.BedSizeMm:R}|{options.CoordinateOrigin}|{options.MaterialDensityGPerCm3:R}");
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }

    private static long ParseLastEventId(string value) =>
        string.IsNullOrWhiteSpace(value) ? 0 :
        long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed >= 0 ? parsed : -1;

    private static string Status(GCodeJobStatus status) => status.ToString().ToLowerInvariant();
    private static bool IsTerminal(GCodeJobStatus status) => status is GCodeJobStatus.Succeeded or GCodeJobStatus.Degraded or GCodeJobStatus.Failed or GCodeJobStatus.Cancelled;

    private static async Task WriteEventAsync(HttpResponse response, long sequence, string eventType, object payload, CancellationToken cancellationToken)
    {
        await response.WriteAsync($"id: {sequence}\nevent: {eventType}\ndata: {JsonSerializer.Serialize(payload, EventJsonOptions)}\n\n", cancellationToken);
        await response.Body.FlushAsync(cancellationToken);
    }
}
