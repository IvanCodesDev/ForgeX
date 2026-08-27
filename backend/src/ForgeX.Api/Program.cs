using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Contracts;
using ForgeX.Infrastructure;
using ForgeX.Simulation;
using Microsoft.Extensions.Logging.Console;

const long MaxGCodeBytes = 64L * 1024 * 1024;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options =>
{
    options.IncludeScopes = true;
    options.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ";
    options.UseUtcTimestamp = true;
});
var internalSharedSecret = builder.Configuration["InternalAuth:SharedSecret"] ?? string.Empty;
var previousInternalSharedSecret = builder.Configuration["InternalAuth:PreviousSharedSecret"] ?? string.Empty;
var persistenceProvider = builder.Configuration["Persistence:Provider"] ?? "file";
if (!string.IsNullOrEmpty(internalSharedSecret) && Encoding.UTF8.GetByteCount(internalSharedSecret) < 32)
{
    throw new InvalidOperationException("InternalAuth:SharedSecret must contain at least 32 UTF-8 bytes.");
}
if (!string.IsNullOrEmpty(previousInternalSharedSecret) && Encoding.UTF8.GetByteCount(previousInternalSharedSecret) < 32)
{
    throw new InvalidOperationException("InternalAuth:PreviousSharedSecret must contain at least 32 UTF-8 bytes.");
}
if (!string.IsNullOrEmpty(internalSharedSecret) &&
    string.Equals(internalSharedSecret, previousInternalSharedSecret, StringComparison.Ordinal))
{
    throw new InvalidOperationException("InternalAuth current and previous secrets must be different.");
}
if (!string.Equals(persistenceProvider, "file", StringComparison.OrdinalIgnoreCase))
{
    throw new InvalidOperationException(
        "Persistence:Provider currently supports only 'file'. The versioned PostgreSQL schema is staged but its runtime driver is not active.");
}

// ── Stage 8.1：shares 迁 C#（V2.0 手册 §4.2 第 1 项）────────────────────────
// 默认 disabled：不配置时不注册端点，行为与 1.0.0 完全一致；
// 配置 postgres 后复用 Node 侧同一张 forgex.shares 表与 RLS 策略。
var sharesProvider = (builder.Configuration["Shares:Provider"] ?? "disabled").Trim().ToLowerInvariant();
var sharesPostgresUrl = builder.Configuration["Shares:PostgresUrl"]
    ?? Environment.GetEnvironmentVariable("POSTGRES_URL")
    ?? string.Empty;
if (sharesProvider is not ("disabled" or "postgres"))
{
    throw new InvalidOperationException("Shares:Provider must be 'disabled' or 'postgres'.");
}
if (sharesProvider == "postgres" && string.IsNullOrWhiteSpace(sharesPostgresUrl))
{
    throw new InvalidOperationException("Shares:PostgresUrl (or POSTGRES_URL) is required when Shares:Provider=postgres.");
}
var sharesEnabled = sharesProvider == "postgres";
if (sharesEnabled)
{
    var shareTtlMs = ReadInt(builder.Configuration, "Shares:TtlMs", 24 * 60 * 60 * 1000);
    if (shareTtlMs < 1)
    {
        throw new InvalidOperationException("Shares:TtlMs must be positive.");
    }
    var shareMaxPerOwner = ReadInt(builder.Configuration, "Shares:MaxPerOwner", PostgresShareRepository.DefaultMaxSharesPerOwner);
    builder.Services.AddSingleton(new SharePublicBase(builder.Configuration["Shares:PublicBase"]?.TrimEnd('/') ?? string.Empty));
    builder.Services.AddSingleton(_ => new PostgresShareRepository(
        sharesPostgresUrl,
        TimeSpan.FromMilliseconds(shareTtlMs),
        shareMaxPerOwner));
}

// ── Stage 8.1：Node 分析任务历史读取 + SSE 汇入 jobs 事件模型 ────────────────
// Node 仍执行分析并逐事件 UPSERT 快照；C# 从同一张表提供历史与事件流。
var analysisTasksProvider = (builder.Configuration["AnalysisTasks:Provider"] ?? "disabled").Trim().ToLowerInvariant();
var analysisTasksPostgresUrl = builder.Configuration["AnalysisTasks:PostgresUrl"]
    ?? Environment.GetEnvironmentVariable("POSTGRES_URL")
    ?? string.Empty;
if (analysisTasksProvider is not ("disabled" or "postgres"))
{
    throw new InvalidOperationException("AnalysisTasks:Provider must be 'disabled' or 'postgres'.");
}
if (analysisTasksProvider == "postgres" && string.IsNullOrWhiteSpace(analysisTasksPostgresUrl))
{
    throw new InvalidOperationException("AnalysisTasks:PostgresUrl (or POSTGRES_URL) is required when AnalysisTasks:Provider=postgres.");
}
var analysisTasksEnabled = analysisTasksProvider == "postgres";
if (analysisTasksEnabled)
{
    builder.Services.AddSingleton(_ => new PostgresAnalysisTaskRepository(analysisTasksPostgresUrl));
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
var queueCapacity = ReadInt(builder.Configuration, "GCodeJobs:QueueCapacity", 64);
if (queueCapacity is < 1 or > 4096)
{
    throw new InvalidOperationException("GCodeJobs:QueueCapacity must be between 1 and 4096.");
}
var retryOptions = new GCodeJobRetryOptions(
    ReadInt(builder.Configuration, "GCodeJobs:Retry:MaxAttempts", 3),
    ReadInt(builder.Configuration, "GCodeJobs:Retry:BaseDelayMilliseconds", 250),
    ReadInt(builder.Configuration, "GCodeJobs:Retry:MaxDelayMilliseconds", 10_000)).Validate();
builder.Services.AddSingleton(retryOptions);
var admissionOptions = new GCodeJobAdmissionOptions(
    ReadInt(builder.Configuration, "GCodeJobs:Admission:MaxActivePerOwner", 4),
    ReadInt(builder.Configuration, "GCodeJobs:Admission:MaxActivePerTenant", 16)).Validate();
builder.Services.AddSingleton(admissionOptions);
var storageRoot = Path.GetFullPath(builder.Configuration["Storage:Root"] ?? "data/dotnet-preview", builder.Environment.ContentRootPath);
builder.Services.AddSingleton<IContentObjectStore>(_ => new ContentAddressedObjectStore(Path.Combine(storageRoot, "objects")));
builder.Services.AddSingleton(_ => new FileGCodeJobRepository(Path.Combine(storageRoot, "jobs")));
builder.Services.AddSingleton<IGCodeJobRepository>(static services => services.GetRequiredService<FileGCodeJobRepository>());
builder.Services.AddSingleton<IGCodeJobRepositoryMaintenance>(static services => services.GetRequiredService<FileGCodeJobRepository>());
builder.Services.AddSingleton<IGCodeJobQueue>(_ => new GCodeJobQueue(queueCapacity));
builder.Services.AddSingleton<GCodeJobRuntime>();
builder.Services.AddSingleton<ForgeXMetrics>();
builder.Services.AddSingleton<GCodeJobWorker>();
builder.Services.AddHostedService(static services => services.GetRequiredService<GCodeJobWorker>());

var app = builder.Build();
var metrics = app.Services.GetRequiredService<ForgeXMetrics>();
var requestLogger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("ForgeX.Api.Request");

app.Use(async (context, next) =>
{
    var started = Stopwatch.GetTimestamp();
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
    finally
    {
        var elapsed = Stopwatch.GetElapsedTime(started);
        metrics.ObserveHttp(context.Request.Method, context.Request.Path, context.Response.StatusCode, elapsed);
        if (requestLogger.IsEnabled(LogLevel.Information))
        {
            requestLogger.LogInformation(
                "HTTP request completed {Method} {Path} with {StatusCode} in {ElapsedMilliseconds} ms; traceId={TraceId}",
                context.Request.Method,
                ForgeXMetrics.RouteLabel(context.Request.Path),
                context.Response.StatusCode,
                elapsed.TotalMilliseconds,
                traceId);
        }
    }
});

// Stage 8.2：直连身份（API key / 匿名 IP）与可信 Node 代理并行受理；
// 未配置 DirectAuth:ApiKeys 时行为与迁移前完全一致。
var directAuth = DirectAuthOptions.FromConfiguration(builder.Configuration);

app.Use(async (context, next) =>
{
    if (!CallerContextBoundary.AppliesTo(context.Request.Path))
    {
        await next(context);
        return;
    }

    var problem = CallerContextBoundary.Resolve(context, internalSharedSecret, previousInternalSharedSecret, directAuth);
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

app.MapGet("/health/ready", async (IGCodeAnalyzer analyzer, IContentObjectStore objects, IGCodeJobRepositoryMaintenance jobs, IGCodeJobQueue queue, GCodeJobWorker worker, GCodeJobAdmissionOptions admission, CancellationToken ct) =>
    {
        var writable = await objects.ProbeWritableAsync(ct);
        var repository = await jobs.ProbeAsync(ct);
        metrics.SetRepositoryHealth(repository.Ready, repository.RecordCount);
        var ready = writable && repository.Ready && queue.IsAccepting && worker.Started;
        var response = new HealthResponse(
            ready ? "ready" : "not_ready",
            "forgex-authoritative-api",
            serviceVersion,
            DateTimeOffset.UtcNow,
            new Dictionary<string, string>
            {
                ["gcodeAnalyzer"] = analyzer.GetType().Name,
                ["objectStore"] = writable ? "writable" : "unavailable",
                ["jobRepository"] = repository.Ready ? repository.Provider : repository.ErrorCode ?? "unavailable",
                ["jobRepositorySchema"] = repository.SchemaVersion.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["jobRepositoryRecords"] = repository.RecordCount.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["jobQueue"] = queue.IsAccepting ? "accepting" : "closed",
                ["jobQueueDepth"] = queue.Depth.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["jobQueueCapacity"] = queue.Capacity.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["jobMaxActivePerOwner"] = admission.MaxActivePerOwner.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["jobMaxActivePerTenant"] = admission.MaxActivePerTenant.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["jobWorker"] = worker.Started ? "started" : "starting",
                ["callerContext"] = string.IsNullOrEmpty(internalSharedSecret) && string.IsNullOrEmpty(previousInternalSharedSecret)
                    ? "local-development"
                    : string.IsNullOrEmpty(previousInternalSharedSecret) ? "trusted-node" : "trusted-node-rotation-overlap",
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

app.MapGet("/metrics", async (IGCodeJobQueue queue, IGCodeJobRepository repository, CancellationToken ct) => Results.Text(
        metrics.Render(serviceVersion, queue, await repository.ListAsync(ct)),
        "text/plain; version=0.0.4; charset=utf-8"))
    .WithName("GetMetrics")
    .ExcludeFromDescription();

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

app.MapPost(
        "/api/v1/analytics/reports",
        (Func<HttpContext, Task<IResult>>)AnalyticsEndpoints.AnalyzeAsync)
    .WithName("AnalyzeAnalyticsReport")
    .Accepts<AnalyticsReportRequestDto>("application/json")
    .Produces<AnalyticsAuthorityResponseDto>()
    .Produces<ApiProblem>(StatusCodes.Status400BadRequest, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status413PayloadTooLarge, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status415UnsupportedMediaType, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status500InternalServerError, "application/problem+json");

app.MapPost(
        "/api/v1/calibration/train",
        (Func<HttpContext, Task<IResult>>)CalibrationEndpoints.TrainAsync)
    .WithName("TrainCalibrationModel")
    .Accepts<CalibrationTrainingRequestDto>("application/json")
    .Produces<CalibrationAuthorityResponseDto>()
    .Produces<ApiProblem>(StatusCodes.Status400BadRequest, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status413PayloadTooLarge, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status415UnsupportedMediaType, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status422UnprocessableEntity, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status500InternalServerError, "application/problem+json");

// ── Stage 8.3：Node 规则计算腿的接管端点（迁移期内部调用，不进公开 OpenAPI 文档）──
app.MapGet("/api/v1/analytics/datasets/meta", RulesEngineEndpoints.Meta)
    .WithName("GetAnalyticsDatasetMeta")
    .ExcludeFromDescription();

app.MapGet("/api/v1/analytics/datasets/farm", RulesEngineEndpoints.Farm)
    .WithName("GetAnalyticsFarmDataset")
    .ExcludeFromDescription();

app.MapPost(
        "/api/v1/analytics/datasets/normalize",
        (Func<HttpContext, Task<IResult>>)RulesEngineEndpoints.NormalizeAsync)
    .WithName("NormalizeAnalyticsDataset")
    .ExcludeFromDescription();

app.MapPost(
        "/api/v1/analytics/briefs",
        (Func<HttpContext, Task<IResult>>)RulesEngineEndpoints.BriefAsync)
    .WithName("BuildAnalyticsBrief")
    .ExcludeFromDescription();

app.MapPost(
        "/api/v1/calibration/validate",
        (Func<HttpContext, Task<IResult>>)RulesEngineEndpoints.ValidateCalibrationAsync)
    .WithName("ValidateCalibrationBundle")
    .ExcludeFromDescription();

app.MapPost("/api/v1/gcode/analyses", GCodeJobEndpoints.CreateAsync)
    .WithName("CreateGCodeAnalysisJob")
    .Accepts<Stream>("application/x-gcode")
    .Produces<GCodeJobAcceptedResponse>(StatusCodes.Status202Accepted)
    .Produces<ApiProblem>(StatusCodes.Status400BadRequest, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status409Conflict, "application/problem+json")
    .Produces<ApiProblem>(StatusCodes.Status429TooManyRequests, "application/problem+json");

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

if (sharesEnabled)
{
    app.MapPost("/api/v1/shares", ShareEndpoints.CreateAsync)
        .WithName("CreateShare")
        .Accepts<ShareCreateRequestDto>("application/json")
        .Produces<ShareCreateResponseDto>(StatusCodes.Status201Created)
        .Produces<ApiProblem>(StatusCodes.Status400BadRequest, "application/problem+json")
        .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
        .Produces<ApiProblem>(StatusCodes.Status413PayloadTooLarge, "application/problem+json");

    app.MapPost("/api/v1/shares/{token}/revoke", ShareEndpoints.RevokeAsync)
        .WithName("RevokeShare")
        .Accepts<ShareRevokeRequestDto>("application/json")
        .Produces<ShareRevokeResponseDto>()
        .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
        .Produces<ApiProblem>(StatusCodes.Status403Forbidden, "application/problem+json")
        .Produces<ApiProblem>(StatusCodes.Status404NotFound, "application/problem+json");

    app.MapGet("/share/{token}", ShareEndpoints.RenderAsync)
        .WithName("RenderSharePage")
        .Produces(StatusCodes.Status200OK, contentType: "text/html")
        .Produces<ApiProblem>(StatusCodes.Status404NotFound, "application/problem+json");
}

if (analysisTasksEnabled)
{
    app.MapGet("/api/v1/analysis-tasks", AnalysisTaskEndpoints.ListAsync)
        .WithName("ListAnalysisTasks")
        .Produces<AnalysisTaskListResponseDto>()
        .Produces<ApiProblem>(StatusCodes.Status400BadRequest, "application/problem+json")
        .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json");

    app.MapGet("/api/v1/analysis-tasks/{id}", AnalysisTaskEndpoints.GetAsync)
        .WithName("GetAnalysisTask")
        .Produces<AnalysisTaskSnapshotDto>()
        .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
        .Produces<ApiProblem>(StatusCodes.Status404NotFound, "application/problem+json");

    app.MapGet("/api/v1/analysis-tasks/{id}/events", AnalysisTaskEndpoints.EventsAsync)
        .WithName("StreamAnalysisTaskEvents")
        .Produces(StatusCodes.Status200OK, contentType: "text/event-stream")
        .Produces<ApiProblem>(StatusCodes.Status401Unauthorized, "application/problem+json")
        .Produces<ApiProblem>(StatusCodes.Status404NotFound, "application/problem+json");
}

app.Run();

static int ReadInt(IConfiguration configuration, string key, int fallback)
{
    var value = configuration[key];
    return string.IsNullOrWhiteSpace(value)
        ? fallback
        : int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : throw new InvalidOperationException($"{key} must be an integer.");
}
