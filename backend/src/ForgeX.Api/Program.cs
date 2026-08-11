using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Contracts;
using ForgeX.Infrastructure;
using ForgeX.Simulation;

const long MaxGCodeBytes = 64L * 1024 * 1024;

var builder = WebApplication.CreateBuilder(args);
var internalSharedSecret = builder.Configuration["InternalAuth:SharedSecret"] ?? string.Empty;
if (!string.IsNullOrEmpty(internalSharedSecret) && Encoding.UTF8.GetByteCount(internalSharedSecret) < 32)
{
    throw new InvalidOperationException("InternalAuth:SharedSecret must contain at least 32 UTF-8 bytes.");
}

builder.WebHost.ConfigureKestrel(options =>
{
    // The authoritative endpoint accepts a raw G-code body and never needs a larger request.
    options.Limits.MaxRequestBodySize = MaxGCodeBytes;
});

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
});
var allowedOrigins = builder.Configuration
    .GetSection("Cors:AllowedOrigins")
    .GetChildren()
    .Select(static value => value.Value)
    .Where(static value => !string.IsNullOrWhiteSpace(value))
    .Cast<string>()
    .ToArray();
if (allowedOrigins.Length > 0)
{
    builder.Services.AddCors(options => options.AddPolicy("ConfiguredFrontend", policy => policy
        .WithOrigins(allowedOrigins)
        .WithMethods("GET", "POST")
        .WithHeaders("Accept", "Content-Type", "Idempotency-Key", "Last-Event-ID")
        .WithExposedHeaders("Location", "X-Trace-Id", "X-Request-Id", "traceparent")));
}
builder.Services.AddSingleton<IGCodeAnalyzer, StreamingGCodeAnalyzer>();
var storageRoot = Path.GetFullPath(builder.Configuration["Storage:Root"] ?? "data/dotnet-preview", builder.Environment.ContentRootPath);
builder.Services.AddSingleton<IContentObjectStore>(_ => new ContentAddressedObjectStore(Path.Combine(storageRoot, "objects")));
builder.Services.AddSingleton<IGCodeJobRepository>(_ => new FileGCodeJobRepository(Path.Combine(storageRoot, "jobs")));
builder.Services.AddSingleton<IGCodeJobQueue>(_ => new GCodeJobQueue());
builder.Services.AddSingleton<GCodeJobRuntime>();
builder.Services.AddSingleton<GCodeJobWorker>();
builder.Services.AddHostedService(static services => services.GetRequiredService<GCodeJobWorker>());

var app = builder.Build();

app.Use(async (context, next) =>
{
    var activity = Activity.Current;
    var traceId = activity?.TraceId.ToHexString() ?? context.TraceIdentifier;
    var traceParent = activity?.Id;

    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Trace-Id"] = traceId;
        context.Response.Headers["X-Request-Id"] = context.TraceIdentifier;
        if (!string.IsNullOrWhiteSpace(traceParent))
        {
            context.Response.Headers.TraceParent = traceParent;
        }

        return Task.CompletedTask;
    });

    try
    {
        await next(context);
    }
    catch (Exception exception) when (!context.Response.HasStarted)
    {
        await ApiProblemResults.WriteExceptionAsync(context, exception);
    }
});

app.Use(async (context, next) =>
{
    if (!CallerContextBoundary.AppliesTo(context.Request.Path))
    {
        await next(context);
        return;
    }

    var problem = CallerContextBoundary.Resolve(context, internalSharedSecret);
    if (problem is not null)
    {
        await problem.ExecuteAsync(context);
        return;
    }

    await next(context);
});

if (allowedOrigins.Length > 0)
{
    app.UseCors("ConfiguredFrontend");
}

app.UseStatusCodePages(async statusCodeContext =>
{
    var context = statusCodeContext.HttpContext;
    var (code, title) = context.Response.StatusCode switch
    {
        StatusCodes.Status400BadRequest => ("invalid_request", "Invalid request"),
        StatusCodes.Status409Conflict => ("conflict", "Request conflicts with existing state"),
        StatusCodes.Status404NotFound => ("route_not_found", "Route not found"),
        StatusCodes.Status405MethodNotAllowed => ("method_not_allowed", "Method not allowed"),
        StatusCodes.Status413PayloadTooLarge => ("payload_too_large", "G-code payload is too large"),
        StatusCodes.Status415UnsupportedMediaType => ("unsupported_media_type", "Unsupported media type"),
        StatusCodes.Status422UnprocessableEntity => ("gcode_invalid", "G-code analysis failed"),
        StatusCodes.Status500InternalServerError => ("internal_error", "Unexpected server error"),
        _ => ("http_error", "HTTP request failed"),
    };
    await ApiProblemResults.Create(context, context.Response.StatusCode, code, title)
        .ExecuteAsync(context);
});

var serviceVersion = typeof(Program).Assembly.GetName().Version?.ToString() ?? "1.0.0";

app.MapGet("/health/live", () => Results.Ok(new HealthResponse(
        "healthy",
        "forgex-authoritative-api",
        serviceVersion,
        DateTimeOffset.UtcNow)))
    .WithName("GetLiveness")
    .Produces<HealthResponse>();

app.MapGet("/health/ready", async (IGCodeAnalyzer analyzer, IContentObjectStore objects, IGCodeJobQueue queue, GCodeJobWorker worker, CancellationToken ct) =>
    {
        var writable = await objects.ProbeWritableAsync(ct);
        var ready = writable && queue.IsAccepting && worker.Started;
        var response = new HealthResponse(
            ready ? "ready" : "not_ready",
            "forgex-authoritative-api",
            serviceVersion,
            DateTimeOffset.UtcNow,
            new Dictionary<string, string>
            {
                ["gcodeAnalyzer"] = analyzer.GetType().Name,
                ["objectStore"] = writable ? "writable" : "unavailable",
                ["jobQueue"] = queue.IsAccepting ? "accepting" : "closed",
                ["jobWorker"] = worker.Started ? "started" : "starting",
                ["callerContext"] = string.IsNullOrEmpty(internalSharedSecret) ? "local-development" : "trusted-node",
            });
        return Results.Json(response, statusCode: ready ? 200 : 503);
    })
    .WithName("GetReadiness")
    .Produces<HealthResponse>();

app.MapGet("/healthz", () => Results.Ok(new LegacyHealthResponse(
        true,
        "csharp-authoritative",
        "local",
        new LegacyCapabilities(false, true, true, true),
        "system",
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())))
    .WithName("GetLegacyHealth")
    .Produces<LegacyHealthResponse>();

app.MapGet("/openapi/v1.json", () => Results.Text(
        OpenApiDocument.Json,
        "application/json; charset=utf-8"))
    .WithName("GetOpenApiDocument")
    .ExcludeFromDescription();

app.MapPost("/api/v1/gcode/analyze", GCodeEndpoints.AnalyzeAsync)
    .WithName("AnalyzeGCode")
    .Accepts<Stream>("application/x-gcode")
    .Produces<GCodeAnalysisResponse>()
    .Produces<ApiProblem>(StatusCodes.Status400BadRequest, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status413PayloadTooLarge, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status415UnsupportedMediaType, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status422UnprocessableEntity, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status500InternalServerError, "application/problem+json");

app.MapPost("/api/v1/gcode/analyses", GCodeJobEndpoints.CreateAsync)
    .WithName("CreateGCodeAnalysisJob")
    .Accepts<Stream>("application/x-gcode")
    .Produces<GCodeJobAcceptedResponse>(StatusCodes.Status202Accepted)
    .Produces<ApiProblem>(StatusCodes.Status400BadRequest, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status409Conflict, "application/problem+json");

app.MapGet("/api/v1/jobs/{id}", GCodeJobEndpoints.GetAsync)
    .WithName("GetGCodeAnalysisJob")
    .Produces<GCodeJobSnapshotResponse>()
    .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status404NotFound, "application/problem+json");

app.MapGet("/api/v1/jobs/{id}/events", GCodeJobEndpoints.EventsAsync)
    .WithName("StreamGCodeAnalysisJobEvents")
    .Produces(StatusCodes.Status200OK, contentType: "text/event-stream")
    .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status404NotFound, "application/problem+json");

app.MapPost("/api/v1/jobs/{id}/cancel", GCodeJobEndpoints.CancelAsync)
    .WithName("CancelGCodeAnalysisJob")
    .Produces<GCodeJobSnapshotResponse>()
    .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status404NotFound, "application/problem+json");

app.Run();
