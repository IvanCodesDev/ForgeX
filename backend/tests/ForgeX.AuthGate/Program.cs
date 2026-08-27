// Stage 8.2 authorization matrix gate (退役 Partner SSO 后的收敛矩阵:
// 租户隔离「匿名/API Key/错租户/非 owner/管理员/可信通道」在 C# 侧全部通过).
//
// The gate boots real Kestrel pipelines wired through the SAME middleware and
// endpoint code as ForgeX.Api (CallerContextBoundary.BuildMiddleware, via
// InternalsVisibleTo) and drives every identity class over real HTTP. Canonical
// id derivation is asserted against locally computed sha256 digests — the same
// literals tests/auth-authority.test.js computes in Node, which is what pins the
// two implementations together byte-for-byte.
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Domain;
using ForgeX.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

var checks = new List<object>();
var passed = 0;
var root = Path.Combine(Path.GetTempPath(), "forgex-auth-gate-" + Guid.NewGuid().ToString("N"));
var apps = new List<WebApplication>();

void Check(string name, bool condition, object? actual = null)
{
    checks.Add(new { name, pass = condition, actual = actual?.ToString() });
    if (!condition) throw new InvalidOperationException($"{name} failed: {actual}");
    passed++;
    Console.WriteLine($"  PASS  {name}");
}

static string Sha(string value, int hexChars) =>
    Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..hexChars];

static string Tenant(string caller) => "tn_" + Sha(caller, 32);
static string Owner(string caller) => "ow_" + Sha(caller, 32);

string Origin(WebApplication app) =>
    app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();

const string InternalSecret = "auth-gate-internal-secret-32-bytes-min";
const string AlphaKey = "alpha-key";
const string BetaKey = "beta-key";
const string ReviewKey = "review-key";

try
{
    // ── 被测应用：与 Program.cs 相同的边界中间件 + 回声端点 ─────────────
    async Task<WebApplication> StartApiAsync(Dictionary<string, string?> settings, string secret, string previousSecret)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Configuration.AddInMemoryCollection(settings);
        var app = builder.Build();
        apps.Add(app);
        var directAuth = DirectAuthOptions.FromConfiguration(app.Configuration);
        app.Use(CallerContextBoundary.BuildMiddleware(secret, previousSecret, directAuth));
        app.MapGet("/api/v1/jobs/whoami", (HttpContext context) =>
        {
            var caller = CallerContextBoundary.GetRequired(context);
            return Results.Json(new { tenantId = caller.TenantId, ownerId = caller.OwnerId, trusted = caller.Trusted });
        });
        await app.StartAsync();
        return app;
    }

    using var http = new HttpClient(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false });

    async Task<(HttpResponseMessage Response, string Body)> SendAsync(string origin, HttpMethod method, string pathAndQuery, params (string Name, string Value)[] headers)
    {
        using var request = new HttpRequestMessage(method, origin + pathAndQuery);
        foreach (var (name, value) in headers) request.Headers.TryAddWithoutValidation(name, value);
        var response = await http.SendAsync(request);
        return (response, await response.Content.ReadAsStringAsync());
    }

    static JsonElement Parse(string body) => JsonDocument.Parse(body).RootElement.Clone();

    // ═══ 应用 1：API Key + 审核 key + 内部信任通道 ═══════════════════════════════
    var appFull = await StartApiAsync(new Dictionary<string, string?>
    {
        ["DirectAuth:ApiKeys"] = $"{AlphaKey},{BetaKey}",
        ["DirectAuth:CalibrationReviewKeys"] = $"{ReviewKey},{BetaKey}",
    }, InternalSecret, string.Empty);
    var fullOrigin = Origin(appFull);

    // ── API Key：Bearer 与 X-API-Key 两种携带方式派生同一租户 ──────────────────
    var alphaTenant = Tenant("key:" + Sha(AlphaKey, 8));
    var (_, bearerBody) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("Authorization", $"Bearer {AlphaKey}"));
    Check("apikey-bearer-caller-derivation", Parse(bearerBody).GetProperty("tenantId").GetString() == alphaTenant, bearerBody);
    var (_, headerBody) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("X-API-Key", AlphaKey));
    Check("apikey-header-caller-derivation", Parse(headerBody).GetProperty("tenantId").GetString() == alphaTenant, headerBody);
    Check("apikey-owner-derivation", Parse(bearerBody).GetProperty("ownerId").GetString() == Owner("key:" + Sha(AlphaKey, 8)), bearerBody);
    Check("apikey-direct-identity-not-trusted", !Parse(bearerBody).GetProperty("trusted").GetBoolean(), bearerBody);

    // ── 管理员（校准审核 key）：普通 key 无审核权、审核 key 不隐式获得普通访问 ────
    var directAuthFull = DirectAuthOptions.FromConfiguration(appFull.Configuration);
    Check("admin-config-parses-review-keys", directAuthFull is { ReviewEnabled: true, CalibrationReviewKeys.Count: 2 }, directAuthFull.CalibrationReviewKeys.Count);
    var reviewContext = new Microsoft.AspNetCore.Http.DefaultHttpContext();
    reviewContext.Request.Headers.Authorization = $"Bearer {ReviewKey}";
    Check("admin-review-key-identified",
        DirectCallerAuthentication.IdentifyReviewer(reviewContext.Request, directAuthFull) == Sha(ReviewKey, 8),
        Sha(ReviewKey, 8));
    var ordinaryContext = new Microsoft.AspNetCore.Http.DefaultHttpContext();
    ordinaryContext.Request.Headers.Authorization = $"Bearer {AlphaKey}";
    Check("admin-ordinary-key-has-no-review-rights",
        DirectCallerAuthentication.IdentifyReviewer(ordinaryContext.Request, directAuthFull) is null,
        AlphaKey);
    var overlapContext = new Microsoft.AspNetCore.Http.DefaultHttpContext();
    overlapContext.Request.Headers["X-API-Key"] = BetaKey;
    Check("admin-overlapping-key-same-digest-for-four-eyes",
        DirectCallerAuthentication.IdentifyReviewer(overlapContext.Request, directAuthFull) == Sha(BetaKey, 8),
        Sha(BetaKey, 8));
    // 审核 key 不在普通 key 表内：直连身份按匿名 IP 处理（RequireAuth 未开），不得冒充普通 key 身份
    var (_, reviewOnlyBody) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("Authorization", $"Bearer {ReviewKey}"));
    Check("admin-review-key-grants-no-ordinary-key-identity",
        Parse(reviewOnlyBody).GetProperty("tenantId").GetString() == Tenant("ip:127.0.0.1"),
        reviewOnlyBody);

    // ── 可信 Node 代理通道：优先于直连身份；伪造/畸形上下文拒绝 ─────────────────
    var trustedTenant = "tn_" + new string('a', 32);
    var trustedOwner = "ow_" + new string('1', 32);
    var (_, trustedBody) = await SendAsync(
        fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami",
        ("X-ForgeX-Internal-Token", InternalSecret),
        ("X-ForgeX-Tenant-Id", trustedTenant),
        ("X-ForgeX-Owner-Id", trustedOwner),
        ("Authorization", $"Bearer {AlphaKey}"));
    Check("trusted-node-context-outranks-direct-identities",
        Parse(trustedBody).GetProperty("tenantId").GetString() == trustedTenant &&
        Parse(trustedBody).GetProperty("trusted").GetBoolean(),
        trustedBody);
    var (forgedToken, forgedBody) = await SendAsync(
        fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami",
        ("X-ForgeX-Internal-Token", "browser-forged"),
        ("X-ForgeX-Tenant-Id", trustedTenant),
        ("X-ForgeX-Owner-Id", trustedOwner));
    Check("trusted-forged-token-rejected",
        forgedToken.StatusCode == HttpStatusCode.Unauthorized &&
        Parse(forgedBody).GetProperty("code").GetString() == "internal_auth_required",
        forgedBody);
    var (wrongTenantShape, wrongTenantBody) = await SendAsync(
        fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami",
        ("X-ForgeX-Internal-Token", InternalSecret),
        ("X-ForgeX-Tenant-Id", "tn_UPPER-NOT-CANONICAL"),
        ("X-ForgeX-Owner-Id", trustedOwner));
    Check("wrong-tenant-non-canonical-id-rejected",
        wrongTenantShape.StatusCode == HttpStatusCode.BadRequest &&
        Parse(wrongTenantBody).GetProperty("code").GetString() == "invalid_caller_context",
        wrongTenantBody);

    // ═══ 应用 2：API Key + RequireAuth ═══════════════════════════════════════════
    var appRequire = await StartApiAsync(new Dictionary<string, string?>
    {
        ["DirectAuth:ApiKeys"] = $"{AlphaKey},{BetaKey}",
        ["DirectAuth:RequireAuth"] = "1",
    }, InternalSecret, string.Empty);
    var requireOrigin = Origin(appRequire);

    var (anonRequired, anonRequiredBody) = await SendAsync(requireOrigin, HttpMethod.Get, "/api/v1/jobs/whoami");
    Check("anonymous-rejected-when-auth-required",
        anonRequired.StatusCode == HttpStatusCode.Unauthorized &&
        Parse(anonRequiredBody).GetProperty("code").GetString() == "api_key_required" &&
        Parse(anonRequiredBody).GetProperty("title").GetString() == "需要 API Key：请在 Authorization: Bearer <key> 或 X-API-Key 头中提供",
        anonRequiredBody);
    var (wrongKeyRequired, _) = await SendAsync(requireOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("X-API-Key", "not-a-key"));
    Check("wrong-api-key-rejected-when-auth-required", wrongKeyRequired.StatusCode == HttpStatusCode.Unauthorized, wrongKeyRequired.StatusCode);
    var (_, requiredKeyBody) = await SendAsync(requireOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("Authorization", $"Bearer {BetaKey}"));
    Check("apikey-accepted-when-auth-required",
        Parse(requiredKeyBody).GetProperty("tenantId").GetString() == Tenant("key:" + Sha(BetaKey, 8)),
        requiredKeyBody);
    var noReviewConfig = DirectAuthOptions.FromConfiguration(appRequire.Configuration);
    var reviewOnRequire = new Microsoft.AspNetCore.Http.DefaultHttpContext();
    reviewOnRequire.Request.Headers.Authorization = $"Bearer {ReviewKey}";
    Check("admin-review-disabled-without-config",
        !noReviewConfig.ReviewEnabled &&
        DirectCallerAuthentication.IdentifyReviewer(reviewOnRequire.Request, noReviewConfig) is null,
        noReviewConfig.ReviewEnabled);

    // ═══ 应用 3：匿名 IP 身份（API Key 配置但不强制） ═══════════════════
    var appAnon = await StartApiAsync(new Dictionary<string, string?>
    {
        ["DirectAuth:ApiKeys"] = AlphaKey,
    }, InternalSecret, string.Empty);
    var anonOrigin = Origin(appAnon);

    var anonymousTenant = Tenant("ip:127.0.0.1");
    var (_, anonBody) = await SendAsync(anonOrigin, HttpMethod.Get, "/api/v1/jobs/whoami");
    Check("anonymous-ip-caller-derivation",
        Parse(anonBody).GetProperty("tenantId").GetString() == anonymousTenant &&
        Parse(anonBody).GetProperty("ownerId").GetString() == Owner("ip:127.0.0.1"),
        anonBody);
    var (_, wrongKeyAnonBody) = await SendAsync(anonOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("X-API-Key", "not-a-key"));
    Check("wrong-api-key-degrades-to-anonymous-without-require",
        Parse(wrongKeyAnonBody).GetProperty("tenantId").GetString() == anonymousTenant,
        wrongKeyAnonBody);

    // ═══ 应用 4：零配置（迁移前默认态：本地上下文，边界不拦截） ═════════════════
    var appOpen = await StartApiAsync([], string.Empty, string.Empty);
    var openOrigin = Origin(appOpen);
    var (_, openBody) = await SendAsync(openOrigin, HttpMethod.Get, "/api/v1/jobs/whoami");
    Check("unconfigured-boundary-keeps-local-context",
        Parse(openBody).GetProperty("tenantId").GetString() == "tn_local" &&
        Parse(openBody).GetProperty("ownerId").GetString() == "ow_local",
        openBody);

    // ── RequireAuth 缺 key 时降级（Node auth.js 警告语义） ──────────────────────
    var degraded = new DirectAuthOptions([], requireAuth: true);
    Check("config-require-auth-without-keys-degrades", degraded is { Enabled: false, RequireAuth: false }, degraded.RequireAuth);

    // ═══ 错租户 / 非 owner：资源级隔离（与 JobGate 同一仓储语义，key/ip 派生 id） ══
    var repository = new FileGCodeJobRepository(Path.Combine(root, "jobs"));
    var callerA = DirectCallerAuthentication.FromCallerString("key:" + Sha(AlphaKey, 8));
    var callerB = DirectCallerAuthentication.FromCallerString("key:" + Sha(BetaKey, 8));
    var ipCaller = DirectCallerAuthentication.FromCallerString("ip:127.0.0.1");
    var now = DateTimeOffset.UtcNow;
    var job = new GCodeJobRecord(
        Guid.NewGuid().ToString("N"), null, "auth-matrix-fingerprint", Sha("gcode", 64), 16, new GCodeAnalysisOptions(),
        GCodeJobStatus.Queued, 0, "queued", now, null, null, null, null, null, null, null,
        [new GCodeJobEvent(1, "progress", now, GCodeJobStatus.Queued, 0, "queued")],
        callerA.TenantId, callerA.OwnerId);
    await repository.SaveAsync(job, CancellationToken.None);
    var ownRead = await repository.GetOwnedAsync(callerA.TenantId, callerA.OwnerId, job.Id, CancellationToken.None);
    Check("owner-reads-own-resource", ownRead?.Id == job.Id, ownRead?.Id);
    var crossTenant = await repository.GetOwnedAsync(callerB.TenantId, callerB.OwnerId, job.Id, CancellationToken.None);
    Check("wrong-tenant-resource-hidden", crossTenant is null, crossTenant?.Id);
    var crossOwner = await repository.GetOwnedAsync(callerA.TenantId, ipCaller.OwnerId, job.Id, CancellationToken.None);
    Check("non-owner-same-tenant-resource-hidden", crossOwner is null, crossOwner?.Id);

    // ── 汇总（沿用 JobGate 的 artifact 约定，授权矩阵留 CI 证据） ────────────────
    var report = new
    {
        schemaVersion = "1.0",
        generatedAtUtc = DateTimeOffset.UtcNow,
        matrix = new[] { "anonymous", "api-key", "wrong-tenant", "non-owner", "admin", "trusted-channel" },
        result = "pass",
        passed,
        total = checks.Count,
        checks,
    };
    var artifact = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "artifacts", "auth-matrix.json"));
    Directory.CreateDirectory(Path.GetDirectoryName(artifact)!);
    await File.WriteAllTextAsync(artifact, JsonSerializer.Serialize(report, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
    Console.WriteLine($"Authorization matrix gate PASS: {passed}/{checks.Count}");
    Console.WriteLine(artifact);
}
finally
{
    foreach (var app in apps)
    {
        await app.DisposeAsync();
    }
    if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
}

return 0;
