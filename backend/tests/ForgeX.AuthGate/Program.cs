// Stage 8.2 authorization matrix gate (V2 manual §4.2 exit criterion:
// 租户隔离矩阵「匿名/API Key/SSO/双身份/错租户/非 owner/管理员」在 C# 侧全部通过).
//
// The gate boots real Kestrel pipelines wired through the SAME middleware and
// endpoint code as ForgeX.Api (CallerContextBoundary.BuildMiddleware +
// PartnerSsoEndpoints.Map, via InternalsVisibleTo), plus a fake InfiniSynapse
// partner upstream, and drives every identity class over real HTTP. Canonical id
// derivation is asserted against locally computed sha256 digests — the same
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
const string PublicBase = "https://example.com/projects/forgex";
const string AlphaKey = "alpha-key";
const string BetaKey = "beta-key";
const string ReviewKey = "review-key";

var manualTime = new ManualTimeProvider();

try
{
    // ── 假 InfiniSynapse partner 上游（记录请求体，形状对齐 partner-sso.test.js 的 fakeFetch）──
    var upstreamBodies = new List<string>();
    var upstreamBuilder = WebApplication.CreateBuilder();
    upstreamBuilder.Logging.ClearProviders();
    upstreamBuilder.WebHost.UseUrls("http://127.0.0.1:0");
    var upstream = upstreamBuilder.Build();
    apps.Add(upstream);
    upstream.MapPost("/auth/partner/sessions", async context =>
    {
        using var reader = new StreamReader(context.Request.Body);
        upstreamBodies.Add(await reader.ReadToEndAsync());
        await context.Response.WriteAsJsonAsync(new
        {
            code = 200,
            data = new { entryUrl = "https://app.infinisynapse.cn/auth/entry?session=ps_gate" },
        });
    });
    upstream.MapPost("/auth/partner/token", async context =>
    {
        using var reader = new StreamReader(context.Request.Body);
        upstreamBodies.Add(await reader.ReadToEndAsync());
        await context.Response.WriteAsJsonAsync(new
        {
            code = 200,
            data = new
            {
                user = new { id = "u_1", nickname = "矩阵用户", email = "u@example.com", avatar = "" },
                apiKey = "sk-user-gate",
            },
        });
    });
    await upstream.StartAsync();
    var upstreamOrigin = Origin(upstream);

    // ── 被测应用：与 Program.cs 相同的边界中间件 + SSO 路由 + 回声端点 ─────────────
    async Task<WebApplication> StartApiAsync(Dictionary<string, string?> settings, string secret, string previousSecret, TimeProvider time)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Configuration.AddInMemoryCollection(settings);
        var app = builder.Build();
        apps.Add(app);
        var directAuth = DirectAuthOptions.FromConfiguration(app.Configuration);
        var sso = new PartnerSsoService(
            PartnerSsoOptions.FromConfiguration(app.Configuration),
            app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("AuthGate.PartnerSso"),
            upstreamHandler: null,
            time: time);
        app.Use(CallerContextBoundary.BuildMiddleware(secret, previousSecret, directAuth, sso));
        PartnerSsoEndpoints.Map(app, sso, secret, previousSecret);
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

    static string? SetCookie(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues("Set-Cookie", out var values)
            ? values.FirstOrDefault(value => value.StartsWith(name + "=", StringComparison.Ordinal))
            : null;

    static string CookiePair(string setCookie) => setCookie.Split(';')[0];

    // ═══ 应用 1：SSO + API Key + 审核 key + 内部信任通道（全家桶） ═══════════════
    var appFull = await StartApiAsync(new Dictionary<string, string?>
    {
        ["DirectAuth:ApiKeys"] = $"{AlphaKey},{BetaKey}",
        ["DirectAuth:CalibrationReviewKeys"] = $"{ReviewKey},{BetaKey}",
        ["DirectSso:PartnerApi"] = upstreamOrigin,
        ["DirectSso:ClientId"] = "partner_gate",
        ["DirectSso:ClientSecret"] = "psk_gate",
        ["DirectSso:PublicBase"] = PublicBase,
    }, InternalSecret, string.Empty, manualTime);
    var fullOrigin = Origin(appFull);

    // ── SSO：完整登录流（begin → callback → 会话身份） ──────────────────────────
    var (loginResponse, _) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/auth/infini/login?returnTo=%2Freact%2F");
    Check("sso-login-redirects-to-partner-entry",
        loginResponse.StatusCode == HttpStatusCode.Found &&
        loginResponse.Headers.Location!.ToString().StartsWith("https://app.infinisynapse.cn/", StringComparison.Ordinal),
        loginResponse.Headers.Location);
    var oauthCookie = SetCookie(loginResponse, "fx_oauth");
    Check("sso-oauth-cookie-attributes",
        oauthCookie is not null &&
        oauthCookie.Contains("; Path=/projects/forgex/") &&
        oauthCookie.Contains("; HttpOnly") &&
        oauthCookie.Contains("; SameSite=Lax") &&
        oauthCookie.Contains("; Secure") &&
        oauthCookie.EndsWith("; Max-Age=600", StringComparison.Ordinal),
        oauthCookie);
    var sessionRequest = Parse(upstreamBodies[0]);
    Check("sso-begin-upstream-contract",
        sessionRequest.GetProperty("returnUrl").GetString() == PublicBase + "/api/auth/infini/callback" &&
        sessionRequest.GetProperty("cancelUrl").GetString() == PublicBase + "/react/?login=cancelled" &&
        sessionRequest.GetProperty("state").GetString()!.Length >= 32 &&
        sessionRequest.GetProperty("metadata").GetProperty("integration").GetString() == "partner-sso-b",
        upstreamBodies[0]);
    var state = sessionRequest.GetProperty("state").GetString()!;

    var (badCallback, badCallbackBody) = await SendAsync(
        fullOrigin, HttpMethod.Get, "/api/auth/infini/callback?code=ac_gate&state=forged",
        ("Cookie", CookiePair(oauthCookie!)));
    Check("sso-callback-rejects-forged-state",
        badCallback.StatusCode == HttpStatusCode.BadRequest &&
        Parse(badCallbackBody).GetProperty("error").GetString() == "登录回调校验失败，请重新登录",
        badCallbackBody);

    // Node parity：nonce 一次性——伪造 state 已销毁 pending，需重新走 begin。
    var (retryLogin, _) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/auth/infini/login");
    var retryOauthCookie = SetCookie(retryLogin, "fx_oauth")!;
    var retryState = Parse(upstreamBodies[^1]).GetProperty("state").GetString()!;
    Check("sso-default-return-path-cancel-url",
        Parse(upstreamBodies[^1]).GetProperty("cancelUrl").GetString() == PublicBase + "/?login=cancelled",
        upstreamBodies[^1]);
    var (callbackResponse, _) = await SendAsync(
        fullOrigin, HttpMethod.Get, $"/api/auth/infini/callback?code=ac_gate&state={retryState}",
        ("Cookie", CookiePair(retryOauthCookie)));
    Check("sso-callback-success-redirect",
        callbackResponse.StatusCode == HttpStatusCode.Found &&
        callbackResponse.Headers.Location!.ToString() == PublicBase + "/?login=success",
        callbackResponse.Headers.Location);
    var tokenRequest = Parse(upstreamBodies[^1]);
    Check("sso-token-exchange-contract",
        tokenRequest.GetProperty("code").GetString() == "ac_gate" &&
        tokenRequest.GetProperty("grant_type").GetString() == "authorization_code" &&
        tokenRequest.GetProperty("withApiKey").GetBoolean(),
        upstreamBodies[^1]);
    var sessionCookie = SetCookie(callbackResponse, "fx_session")!;
    var clearedOauth = SetCookie(callbackResponse, "fx_oauth")!;
    Check("sso-callback-sets-session-and-clears-nonce",
        sessionCookie.EndsWith("; Max-Age=604800", StringComparison.Ordinal) &&
        clearedOauth.EndsWith("; Max-Age=0", StringComparison.Ordinal),
        sessionCookie);
    var fxSession = CookiePair(sessionCookie);

    var infiniTenant = Tenant("infini:u_1");
    var (ssoWhoami, ssoWhoamiBody) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("Cookie", fxSession));
    Check("sso-session-caller-derivation",
        ssoWhoami.StatusCode == HttpStatusCode.OK &&
        Parse(ssoWhoamiBody).GetProperty("tenantId").GetString() == infiniTenant &&
        Parse(ssoWhoamiBody).GetProperty("ownerId").GetString() == Owner("infini:u_1") &&
        !Parse(ssoWhoamiBody).GetProperty("trusted").GetBoolean(),
        ssoWhoamiBody);

    var (_, meBody) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/auth/infini/me", ("Cookie", fxSession));
    var me = Parse(meBody);
    Check("sso-me-hides-api-key",
        me.GetProperty("authenticated").GetBoolean() &&
        me.GetProperty("canUseAi").GetBoolean() &&
        me.GetProperty("user").GetProperty("id").GetString() == "u_1" &&
        !meBody.Contains("apiKey", StringComparison.OrdinalIgnoreCase),
        meBody);

    // ── 双身份：有效 SSO 会话优先于有效 API Key（Node resolveIdentity 顺序） ──────
    var (_, dualBody) = await SendAsync(
        fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami",
        ("Cookie", fxSession), ("Authorization", $"Bearer {AlphaKey}"));
    Check("dual-identity-sso-outranks-api-key",
        Parse(dualBody).GetProperty("tenantId").GetString() == infiniTenant,
        dualBody);

    // ── API Key：SSO 启用时服务调用仍走 key 身份（Bearer 与 X-API-Key 两种携带） ──
    var alphaTenant = Tenant("key:" + Sha(AlphaKey, 8));
    var (_, bearerBody) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("Authorization", $"Bearer {AlphaKey}"));
    Check("apikey-bearer-caller-derivation", Parse(bearerBody).GetProperty("tenantId").GetString() == alphaTenant, bearerBody);
    var (_, headerBody) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("X-API-Key", AlphaKey));
    Check("apikey-header-caller-derivation", Parse(headerBody).GetProperty("tenantId").GetString() == alphaTenant, headerBody);

    // ── 匿名：SSO 启用后匿名请求直接 401（Node identity.js 语义与文案） ──────────
    var (anonSso, anonSsoBody) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami");
    Check("anonymous-rejected-when-sso-enabled",
        anonSso.StatusCode == HttpStatusCode.Unauthorized &&
        Parse(anonSsoBody).GetProperty("code").GetString() == "sso_or_api_key_required" &&
        Parse(anonSsoBody).GetProperty("title").GetString() == "请使用 InfiniSynapse 登录或提供有效 API Key",
        anonSsoBody);
    var (wrongKeySso, _) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("X-API-Key", "not-a-key"));
    Check("wrong-api-key-rejected-when-sso-enabled", wrongKeySso.StatusCode == HttpStatusCode.Unauthorized, wrongKeySso.StatusCode);

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
    var (reviewOnly, _) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("Authorization", $"Bearer {ReviewKey}"));
    Check("admin-review-key-grants-no-ordinary-access", reviewOnly.StatusCode == HttpStatusCode.Unauthorized, reviewOnly.StatusCode);

    // ── 可信 Node 代理通道：优先于直连身份；伪造/畸形上下文拒绝 ─────────────────
    var trustedTenant = "tn_" + new string('a', 32);
    var trustedOwner = "ow_" + new string('1', 32);
    var (_, trustedBody) = await SendAsync(
        fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami",
        ("X-ForgeX-Internal-Token", InternalSecret),
        ("X-ForgeX-Tenant-Id", trustedTenant),
        ("X-ForgeX-Owner-Id", trustedOwner),
        ("Cookie", fxSession));
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

    // ── 内部会话解析端点（Node 迁移代理的身份反查通道） ─────────────────────────
    var sessionToken = Uri.UnescapeDataString(fxSession["fx_session=".Length..]);
    var (resolveOk, resolveBody) = await SendAsync(
        fullOrigin, HttpMethod.Get, "/api/v1/auth/infini/session",
        ("X-ForgeX-Internal-Token", InternalSecret),
        ("X-ForgeX-Session-Token", sessionToken));
    Check("session-resolve-returns-user-and-api-key",
        resolveOk.StatusCode == HttpStatusCode.OK &&
        Parse(resolveBody).GetProperty("user").GetProperty("id").GetString() == "u_1" &&
        Parse(resolveBody).GetProperty("apiKey").GetString() == "sk-user-gate",
        resolveBody);
    var (resolveNoToken, _) = await SendAsync(
        fullOrigin, HttpMethod.Get, "/api/v1/auth/infini/session",
        ("X-ForgeX-Session-Token", sessionToken));
    Check("session-resolve-requires-internal-token", resolveNoToken.StatusCode == HttpStatusCode.Unauthorized, resolveNoToken.StatusCode);
    var (resolveUnknown, _) = await SendAsync(
        fullOrigin, HttpMethod.Get, "/api/v1/auth/infini/session",
        ("X-ForgeX-Internal-Token", InternalSecret),
        ("X-ForgeX-Session-Token", "unknown-token"));
    Check("session-resolve-unknown-token-404", resolveUnknown.StatusCode == HttpStatusCode.NotFound, resolveUnknown.StatusCode);

    // ── 过期会话：TTL 走完后按未登录处理（V1 §7.3 矩阵的“过期会话”行） ──────────
    manualTime.Advance(TimeSpan.FromDays(8));
    var (expiredWhoami, _) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("Cookie", fxSession));
    Check("expired-session-falls-back-to-401", expiredWhoami.StatusCode == HttpStatusCode.Unauthorized, expiredWhoami.StatusCode);
    var (_, expiredMeBody) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/auth/infini/me", ("Cookie", fxSession));
    Check("expired-session-me-reports-unauthenticated",
        !Parse(expiredMeBody).GetProperty("authenticated").GetBoolean() &&
        expiredMeBody.Contains("\"user\":null", StringComparison.Ordinal),
        expiredMeBody);

    // ── 登出：清会话 + 清 cookie（重新登录后执行） ──────────────────────────────
    var (relogin, _) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/auth/infini/login");
    var reloginState = Parse(upstreamBodies[^1]).GetProperty("state").GetString()!;
    var (recallback, _) = await SendAsync(
        fullOrigin, HttpMethod.Get, $"/api/auth/infini/callback?code=ac_gate&state={reloginState}",
        ("Cookie", CookiePair(SetCookie(relogin, "fx_oauth")!)));
    var freshSession = CookiePair(SetCookie(recallback, "fx_session")!);
    var (logoutResponse, logoutBody) = await SendAsync(fullOrigin, HttpMethod.Post, "/api/auth/infini/logout", ("Cookie", freshSession));
    Check("sso-logout-clears-session",
        logoutResponse.StatusCode == HttpStatusCode.OK &&
        Parse(logoutBody).GetProperty("ok").GetBoolean() &&
        SetCookie(logoutResponse, "fx_session")!.EndsWith("; Max-Age=0", StringComparison.Ordinal),
        logoutBody);
    var (afterLogout, _) = await SendAsync(fullOrigin, HttpMethod.Get, "/api/v1/jobs/whoami", ("Cookie", freshSession));
    Check("sso-logged-out-session-rejected", afterLogout.StatusCode == HttpStatusCode.Unauthorized, afterLogout.StatusCode);

    // ═══ 应用 2：仅 API Key + RequireAuth（SSO 未配置 = Node 未配置态） ══════════
    var appRequire = await StartApiAsync(new Dictionary<string, string?>
    {
        ["DirectAuth:ApiKeys"] = $"{AlphaKey},{BetaKey}",
        ["DirectAuth:RequireAuth"] = "1",
    }, InternalSecret, string.Empty, TimeProvider.System);
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

    var (ssoDisabledLogin, ssoDisabledLoginBody) = await SendAsync(requireOrigin, HttpMethod.Get, "/api/auth/infini/login");
    Check("sso-unconfigured-login-503",
        ssoDisabledLogin.StatusCode == HttpStatusCode.ServiceUnavailable &&
        Parse(ssoDisabledLoginBody).GetProperty("error").GetString() == "InfiniSynapse 登录尚未配置",
        ssoDisabledLoginBody);
    var (_, ssoDisabledMeBody) = await SendAsync(requireOrigin, HttpMethod.Get, "/api/auth/infini/me");
    Check("sso-unconfigured-me-reports-disabled",
        !Parse(ssoDisabledMeBody).GetProperty("enabled").GetBoolean() &&
        !Parse(ssoDisabledMeBody).GetProperty("authenticated").GetBoolean(),
        ssoDisabledMeBody);
    var noReviewConfig = DirectAuthOptions.FromConfiguration(appRequire.Configuration);
    var reviewOnRequire = new Microsoft.AspNetCore.Http.DefaultHttpContext();
    reviewOnRequire.Request.Headers.Authorization = $"Bearer {ReviewKey}";
    Check("admin-review-disabled-without-config",
        !noReviewConfig.ReviewEnabled &&
        DirectCallerAuthentication.IdentifyReviewer(reviewOnRequire.Request, noReviewConfig) is null,
        noReviewConfig.ReviewEnabled);

    // ═══ 应用 3：匿名 IP 身份（API Key 配置但不强制；SSO 关） ═══════════════════
    var appAnon = await StartApiAsync(new Dictionary<string, string?>
    {
        ["DirectAuth:ApiKeys"] = AlphaKey,
    }, InternalSecret, string.Empty, TimeProvider.System);
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
    var appOpen = await StartApiAsync([], string.Empty, string.Empty, TimeProvider.System);
    var openOrigin = Origin(appOpen);
    var (_, openBody) = await SendAsync(openOrigin, HttpMethod.Get, "/api/v1/jobs/whoami");
    Check("unconfigured-boundary-keeps-local-context",
        Parse(openBody).GetProperty("tenantId").GetString() == "tn_local" &&
        Parse(openBody).GetProperty("ownerId").GetString() == "ow_local",
        openBody);

    // ── RequireAuth 缺 key 时降级（Node auth.js 警告语义） ──────────────────────
    var degraded = new DirectAuthOptions([], requireAuth: true);
    Check("config-require-auth-without-keys-degrades", degraded is { Enabled: false, RequireAuth: false }, degraded.RequireAuth);

    // ═══ 错租户 / 非 owner：资源级隔离（与 JobGate 同一仓储语义，SSO/key 派生 id） ══
    var repository = new FileGCodeJobRepository(Path.Combine(root, "jobs"));
    var infiniA = DirectCallerAuthentication.FromCallerString("infini:u_1");
    var infiniB = DirectCallerAuthentication.FromCallerString("infini:u_2");
    var keyCaller = DirectCallerAuthentication.FromCallerString("key:" + Sha(AlphaKey, 8));
    var now = DateTimeOffset.UtcNow;
    var job = new GCodeJobRecord(
        Guid.NewGuid().ToString("N"), null, "auth-matrix-fingerprint", Sha("gcode", 64), 16, new GCodeAnalysisOptions(),
        GCodeJobStatus.Queued, 0, "queued", now, null, null, null, null, null, null, null,
        [new GCodeJobEvent(1, "progress", now, GCodeJobStatus.Queued, 0, "queued")],
        infiniA.TenantId, infiniA.OwnerId);
    await repository.SaveAsync(job, CancellationToken.None);
    var ownRead = await repository.GetOwnedAsync(infiniA.TenantId, infiniA.OwnerId, job.Id, CancellationToken.None);
    Check("owner-reads-own-resource", ownRead?.Id == job.Id, ownRead?.Id);
    var crossTenant = await repository.GetOwnedAsync(infiniB.TenantId, infiniB.OwnerId, job.Id, CancellationToken.None);
    Check("wrong-tenant-resource-hidden", crossTenant is null, crossTenant?.Id);
    var crossOwner = await repository.GetOwnedAsync(infiniA.TenantId, keyCaller.OwnerId, job.Id, CancellationToken.None);
    Check("non-owner-same-tenant-resource-hidden", crossOwner is null, crossOwner?.Id);

    // ── 汇总（沿用 JobGate 的 artifact 约定，授权矩阵留 CI 证据） ────────────────
    var report = new
    {
        schemaVersion = "1.0",
        generatedAtUtc = DateTimeOffset.UtcNow,
        matrix = new[] { "anonymous", "api-key", "sso", "dual-identity", "wrong-tenant", "non-owner", "admin" },
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

/// <summary>可推进的时钟：驱动 PartnerSsoService 的会话/nonce TTL（过期会话矩阵行）。</summary>
internal sealed class ManualTimeProvider : TimeProvider
{
    private DateTimeOffset _utcNow = DateTimeOffset.UtcNow;

    public override DateTimeOffset GetUtcNow() => _utcNow;

    public void Advance(TimeSpan by) => _utcNow += by;
}
