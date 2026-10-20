using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ForgeX.Analytics;
using ForgeX.Application;
using ForgeX.Infrastructure;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.6d-1 — ForgeX.Api speaks Node's public dialect itself, so the browser (and every direct
/// caller) can hit the single C# process without the Node proxy: the same paths, the same
/// <c>{ "error": "…" }</c> bodies with the same Chinese messages, Node's 202 / poll / result shapes,
/// unnamed <c>data:</c> SSE frames, per-IP cooldown on task creation, CORS with the <c>ALLOW_ORIGINS</c>
/// semantics, <c>OPTIONS → 204</c>, <c>/api/*</c> misses → 404「接口不存在」, <c>/healthz</c> in the shape the
/// frontend probes, and Node's <c>/metrics</c> series names. The internal <c>/api/v1/*</c> contract is untouched;
/// everything here is disabled unless <c>PublicFacade:Enabled=true</c>.
/// </summary>
internal sealed record PublicFacadeOptions(bool Enabled, IReadOnlyList<string> AllowOrigins, int RateLimitMs, bool TrustProxy, string PublicBase)
{
    public const int DefaultRateLimitMs = 5000;

    public static PublicFacadeOptions FromConfiguration(IConfiguration configuration)
    {
        var enabled = configuration["PublicFacade:Enabled"] is "1" or "true" or "True";
        var origins = (configuration["PublicFacade:AllowOrigins"] ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var rateLimit = configuration["PublicFacade:RateLimitMs"];
        var rateLimitMs = string.IsNullOrWhiteSpace(rateLimit)
            ? DefaultRateLimitMs
            : int.TryParse(rateLimit, out var parsed) && parsed >= 0
                ? parsed
                : throw new InvalidOperationException("PublicFacade:RateLimitMs must be a non-negative integer.");
        var trustProxy = configuration["PublicFacade:TrustProxy"] is "1" or "true" or "True";
        var publicBase = (configuration["PublicFacade:PublicBase"] ?? configuration["Shares:PublicBase"] ?? string.Empty).TrimEnd('/');
        return new PublicFacadeOptions(enabled, origins, rateLimitMs, trustProxy, publicBase);
    }
}

/// <summary>Node server/index.js rateLimit(): one request per RATE_LIMIT_MS per IP, LRU-bounded to 10 000 addresses.</summary>
internal sealed class PublicRateLimiter(int windowMs)
{
    private const int MaxEntries = 10_000;
    private readonly object _lock = new();
    private readonly Dictionary<string, LinkedListNode<(string Ip, long At)>> _entries = new(StringComparer.Ordinal);
    private readonly LinkedList<(string Ip, long At)> _order = new();

    /// <summary>Null when allowed; otherwise the whole seconds the caller must wait (Node: Math.ceil).</summary>
    public int? Check(string ip)
    {
        if (windowMs <= 0) return null;
        lock (_lock)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (_entries.TryGetValue(ip, out var node))
            {
                var elapsed = now - node.Value.At;
                if (elapsed < windowMs) return (int)Math.Ceiling((windowMs - elapsed) / 1000.0);
                _order.Remove(node);
                _entries.Remove(ip);
            }
            var fresh = _order.AddLast((ip, now));
            _entries[ip] = fresh;
            while (_entries.Count > MaxEntries && _order.First is { } oldest)
            {
                _order.RemoveFirst();
                _entries.Remove(oldest.Value.Ip);
            }
            return null;
        }
    }
}

internal static class PublicFacade
{
    private const string NotFoundText = "接口不存在";
    private const string InternalErrorText = "服务器内部错误";
    private const string TaskNotFoundText = "任务不存在或已过期";

    /// <summary>Titles the internal problem+json contract phrases differently from Node's public messages.</summary>
    private static readonly Dictionary<string, string> TitleRemap = new(StringComparer.Ordinal)
    {
        ["Analysis task not found"] = TaskNotFoundText,
    };

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static bool IsPublicPath(PathString path) =>
        path.StartsWithSegments("/api/analyze", StringComparison.Ordinal) ||
        path.StartsWithSegments("/api/datasource", StringComparison.Ordinal) ||
        path.StartsWithSegments("/api/knowledge", StringComparison.Ordinal) ||
        path.StartsWithSegments("/api/share", StringComparison.Ordinal) ||
        path.StartsWithSegments("/api/calibrations", StringComparison.Ordinal);

    /// <summary>
    /// Runs before the caller-context boundary: CORS + OPTIONS 204 for every request, then Node's
    /// resolveIdentity() for the public owner-scoped paths (API key → key:{id8}, anonymous → ip:{addr},
    /// REQUIRE_AUTH → 401 with Node's message, calibration governance judges its own keys).
    /// </summary>
    public static Func<HttpContext, RequestDelegate, Task> BuildMiddleware(PublicFacadeOptions options, DirectAuthOptions directAuth)
    {
        return async (context, next) =>
        {
            ApplyCors(context, options);
            if (HttpMethods.IsOptions(context.Request.Method))
            {
                context.Response.StatusCode = StatusCodes.Status204NoContent;
                return;
            }

            var path = context.Request.Path;
            if (IsPublicPath(path))
            {
                // Node routes/calibration.js never calls resolveIdentity(): the catalog is public and the
                // governance routes judge submitter / reviewer keys themselves, so REQUIRE_AUTH does not apply there.
                var problem = DirectCallerAuthentication.Resolve(
                    context,
                    directAuth,
                    out var caller,
                    enforceRequireAuth: !path.StartsWithSegments("/api/calibrations", StringComparison.Ordinal));
                if (problem is not null)
                {
                    await WriteErrorAsync(context, StatusCodes.Status401Unauthorized,
                        "需要 API Key：请在 Authorization: Bearer <key> 或 X-API-Key 头中提供");
                    return;
                }
                CallerContextBoundary.Set(context, caller!);
            }

            var sharePage = path.StartsWithSegments("/share", StringComparison.Ordinal);
            try
            {
                if (sharePage)
                {
                    // /share/{token} is served by the internal handler (problem+json on 404); Node answers {error}.
                    await RelayCapturedAsync(context, await CaptureAsync(context, async () =>
                    {
                        await next(context);
                        return Results.Empty;
                    }));
                    return;
                }
                await next(context);
            }
            catch (Exception exception) when (!context.Response.HasStarted && (IsPublicPath(path) || sharePage))
            {
                context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("ForgeX.PublicFacade")
                    .LogError(exception, "unhandled public request {Method} {Path}", context.Request.Method, path);
                await WriteErrorAsync(context, StatusCodes.Status500InternalServerError, InternalErrorText);
            }
        };
    }

    private static void ApplyCors(HttpContext context, PublicFacadeOptions options)
    {
        var origin = context.Request.Headers.Origin.ToString();
        if (origin.Length == 0 || !options.AllowOrigins.Contains(origin, StringComparer.Ordinal)) return;
        var headers = context.Response.Headers;
        headers.AccessControlAllowOrigin = origin;
        headers.Vary = "Origin";
        headers.AccessControlAllowMethods = "GET,POST,OPTIONS";
        headers.AccessControlAllowHeaders = "Content-Type, Authorization, X-API-Key, Idempotency-Key, Last-Event-ID";
        headers.AccessControlMaxAge = "600";
    }

    public static void Map(IEndpointRouteBuilder app)
    {
        // 分析任务（Node routes/analyze.js）
        app.MapPost("/api/analyze", CreateAnalysisAsync).ExcludeFromDescription();
        app.MapGet("/api/analyze/{id:regex(^[A-Za-z0-9_]+$)}/stream", StreamAnalysisAsync).ExcludeFromDescription();
        app.MapGet("/api/analyze/{id:regex(^[A-Za-z0-9_]+$)}/result", ResultAsync).ExcludeFromDescription();
        app.MapGet("/api/analyze/{id:regex(^[A-Za-z0-9_]+$)}", PollAsync).ExcludeFromDescription();

        // 数据源 / 知识库（同一 handler，改说 Node 方言）
        app.MapPost("/api/datasource", (HttpContext context, IDatasourceRepository datasources, DatasourceOptions options) =>
            RelayAsync(context, () => DatasourceEndpoints.CreateAsync(context, datasources, options))).ExcludeFromDescription();
        app.MapPost("/api/knowledge", CreateKnowledgeAsync).ExcludeFromDescription();
        app.MapPost("/api/knowledge/search", (HttpContext context, IKnowledgeRepository knowledge) =>
            RelayAsync(context, () => KnowledgeEndpoints.SearchAsync(context, knowledge))).ExcludeFromDescription();

        // 分享（Node routes/share.js）
        app.MapPost("/api/share/{taskId:regex(^[A-Za-z0-9_]+$)}", CreateShareAsync).ExcludeFromDescription();
        app.MapPost("/api/share/{token:regex(^[a-f0-9]+$)}/revoke", (HttpContext context, string token, IShareRepository shares) =>
            RelayAsync(context, () => ShareEndpoints.RevokeAsync(context, token, shares))).ExcludeFromDescription();

        // 校准治理（Node routes/calibration.js；角色由 DirectAuth 判定，与内部端点同一 handler）
        app.MapGet("/api/calibrations", (HttpContext context, ICalibrationGovernanceStore store) =>
            RelayAsync(context, () => CalibrationGovernanceEndpoints.CatalogAsync(store, context.RequestAborted))).ExcludeFromDescription();
        app.MapGet("/api/calibrations/submissions", (HttpContext context, ICalibrationGovernanceStore store, DirectAuthOptions directAuth) =>
            RelayAsync(context, () => CalibrationGovernanceEndpoints.ListSubmissionsAsync(context, store, directAuth))).ExcludeFromDescription();
        app.MapPost("/api/calibrations/submissions", (HttpContext context, ICalibrationGovernanceStore store, DirectAuthOptions directAuth) =>
            RelayAsync(context, () => CalibrationGovernanceEndpoints.SubmitAsync(context, store, directAuth))).ExcludeFromDescription();
        app.MapPost("/api/calibrations/{id:regex(^[A-Za-z0-9._-]+$)}/revisions/{revision:int}/review",
            (HttpContext context, string id, int revision, ICalibrationGovernanceStore store, DirectAuthOptions directAuth) =>
                RelayAsync(context, () => CalibrationGovernanceEndpoints.ReviewAsync(context, id, revision, store, directAuth))).ExcludeFromDescription();

        // classic 页启动探测的墓碑（随 Stage 7.4 删除 classic 一并移除）
        app.MapGet("/api/auth/infini/me", () => Results.Json(
            new { enabled = false, authenticated = false, user = (object?)null, canUseAi = false, integration = "retired" },
            JsonOptions)).ExcludeFromDescription();

        // Node: 未命中的公共 /api/* 一律 404「接口不存在」（任何方法）。内部 /api/v1/* 保持 problem+json
        // （只置状态码，交给 StatusCodePages）。不加全局 fallback：静态托管中间件只接手无端点认领的 GET/HEAD。
        app.MapFallback("/api/{**rest}", (HttpContext context) =>
        {
            if (context.Request.Path.StartsWithSegments("/api/v1", StringComparison.Ordinal))
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return Task.CompletedTask;
            }
            return WriteErrorAsync(context, StatusCodes.Status404NotFound, NotFoundText);
        }).ExcludeFromDescription();
    }

    // ── 分析任务 ──────────────────────────────────────────────────────────────

    private static async Task CreateAnalysisAsync(HttpContext context, PublicRateLimiter limiter)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        // Node: identity first, then the per-IP cooldown, then the body.
        if (limiter.Check(DirectCallerAuthentication.RemoteAddress(context)) is { } wait)
        {
            await WriteErrorAsync(context, StatusCodes.Status429TooManyRequests, "请求过于频繁，请 " + wait + " 秒后重试");
            return;
        }

        var (body, bodyError) = await ReadJsonAsync(context, 8 * 1024);
        if (bodyError is not null)
        {
            await WriteErrorAsync(context, bodyError.Status, bodyError.Title);
            return;
        }

        // Node: String(body.question || "").trim(); aiBaseUrl / aiApiKey / aiModel must be strings when present.
        var question = JsString(body!["question"]);
        var (baseUrl, baseUrlError) = FieldAsString(body["aiBaseUrl"], "aiBaseUrl");
        var (apiKey, apiKeyError) = FieldAsString(body["aiApiKey"], "aiApiKey");
        var (model, modelError) = FieldAsString(body["aiModel"], "aiModel");
        if ((baseUrlError ?? apiKeyError ?? modelError) is { } fieldError)
        {
            await WriteErrorAsync(context, StatusCodes.Status400BadRequest, fieldError);
            return;
        }
        var (override_, overrideError) = AiEndpoint.Parse(baseUrl, apiKey, model);
        if (overrideError is not null)
        {
            await WriteErrorAsync(context, StatusCodes.Status400BadRequest, overrideError);
            return;
        }

        var services = context.RequestServices;
        var deps = new AnalysisTaskEndpoints.AnalysisTaskCreationDeps(
            services.GetRequiredService<PostgresAnalysisTaskRepository>(),
            services.GetRequiredService<AnalysisTaskQueue>(),
            services.GetRequiredService<AnalysisTaskRuntime>(),
            services.GetRequiredService<AnalysisTaskOptions>(),
            services.GetRequiredService<AnalysisProviderSelection>(),
            services.GetRequiredService<AnalysisCostGate>());
        var datasourceId = body["datasourceId"] is JsonNode datasourceNode && Truthy(datasourceNode) ? JsString(datasourceNode) : "sample";
        var (accepted, error) = await AnalysisTaskEndpoints.TryCreateAsync(context, caller, question, datasourceId, override_, deps);
        if (error is not null)
        {
            await WriteErrorAsync(context, error.Status, error.Title);
            return;
        }
        services.GetRequiredService<AnalysisTaskMetrics>().RecordCreated();

        var response = new JsonObject
        {
            ["taskId"] = accepted!.Id,
            ["engine"] = accepted.Engine,
            ["authenticated"] = caller.Authenticated,
            ["willUseAi"] = accepted.WillUseAi,
            ["quota"] = accepted.Quota is null
                ? null
                : new JsonObject
                {
                    ["ok"] = accepted.Quota.Ok,
                    ["remaining"] = accepted.Quota.Remaining,
                    ["reason"] = accepted.Quota.Reason,
                },
        };
        if (accepted.Quota is { Reason: null } && response["quota"] is JsonObject quota)
        {
            quota.Remove("reason");
        }
        await WriteJsonAsync(context, StatusCodes.Status202Accepted, response);
    }

    private static async Task ResultAsync(HttpContext context, string id, PostgresAnalysisTaskRepository tasks)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var record = await tasks.GetAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted);
        if (record is null)
        {
            await WriteErrorAsync(context, StatusCodes.Status404NotFound, TaskNotFoundText);
            return;
        }
        switch (record.Status)
        {
            case "running":
                await WriteJsonAsync(context, StatusCodes.Status202Accepted, new JsonObject { ["status"] = "running" });
                return;
            case "failed":
                await WriteErrorAsync(context, StatusCodes.Status502BadGateway, string.IsNullOrEmpty(record.ErrorMessage) ? "分析失败" : record.ErrorMessage);
                return;
            default:
                await WriteRawJsonAsync(context, StatusCodes.Status200OK, record.ReportJson is { Length: > 0 } json && json != "null" ? json : "null");
                return;
        }
    }

    private static async Task PollAsync(HttpContext context, string id, PostgresAnalysisTaskRepository tasks)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var record = await tasks.GetAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted);
        if (record is null)
        {
            await WriteErrorAsync(context, StatusCodes.Status404NotFound, TaskNotFoundText);
            return;
        }
        var response = new JsonObject
        {
            ["taskId"] = record.Id,
            ["status"] = record.Status,
            ["engine"] = record.Engine,
            ["progress"] = record.Progress,
            ["message"] = record.Message,
        };
        if (!string.IsNullOrEmpty(record.ErrorMessage)) response["error"] = record.ErrorMessage;
        await WriteJsonAsync(context, StatusCodes.Status200OK, response);
    }

    /// <summary>
    /// Node's SSE dialect on the public path: `: connected`, then every persisted event as an unnamed
    /// `data:` frame (replay first, then live), closing after the terminal event. A terminal row without
    /// a terminal event (recovered after a restart) gets a synthesized `_fail` / `_finish` frame.
    /// </summary>
    private static async Task StreamAnalysisAsync(HttpContext context, string id, PostgresAnalysisTaskRepository tasks)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var record = await tasks.GetAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted);
        if (record is null)
        {
            await WriteErrorAsync(context, StatusCodes.Status404NotFound, TaskNotFoundText);
            return;
        }

        var response = context.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = "text/event-stream; charset=utf-8";
        response.Headers.CacheControl = "no-cache, no-transform";
        response.Headers.Connection = "keep-alive";
        response.Headers["X-Accel-Buffering"] = "no";
        await response.WriteAsync(": connected\n\n", context.RequestAborted);
        await response.Body.FlushAsync(context.RequestAborted);

        long lastSeq = 0;
        var heartbeatAt = DateTimeOffset.UtcNow.AddSeconds(10);
        while (!context.RequestAborted.IsCancellationRequested)
        {
            var sawTerminal = false;
            using (var events = JsonDocument.Parse(record.EventsJson))
            {
                foreach (var item in events.RootElement.EnumerateArray())
                {
                    var seq = item.TryGetProperty("seq", out var seqValue) && seqValue.ValueKind == JsonValueKind.Number ? seqValue.GetInt64() : 0;
                    if (seq <= lastSeq) continue;
                    await response.WriteAsync("data: " + item.GetRawText() + "\n\n", context.RequestAborted);
                    lastSeq = seq;
                    if (item.TryGetProperty("done", out var done) && done.ValueKind == JsonValueKind.True) sawTerminal = true;
                }
            }
            await response.Body.FlushAsync(context.RequestAborted);
            if (sawTerminal) return;

            if (record.Status is "done" or "failed")
            {
                var terminal = new JsonObject
                {
                    ["seq"] = lastSeq + 1,
                    ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ["done"] = true,
                };
                if (record.Status == "failed")
                {
                    var error = string.IsNullOrEmpty(record.ErrorMessage) ? "分析失败" : record.ErrorMessage;
                    terminal["error"] = error;
                    terminal["message"] = "分析失败：" + error;
                }
                else
                {
                    terminal["progress"] = 1;
                    terminal["message"] = "分析完成";
                }
                await response.WriteAsync("data: " + terminal.ToJsonString(JsonOptions) + "\n\n", context.RequestAborted);
                await response.Body.FlushAsync(context.RequestAborted);
                return;
            }

            if (DateTimeOffset.UtcNow >= heartbeatAt)
            {
                await response.WriteAsync(": heartbeat\n\n", context.RequestAborted);
                await response.Body.FlushAsync(context.RequestAborted);
                heartbeatAt = DateTimeOffset.UtcNow.AddSeconds(10);
            }
            await Task.Delay(500, context.RequestAborted);
            record = await tasks.GetAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted);
            if (record is null) return;
        }
    }

    // ── 知识库登记：Node 在 C# 结果上补 retrievalEnabled / note ────────────────────

    private static async Task CreateKnowledgeAsync(HttpContext context, IKnowledgeRepository knowledge, KnowledgeOptions options, AnalysisProviderSelection providers)
    {
        var captured = await CaptureAsync(context, () => KnowledgeEndpoints.CreateAsync(context, knowledge, options));
        if (captured.Status != StatusCodes.Status201Created)
        {
            await RelayCapturedAsync(context, captured);
            return;
        }
        var created = JsonNode.Parse(captured.Body)!.AsObject();
        var aiEnabled = providers.UsesAi;
        var response = new JsonObject
        {
            ["knowledgeId"] = created["knowledgeId"]?.DeepClone(),
            ["name"] = created["name"]?.DeepClone(),
            ["chunks"] = created["chunks"]?.DeepClone(),
            ["retrievalEnabled"] = aiEnabled,
            ["note"] = aiEnabled
                ? "已登记。提问时会按问题检索相关片段注入 AI 提示词（BM25 关键词检索，检索不到则不注入）。存储由当前持久化 provider 管理，TTL 到期后失效。"
                : "已登记，但**当前配置下不会被使用**：正在运行的是规则引擎（确定性统计，不读自然语言知识）。配置 OpenAI 兼容端点（OPENAI_API_KEY / OPENAI_MODEL）后检索才会生效。存储由当前持久化 provider 管理，TTL 到期后失效。",
        };
        await WriteJsonAsync(context, StatusCodes.Status201Created, response);
    }

    // ── 分享创建：任务快照 → 分享记录 → Node 形状 ──────────────────────────────

    private static async Task CreateShareAsync(HttpContext context, string taskId, PostgresAnalysisTaskRepository tasks, IShareRepository shares, PublicFacadeOptions options)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var record = await tasks.GetAsync(caller.TenantId, caller.OwnerId, taskId, context.RequestAborted);
        if (record is null)
        {
            await WriteErrorAsync(context, StatusCodes.Status404NotFound, TaskNotFoundText);
            return;
        }
        if (record.Status != "done")
        {
            await WriteErrorAsync(context, StatusCodes.Status409Conflict, "任务尚未完成，无法分享");
            return;
        }

        var created = await shares.CreateAsync(
            caller.TenantId,
            caller.OwnerId,
            record.ReportJson is { Length: > 0 } report ? report : "null",
            record.Question,
            record.Engine,
            record.UpstreamTaskId,
            null,
            context.RequestAborted);
        var origin = context.Request.Headers.Origin.ToString();
        var basePath = options.PublicBase.Length > 0 ? options.PublicBase : origin;
        var response = new JsonObject
        {
            ["publicUrl"] = basePath + "/share/" + created.Token,
            ["token"] = created.Token,
            ["revokeKey"] = created.RevokeKey,
            ["expiresAt"] = created.ExpiresAt.ToUnixTimeMilliseconds(),
        };
        if (basePath.Length == 0)
        {
            response["note"] = "未配置 PUBLIC_BASE 且请求无 Origin，返回的是相对路径；部署时请设置 PUBLIC_BASE。";
        }
        await WriteJsonAsync(context, StatusCodes.Status201Created, response);
    }

    // ── healthz / metrics ─────────────────────────────────────────────────────

    public static async Task<IResult> HealthzAsync(HttpContext context)
    {
        var services = context.RequestServices;
        var providers = services.GetRequiredService<AnalysisProviderSelection>();
        var gate = services.GetRequiredService<AnalysisCostGate>();
        var directAuth = services.GetRequiredService<DirectAuthOptions>();
        var aiOptions = services.GetRequiredService<AnalysisAiOptions>();
        var usesAi = providers.UsesAi;
        var engine = usesAi ? AnalysisProviderSelection.OpenAiId : AnalysisProviderSelection.RulesId;
        var persistence = services.GetService<PostgresAnalysisTaskRepository>() is not null ? "postgres" : "file";

        CalibrationGovernanceStats? calibrations = null;
        try
        {
            if (services.GetService<PostgresAnalysisTaskRepository>() is { } tasks) await tasks.ProbeAsync(context.RequestAborted);
            if (services.GetService<IDatasourceRepository>() is { } datasources) await datasources.ProbeAsync(context.RequestAborted);
            if (services.GetService<IKnowledgeRepository>() is { } knowledge) await knowledge.ProbeAsync(context.RequestAborted);
            if (services.GetService<ICalibrationGovernanceStore>() is { } store) calibrations = await store.StatsAsync(context.RequestAborted);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return Results.Json(new
            {
                ok = false,
                engine,
                provider = usesAi ? "openai" : "local",
                persistence,
                error = "persistence_unavailable",
                now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            }, JsonOptions, statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        var snapshot = gate.Snapshot();
        return Results.Json(new
        {
            ok = true,
            engine,
            provider = usesAi ? "openai" : "local",
            label = usesAi ? "OpenAI 兼容 AI（" + (aiOptions.Model.Length > 0 ? aiOptions.Model : "未指定模型") + "）" : "后端规则引擎（无 AI）",
            capabilities = new { ai = usesAi, streaming = false, structuredOutput = true },
            capabilityScope = "system",
            reason = providers.Reason,
            quota = usesAi
                ? new
                {
                    running = snapshot.Running,
                    queued = snapshot.Queued,
                    concurrencyLimit = snapshot.ConcurrencyLimit,
                    queueLimit = snapshot.QueueLimit,
                    day = snapshot.Day,
                    globalUsed = snapshot.GlobalUsed,
                    globalLimit = snapshot.GlobalLimit,
                    perCallerLimit = snapshot.PerCallerLimit,
                    callers = snapshot.Callers,
                    totalEver = snapshot.TotalEver,
                    persisted = snapshot.Persisted,
                }
                : null,
            auth = new { enabled = directAuth.Enabled, required = directAuth.RequireAuth },
            persistence,
            calibrations = new
            {
                approved = calibrations?.Approved ?? 0,
                pending = calibrations?.Pending ?? 0,
                writesEnabled = directAuth.Enabled,
            },
            now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }, JsonOptions);
    }

    /// <summary>Node /metrics series that C#'s own exporter does not already emit (resource gauges come from ResourceGaugeSampler).</summary>
    public static string NodeMetrics(AnalysisTaskMetrics tasks, AnalysisCostGate gate)
    {
        var snapshot = gate.Snapshot();
        var lines = new StringBuilder();
        void Series(string type, string name, string help, long value)
        {
            lines.Append("# HELP ").Append(name).Append(' ').Append(help).Append('\n');
            lines.Append("# TYPE ").Append(name).Append(' ').Append(type).Append('\n');
            lines.Append(name).Append(' ').Append(value).Append('\n');
        }
        Series("counter", "forgex_tasks_total", "分析任务总数", tasks.Tasks);
        Series("counter", "forgex_tasks_failed_total", "失败的分析任务数", tasks.Failed);
        Series("counter", "forgex_tasks_degraded_total", "因额度/队列降级为规则引擎的任务数", tasks.Degraded);
        Series("counter", "forgex_tasks_cached_total", "命中结果缓存的任务数", tasks.Cached);
        Series("gauge", "forgex_task_duration_ms", "最近一次分析任务耗时（毫秒）", tasks.LastDurationMs);
        Series("gauge", "forgex_ai_running", "正在执行的 AI 任务数", snapshot.Running);
        Series("gauge", "forgex_ai_queued", "排队中的 AI 任务数", snapshot.Queued);
        Series("gauge", "forgex_ai_concurrency_limit", "AI 并发上限", snapshot.ConcurrencyLimit);
        Series("gauge", "forgex_ai_daily_used", "今日已用 AI 额度", snapshot.GlobalUsed);
        Series("gauge", "forgex_ai_daily_limit", "每日 AI 额度上限（0=不限）", snapshot.GlobalLimit ?? 0);
        return lines.ToString();
    }

    // ── 内部 handler → Node 方言 ────────────────────────────────────────────────

    private sealed record Captured(int Status, string? ContentType, byte[] Body);

    /// <summary>Executes an internal handler against a buffered body so its status / JSON can be re-spoken in Node's dialect.</summary>
    private static async Task<Captured> CaptureAsync(HttpContext context, Func<Task<IResult>> handler)
    {
        var original = context.Response.Body;
        await using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            var result = await handler();
            await result.ExecuteAsync(context);
        }
        finally
        {
            context.Response.Body = original;
        }
        return new Captured(context.Response.StatusCode, context.Response.ContentType, buffer.ToArray());
    }

    private static async Task RelayAsync(HttpContext context, Func<Task<IResult>> handler) =>
        await RelayCapturedAsync(context, await CaptureAsync(context, handler));

    /// <summary>problem+json → {error: title}（内部标题与 Node 文案不同的按表改写）；其它响应原样放行。</summary>
    private static async Task RelayCapturedAsync(HttpContext context, Captured captured)
    {
        if (captured.ContentType is not null && captured.ContentType.Contains("problem+json", StringComparison.OrdinalIgnoreCase))
        {
            var title = "请求失败";
            try
            {
                if (JsonNode.Parse(captured.Body) is JsonObject problem && problem["title"] is JsonNode node)
                {
                    title = node.GetValue<string>();
                }
            }
            catch (JsonException)
            {
                // fall through with the generic text
            }
            await WriteErrorAsync(context, captured.Status, TitleRemap.GetValueOrDefault(title, title));
            return;
        }
        context.Response.StatusCode = captured.Status;
        context.Response.ContentLength = captured.Body.Length;
        if (captured.ContentType is not null) context.Response.ContentType = captured.ContentType;
        await context.Response.Body.WriteAsync(captured.Body, context.RequestAborted);
    }

    // ── 小工具 ────────────────────────────────────────────────────────────────

    private sealed record BodyError(int Status, string Title);

    /// <summary>Node lib/http.js readJson: 413「请求体过大」、400「请求体为空」、400「请求体不是合法 JSON」；非对象顶层也算不合法。</summary>
    private static async Task<(JsonObject? Body, BodyError? Error)> ReadJsonAsync(HttpContext context, long maxBytes)
    {
        if (context.Request.ContentLength is > 0 && context.Request.ContentLength > maxBytes)
        {
            return (null, new BodyError(StatusCodes.Status413PayloadTooLarge, "请求体过大"));
        }
        await using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        long total = 0;
        int read;
        while ((read = await context.Request.Body.ReadAsync(chunk, context.RequestAborted)) > 0)
        {
            total += read;
            if (total > maxBytes) return (null, new BodyError(StatusCodes.Status413PayloadTooLarge, "请求体过大"));
            buffer.Write(chunk, 0, read);
        }
        if (buffer.Length == 0) return (null, new BodyError(StatusCodes.Status400BadRequest, "请求体为空"));
        try
        {
            return JsonNode.Parse(buffer.ToArray()) is JsonObject body
                ? (body, null)
                : (new JsonObject(), null);
        }
        catch (JsonException)
        {
            return (null, new BodyError(StatusCodes.Status400BadRequest, "请求体不是合法 JSON"));
        }
    }

    /// <summary>Node ai-endpoint.js fieldAsString: null/undefined → "", non-string → 400「x 必须是字符串」, string → trimmed.</summary>
    private static (string Value, string? Error) FieldAsString(JsonNode? node, string name)
    {
        if (node is null) return (string.Empty, null);
        if (node is JsonValue value && value.TryGetValue<string>(out var text)) return (JsValue.Trim(text), null);
        return (string.Empty, name + " 必须是字符串");
    }

    /// <summary>JS String(x || "") for the question field.</summary>
    private static string JsString(JsonNode? node) =>
        node is null || !Truthy(node) ? string.Empty : JsValue.ToJsString(JsonSerializer.SerializeToElement(node));

    private static bool Truthy(JsonNode node) => JsValue.Truthy(JsonSerializer.SerializeToElement(node));

    private static Task WriteErrorAsync(HttpContext context, int status, string message) =>
        WriteJsonAsync(context, status, new JsonObject { ["error"] = message });

    private static Task WriteJsonAsync(HttpContext context, int status, JsonObject body) =>
        WriteRawJsonAsync(context, status, body.ToJsonString(JsonOptions));

    private static async Task WriteRawJsonAsync(HttpContext context, int status, string json)
    {
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength = null;
        await context.Response.WriteAsync(json, context.RequestAborted);
    }
}
