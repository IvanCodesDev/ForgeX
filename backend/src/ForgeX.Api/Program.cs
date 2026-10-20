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

var storageRoot = Path.GetFullPath(builder.Configuration["Storage:Root"] ?? "data/dotnet-preview", builder.Environment.ContentRootPath);

// ── Stage 8.1 / 8.6a：shares 迁 C#（V2.0 手册 §4.2 第 1 项）──────────────────
// 默认 disabled：不配置时不注册端点，行为与 1.0.0 完全一致；
// postgres 复用 Node 侧同一张 forgex.shares 表与 RLS 策略；
// file（8.6a 新增）落在 Storage:Root/shares，保住零依赖单进程部署。
var sharesProvider = ResourceProviderOptions.Read(builder.Configuration, "Shares");
var sharesEnabled = sharesProvider.Enabled;
if (sharesEnabled)
{
    var shareTtlMs = ReadInt(builder.Configuration, "Shares:TtlMs", 24 * 60 * 60 * 1000);
    if (shareTtlMs < 1)
    {
        throw new InvalidOperationException("Shares:TtlMs must be positive.");
    }
    var shareMaxPerOwner = ReadInt(builder.Configuration, "Shares:MaxPerOwner", PostgresShareRepository.DefaultMaxSharesPerOwner);
    builder.Services.AddSingleton(new SharePublicBase(builder.Configuration["Shares:PublicBase"]?.TrimEnd('/') ?? string.Empty));
    builder.Services.AddSingleton<IShareRepository>(_ => sharesProvider.IsPostgres
        ? new PostgresShareRepository(sharesProvider.PostgresUrl, TimeSpan.FromMilliseconds(shareTtlMs), shareMaxPerOwner)
        : new FileShareRepository(Path.Combine(storageRoot, "shares"), TimeSpan.FromMilliseconds(shareTtlMs), shareMaxPerOwner));
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
    // Stage 8.6c-2b：创建链的规则引擎腿——C# 进程内执行、逐事件 UPSERT 同一张表。
    // TtlMs 对齐 Node TASK_TTL_MS（默认 1 小时）；Concurrency / QueueCapacity 对齐 G-code 作业宿主的取值范围；
    // StaleRunningMs 是「多久没更新的 running 行视为被中断」的恢复阈值（Node ready() 的 RLS 友好版）。
    var analysisTtlMs = ReadLong(builder.Configuration, "AnalysisTasks:TtlMs", AnalysisTaskOptions.DefaultTtlMs);
    var analysisConcurrency = ReadInt(builder.Configuration, "AnalysisTasks:Concurrency", AnalysisTaskOptions.DefaultConcurrency);
    var analysisQueueCapacity = ReadInt(builder.Configuration, "AnalysisTasks:QueueCapacity", AnalysisTaskOptions.DefaultQueueCapacity);
    var analysisStaleMs = ReadLong(builder.Configuration, "AnalysisTasks:StaleRunningMs", AnalysisTaskOptions.DefaultStaleRunningMs);
    if (analysisTtlMs < 1 || analysisConcurrency is < 1 or > 64 || analysisQueueCapacity is < 1 or > 4096 || analysisStaleMs < 1000)
    {
        throw new InvalidOperationException(
            "AnalysisTasks:TtlMs must be positive, AnalysisTasks:Concurrency 1..64, AnalysisTasks:QueueCapacity 1..4096 and AnalysisTasks:StaleRunningMs >= 1000.");
    }
    builder.Services.AddSingleton(new AnalysisTaskOptions(analysisTtlMs, analysisConcurrency, analysisQueueCapacity, analysisStaleMs));
    builder.Services.AddSingleton(new AnalysisTaskQueue(analysisQueueCapacity));
    builder.Services.AddSingleton<AnalysisTaskRuntime>();

    // Stage 8.6c-2b-ii：AI provider / 成本闸门 / 结果缓存（进程内，对齐 Node ANALYSIS_PROVIDER / OPENAI_* / AI_* / RESULT_CACHE_*）。
    var aiPreference = (builder.Configuration["Analysis:Provider"] ?? "auto").Trim().ToLowerInvariant();
    if (aiPreference is not ("auto" or "openai" or "rules" or "local"))
    {
        throw new InvalidOperationException("Analysis:Provider must be 'auto', 'openai' or 'rules'.");
    }
    var aiTimeoutMs = ReadInt(builder.Configuration, "OpenAi:TimeoutMs", AnalysisAiOptions.DefaultTimeoutMs);
    if (aiTimeoutMs < 1)
    {
        throw new InvalidOperationException("OpenAi:TimeoutMs must be positive.");
    }
    builder.Services.AddSingleton(new AnalysisAiOptions(
        aiPreference,
        (builder.Configuration["OpenAi:BaseUrl"] ?? AnalysisAiOptions.DefaultBaseUrl).Trim(),
        (builder.Configuration["OpenAi:ApiKey"] ?? string.Empty).Trim(),
        (builder.Configuration["OpenAi:Model"] ?? string.Empty).Trim(),
        aiTimeoutMs,
        builder.Configuration["Analysis:ProbeProvider"] != "0"));
    var aiConcurrency = ReadInt(builder.Configuration, "Analysis:AiConcurrency", AnalysisGateOptions.DefaultAiConcurrency);
    var aiQueueMax = ReadInt(builder.Configuration, "Analysis:AiQueueMax", AnalysisGateOptions.DefaultAiQueueMax);
    var aiDailyPerCaller = ReadInt(builder.Configuration, "Analysis:AiDailyPerCaller", AnalysisGateOptions.DefaultDailyPerCaller);
    var aiDailyGlobal = ReadInt(builder.Configuration, "Analysis:AiDailyGlobal", AnalysisGateOptions.DefaultDailyGlobal);
    if (aiConcurrency < 1 || aiQueueMax < 0 || aiDailyPerCaller < 0 || aiDailyGlobal < 0)
    {
        throw new InvalidOperationException("Analysis:AiConcurrency must be positive; Analysis:AiQueueMax / AiDailyPerCaller / AiDailyGlobal must be >= 0 (0 = unlimited budget).");
    }
    builder.Services.AddSingleton(new AnalysisGateOptions(aiConcurrency, aiQueueMax, aiDailyPerCaller, aiDailyGlobal));
    var cacheTtlMs = ReadLong(builder.Configuration, "Analysis:CacheTtlMs", AnalysisCacheOptions.DefaultTtlMs);
    var cacheMax = ReadInt(builder.Configuration, "Analysis:CacheMax", AnalysisCacheOptions.DefaultMax);
    if (cacheTtlMs < 1 || cacheMax < 0)
    {
        throw new InvalidOperationException("Analysis:CacheTtlMs must be positive and Analysis:CacheMax >= 0.");
    }
    builder.Services.AddSingleton(new AnalysisCacheOptions(cacheTtlMs, cacheMax));
    builder.Services.AddSingleton<AnalysisProviderSelection>();
    builder.Services.AddSingleton<AnalysisCostGate>();
    builder.Services.AddSingleton<AnalysisResultCache>();
    builder.Services.AddSingleton<OpenAiNarrativeClient>();
    builder.Services.AddSingleton<AnalysisTaskExecutor>();
    builder.Services.AddHostedService<AnalysisTaskWorker>();
}

// ── Stage 8.6a：数据源 / 知识库迁 C#（V2.0 手册 §4.2 第 6 项 a/b）─────────────
// 默认 disabled；file 落 Storage:Root/{datasources,knowledge}，postgres 复用 Node 同表同 RLS。
// TtlMs=0 表示永不过期（对齐 Node TASK_TTL_MS 为 0 的语义）。
var datasourcesProvider = ResourceProviderOptions.Read(builder.Configuration, "Datasources");
if (datasourcesProvider.Enabled)
{
    var ttlMs = ReadLong(builder.Configuration, "Datasources:TtlMs", DatasourceOptions.DefaultTtlMs);
    var maxPerOwner = ReadInt(builder.Configuration, "Datasources:MaxPerOwner", DatasourceOptions.DefaultMaxPerOwner);
    if (ttlMs < 0 || maxPerOwner < 1)
    {
        throw new InvalidOperationException("Datasources:TtlMs must be >= 0 and Datasources:MaxPerOwner must be positive.");
    }
    builder.Services.AddSingleton(new DatasourceOptions(ttlMs, maxPerOwner));
    builder.Services.AddSingleton<IDatasourceRepository>(_ => datasourcesProvider.IsPostgres
        ? new PostgresDatasourceRepository(datasourcesProvider.PostgresUrl, maxPerOwner)
        : new FileDatasourceRepository(Path.Combine(storageRoot, "datasources"), maxPerOwner));
}

var knowledgeProvider = ResourceProviderOptions.Read(builder.Configuration, "Knowledge");
if (knowledgeProvider.Enabled)
{
    var ttlMs = ReadLong(builder.Configuration, "Knowledge:TtlMs", KnowledgeOptions.DefaultTtlMs);
    var maxPerOwner = ReadInt(builder.Configuration, "Knowledge:MaxPerOwner", KnowledgeOptions.DefaultMaxPerOwner);
    if (ttlMs < 0 || maxPerOwner < 1)
    {
        throw new InvalidOperationException("Knowledge:TtlMs must be >= 0 and Knowledge:MaxPerOwner must be positive.");
    }
    builder.Services.AddSingleton(new KnowledgeOptions(ttlMs, maxPerOwner));
    builder.Services.AddSingleton<IKnowledgeRepository>(_ => knowledgeProvider.IsPostgres
        ? new PostgresKnowledgeRepository(knowledgeProvider.PostgresUrl, maxPerOwner)
        : new FileKnowledgeRepository(Path.Combine(storageRoot, "knowledge"), maxPerOwner));
}

// Stage 8.6a: calibration governance is deployment-scoped (Node: cfg.postgresTenantId || "tn_local"),
// so the tenant comes from configuration, never from the caller. The file leg shares Node's
// forgex-calibration-service-state v1 format (decision A1): point Calibrations:StateFile at the
// Node DATA_DIR/calibrations.json to take the governance state over as-is.
var calibrationsProvider = ResourceProviderOptions.Read(builder.Configuration, "Calibrations");
if (calibrationsProvider.Enabled)
{
    var maxSubmissions = ReadInt(builder.Configuration, "Calibrations:MaxSubmissions", CalibrationGovernanceRules.DefaultMaxSubmissions);
    if (maxSubmissions < 1)
    {
        throw new InvalidOperationException("Calibrations:MaxSubmissions must be positive.");
    }
    var calibrationTenantId = builder.Configuration["Calibrations:TenantId"] ?? "tn_local";
    var calibrationOwnerId = builder.Configuration["Calibrations:OwnerId"];
    var calibrationStateFile = Path.GetFullPath(
        builder.Configuration["Calibrations:StateFile"] ?? Path.Combine(storageRoot, "calibrations.json"),
        builder.Environment.ContentRootPath);
    builder.Services.AddSingleton<ICalibrationGovernanceStore>(_ => calibrationsProvider.IsPostgres
        ? new PostgresCalibrationGovernanceStore(calibrationsProvider.PostgresUrl, calibrationTenantId, calibrationOwnerId, maxSubmissions)
        : new FileCalibrationGovernanceStore(calibrationStateFile, maxSubmissions));
}

// Direct-caller identity is a singleton shared by the caller-context middleware and the calibration
// governance endpoints (submitter / reviewer resolution, §7.2).
var directAuth = DirectAuthOptions.FromConfiguration(builder.Configuration);
builder.Services.AddSingleton(directAuth);

// Stage 8.6a: every enabled TTL-bearing repository joins the periodic sweeper (Node: 60 s setInterval)
// and the resource gauges on /metrics.
if (sharesEnabled)
{
    builder.Services.AddSingleton<IResourceSweepable>(static services => services.GetRequiredService<IShareRepository>());
}
if (datasourcesProvider.Enabled)
{
    builder.Services.AddSingleton<IResourceSweepable>(static services => services.GetRequiredService<IDatasourceRepository>());
}
if (knowledgeProvider.Enabled)
{
    builder.Services.AddSingleton<IResourceSweepable>(static services => services.GetRequiredService<IKnowledgeRepository>());
}
var sweepIntervalMs = ReadLong(builder.Configuration, "Resources:SweepIntervalMs", (long)ResourceSweeper.DefaultInterval.TotalMilliseconds);
if (sweepIntervalMs < 1)
{
    throw new InvalidOperationException("Resources:SweepIntervalMs must be positive.");
}
builder.Services.AddHostedService(services => new ResourceSweeper(
    services.GetServices<IResourceSweepable>(),
    services.GetRequiredService<ILogger<ResourceSweeper>>(),
    TimeSpan.FromMilliseconds(sweepIntervalMs)));
builder.Services.AddSingleton(static services => new ResourceGaugeSampler(
    services.GetServices<IResourceSweepable>(),
    services.GetService<ICalibrationGovernanceStore>(),
    services.GetRequiredService<ILogger<ResourceGaugeSampler>>()));

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
app.Use(CallerContextBoundary.BuildMiddleware(internalSharedSecret, previousInternalSharedSecret, directAuth));

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

// ── Stage 8：静态托管（V2 手册 §4.2 工作项 5「ForgeX.Api 托管 dist/react，单进程交付」）──
// 默认不配置 = 不注册中间件，行为与迁移前完全一致；启用后按 server/lib/http.js 的
// allowlist / 缓存 / 穿越防护逐条对齐（ForgeX.StaticGate 双跑锁定）。端点路由恒优先：
// 中间件只接手未被任何端点认领的 GET/HEAD 非 /api/ 路径，静态路径也不进 CallerContext 边界。
var staticHosting = StaticHostingOptions.FromConfiguration(builder.Configuration, builder.Environment.ContentRootPath);
if (staticHosting.Enabled)
{
    app.Use(StaticFileHosting.BuildMiddleware(staticHosting));
}

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

app.MapGet("/metrics", async (IGCodeJobQueue queue, IGCodeJobRepository repository, ResourceGaugeSampler gauges, CancellationToken ct) => Results.Text(
        metrics.Render(serviceVersion, queue, await repository.ListAsync(ct), await gauges.SampleAsync(ct)),
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
    ShareEndpoints.Map(app);
}

if (datasourcesProvider.Enabled)
{
    DatasourceEndpoints.Map(app);
}

if (knowledgeProvider.Enabled)
{
    KnowledgeEndpoints.Map(app);
}

if (calibrationsProvider.Enabled)
{
    CalibrationGovernanceEndpoints.Map(app);
}

if (analysisTasksEnabled)
{
    AnalysisTaskEndpoints.Map(app);
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

static long ReadLong(IConfiguration configuration, string key, long fallback)
{
    var value = configuration[key];
    return string.IsNullOrWhiteSpace(value)
        ? fallback
        : long.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : throw new InvalidOperationException($"{key} must be an integer.");
}
