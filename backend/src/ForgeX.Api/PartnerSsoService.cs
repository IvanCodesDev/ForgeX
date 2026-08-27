using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.2 (work item 2 of V2 §4.2): InfiniSynapse Partner SSO migrated from
/// server/services/partner-sso.js so ForgeX.Api owns the login session store.
/// Flow, cookie shapes, status codes and message strings mirror the Node
/// implementation byte-for-byte:
///   GET  /api/auth/infini/login    → create partner login session, 302 to entryUrl
///   GET  /api/auth/infini/callback → exchange code, set fx_session cookie
///   GET  /api/auth/infini/me       → session status (never exposes apiKey)
///   POST /api/auth/infini/logout   → drop session, clear cookie
/// These four routes intentionally answer with Node's plain JSON envelope
/// ({"error": message}) instead of problem+json: during migration the Node
/// proxy streams responses through unchanged, so the browser contract must not
/// change when AUTH_AUTHORITY flips to csharp.
/// </summary>
internal sealed class PartnerSsoOptions
{
    public PartnerSsoOptions(string partnerApi, string clientId, string clientSecret, string publicBase, long loginSessionTtlMs)
    {
        PartnerApi = partnerApi;
        ClientId = clientId;
        ClientSecret = clientSecret;
        PublicBase = publicBase;
        LoginSessionTtlMs = loginSessionTtlMs;
        // Node parity (partner-sso.js): enabled only with client credentials AND a public base.
        Enabled = clientId.Length > 0 && clientSecret.Length > 0 && publicBase.Length > 0;
    }

    public string PartnerApi { get; }
    public string ClientId { get; }
    public string ClientSecret { get; }
    public string PublicBase { get; }
    public long LoginSessionTtlMs { get; }
    public bool Enabled { get; }

    public static PartnerSsoOptions FromConfiguration(IConfiguration configuration)
    {
        var ttl = configuration["DirectSso:LoginSessionTtlMs"];
        return new PartnerSsoOptions(
            configuration["DirectSso:PartnerApi"] ?? "https://api.infinisynapse.cn/api",
            configuration["DirectSso:ClientId"] ?? string.Empty,
            configuration["DirectSso:ClientSecret"] ?? string.Empty,
            configuration["DirectSso:PublicBase"] ?? string.Empty,
            long.TryParse(ttl, out var parsed) && parsed > 0 ? parsed : 7L * 24 * 60 * 60 * 1000);
    }
}

internal sealed record PartnerSsoUser(string Id, string Nickname, string Email, string Avatar);

internal sealed record PartnerSsoSession(string Token, PartnerSsoUser User, string ApiKey);

internal sealed partial class PartnerSsoService : IDisposable
{
    private const long OAuthTtlMs = 10 * 60 * 1000;

    // Node envelope: sendJson keeps null fields, so the me() payload must not drop "user": null.
    private static readonly JsonSerializerOptions NodeJson = new(JsonSerializerDefaults.Web);

    private sealed record PendingLogin(string State, string ReturnPath, long CreatedAtMs);

    private sealed record SessionRecord(PartnerSsoUser User, string ApiKey, long ExpiresAtMs);

    private readonly PartnerSsoOptions _options;
    private readonly ILogger _logger;
    private readonly HttpClient _http;
    private readonly TimeProvider _time;
    private readonly ConcurrentDictionary<string, PendingLogin> _pending = new();
    private readonly ConcurrentDictionary<string, SessionRecord> _sessions = new();
    private readonly Timer? _sweeper;
    private readonly string _cookiePath;
    private readonly bool _secure;

    public PartnerSsoService(PartnerSsoOptions options, ILogger logger, HttpMessageHandler? upstreamHandler = null, TimeProvider? time = null)
    {
        _options = options;
        _logger = logger;
        _http = upstreamHandler is null ? new HttpClient() : new HttpClient(upstreamHandler);
        _time = time ?? TimeProvider.System;
        _cookiePath = PublicPath(options.PublicBase);
        _secure = options.PublicBase.StartsWith("https:", StringComparison.OrdinalIgnoreCase);
        if (options.Enabled)
        {
            // Node parity: server/index.js sweeps every 60 s; expired reads are also dropped lazily.
            _sweeper = new Timer(_ => Sweep(NowMs()), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
        }
    }

    public bool Enabled => _options.Enabled;

    private long NowMs() => _time.GetUtcNow().ToUnixTimeMilliseconds();

    // ── partner-sso.js helpers, ported verbatim ────────────────────────────────

    /// <summary>Node cookies(): split on ';', first '=', trim, decodeURIComponent.</summary>
    internal static string ReadCookie(HttpRequest request, string name)
    {
        foreach (var part in request.Headers.Cookie.ToString().Split(';'))
        {
            var separator = part.IndexOf('=');
            if (separator <= 0) continue;
            if (!string.Equals(part[..separator].Trim(), name, StringComparison.Ordinal)) continue;
            return Uri.UnescapeDataString(part[(separator + 1)..].Trim());
        }
        return string.Empty;
    }

    /// <summary>Node publicPath(): pathname of PUBLIC_BASE with a trailing slash, "/" on parse failure.</summary>
    internal static string PublicPath(string publicBase)
    {
        if (!Uri.TryCreate(publicBase, UriKind.Absolute, out var parsed)) return "/";
        var path = parsed.AbsolutePath.Length > 0 ? parsed.AbsolutePath : "/";
        return path.EndsWith('/') ? path : path + "/";
    }

    /// <summary>Node safeReturnPath(): only the two published entries, everything else "/".</summary>
    internal static string SafeReturnPath(string? value)
    {
        var raw = (value ?? string.Empty).Trim();
        return raw is "/react" or "/react/" ? "/react/" : "/";
    }

    private static string LoginResultUrl(string trimmedBase, string returnPath, string result) =>
        trimmedBase + SafeReturnPath(returnPath) + "?login=" + Uri.EscapeDataString(result);

    /// <summary>Node _cookie(): fixed attribute order name/Path/HttpOnly/SameSite/Secure/Max-Age.</summary>
    private string BuildCookie(string name, string value, long? maxAgeSeconds)
    {
        var builder = new StringBuilder()
            .Append(name).Append('=').Append(Uri.EscapeDataString(value))
            .Append("; Path=").Append(_cookiePath)
            .Append("; HttpOnly; SameSite=Lax");
        if (_secure) builder.Append("; Secure");
        if (maxAgeSeconds is not null) builder.Append("; Max-Age=").Append(Math.Max(0, maxAgeSeconds.Value));
        return builder.ToString();
    }

    /// <summary>partner-sso.js safeEqual: strict length match + constant-time comparison.</summary>
    private static bool SafeEqual(string a, string b)
    {
        var left = Encoding.UTF8.GetBytes(a);
        var right = Encoding.UTF8.GetBytes(b);
        return left.Length == right.Length && CryptographicOperations.FixedTimeEquals(left, right);
    }

    private static string RandomHex24() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(24));

    private static string RandomBase64Url32()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    [GeneratedRegex(@"^https://app\.infinisynapse\.(cn|com)/", RegexOptions.IgnoreCase)]
    private static partial Regex EntryUrlPattern();

    // ── upstream calls (partner-sso.js _post) ──────────────────────────────────

    private sealed class UpstreamRejectedException : Exception
    {
    }

    /// <summary>
    /// POST to the partner API with client credentials. Mirrors _post(): any
    /// non-OK status, non-JSON body, code != 200 or missing data throws the
    /// Node 502 "InfiniSynapse 登录服务暂时不可用" path.
    /// </summary>
    private async Task<JsonElement> PostUpstreamAsync(string path, object payload, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        HttpResponseMessage response;
        string body;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, _options.PartnerApi.TrimEnd('/') + path);
            request.Headers.TryAddWithoutValidation("X-Client-Id", _options.ClientId);
            request.Headers.TryAddWithoutValidation("X-Client-Secret", _options.ClientSecret);
            request.Content = new StringContent(JsonSerializer.Serialize(payload, NodeJson), Encoding.UTF8);
            // Node 发送的是不带 charset 的 "application/json"，保持线上字节一致。
            request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
            response = await _http.SendAsync(request, timeout.Token);
            body = await response.Content.ReadAsStringAsync(timeout.Token);
        }
        catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException or IOException)
        {
            _logger.LogWarning("partner sso upstream rejected: path={Path} status=0 message={Message}", path, exception.Message);
            throw new UpstreamRejectedException();
        }

        JsonElement envelope = default;
        var parsed = false;
        try
        {
            using var document = JsonDocument.Parse(body);
            envelope = document.RootElement.Clone();
            parsed = envelope.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            // Node: res.json().catch(() => null) — treated below as an invalid response.
        }

        if (!response.IsSuccessStatusCode || !parsed ||
            !envelope.TryGetProperty("code", out var code) || code.ValueKind != JsonValueKind.Number || code.GetInt32() != 200 ||
            !envelope.TryGetProperty("data", out var data) || data.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            var message = parsed && envelope.TryGetProperty("message", out var upstreamMessage) && upstreamMessage.ValueKind == JsonValueKind.String
                ? upstreamMessage.GetString()!
                : "invalid response";
            _logger.LogWarning(
                "partner sso upstream rejected: path={Path} status={Status} message={Message}",
                path,
                (int)response.StatusCode,
                message.Length > 160 ? message[..160] : message);
            response.Dispose();
            throw new UpstreamRejectedException();
        }

        response.Dispose();
        return data;
    }

    // ── HTTP handlers (Node envelope, Node status codes, Node 文案) ────────────

    private static Task WriteNodeJsonAsync(HttpContext context, int status, object payload)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(payload, NodeJson);
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength = body.Length;
        return context.Response.Body.WriteAsync(body, 0, body.Length, context.RequestAborted);
    }

    private static Task WriteNodeErrorAsync(HttpContext context, int status, string message) =>
        WriteNodeJsonAsync(context, status, new { error = message });

    public async Task BeginAsync(HttpContext context)
    {
        if (!Enabled)
        {
            await WriteNodeErrorAsync(context, 503, "InfiniSynapse 登录尚未配置");
            return;
        }

        var state = RandomHex24();
        var browserNonce = RandomHex24();
        // Node searchParams.get() 取首个出现的值。
        var returnPath = SafeReturnPath(context.Request.Query["returnTo"].FirstOrDefault());
        _pending[browserNonce] = new PendingLogin(state, returnPath, NowMs());

        var trimmedBase = _options.PublicBase.TrimEnd('/');
        JsonElement data;
        try
        {
            data = await PostUpstreamAsync("/auth/partner/sessions", new
            {
                returnUrl = trimmedBase + "/api/auth/infini/callback",
                cancelUrl = LoginResultUrl(trimmedBase, returnPath, "cancelled"),
                state,
                metadata = new { source = "forgex-insight", integration = "partner-sso-b" },
            }, context.RequestAborted);
        }
        catch (UpstreamRejectedException)
        {
            await WriteNodeErrorAsync(context, 502, "InfiniSynapse 登录服务暂时不可用");
            return;
        }

        var entryUrl = data.TryGetProperty("entryUrl", out var entry) && entry.ValueKind == JsonValueKind.String
            ? entry.GetString()!
            : string.Empty;
        if (entryUrl.Length == 0 || !EntryUrlPattern().IsMatch(entryUrl))
        {
            await WriteNodeErrorAsync(context, 502, "InfiniSynapse 返回了无效登录地址");
            return;
        }

        context.Response.StatusCode = 302;
        context.Response.Headers.Location = entryUrl;
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.SetCookie = BuildCookie("fx_oauth", browserNonce, 600);
    }

    public async Task CallbackAsync(HttpContext context)
    {
        if (!Enabled)
        {
            await WriteNodeErrorAsync(context, 503, "InfiniSynapse 登录尚未配置");
            return;
        }

        var code = context.Request.Query["code"].FirstOrDefault() ?? string.Empty;
        var state = context.Request.Query["state"].FirstOrDefault() ?? string.Empty;
        var nonce = ReadCookie(context.Request, "fx_oauth");
        // Node parity: the nonce is single-use — removed even when validation fails.
        _pending.TryRemove(nonce, out var pending);
        if (code.Length == 0 || pending is null || !SafeEqual(state, pending.State) || NowMs() - pending.CreatedAtMs > OAuthTtlMs)
        {
            await WriteNodeErrorAsync(context, 400, "登录回调校验失败，请重新登录");
            return;
        }

        JsonElement data;
        try
        {
            data = await PostUpstreamAsync("/auth/partner/token", new
            {
                code,
                grant_type = "authorization_code",
                withApiKey = true,
            }, context.RequestAborted);
        }
        catch (UpstreamRejectedException)
        {
            await WriteNodeErrorAsync(context, 502, "InfiniSynapse 登录服务暂时不可用");
            return;
        }

        // Node：if (!data.user || !data.user.id) —— JS falsy 语义（0/""/null/false 均视为缺失）。
        var userId = data.TryGetProperty("user", out var user) && user.ValueKind == JsonValueKind.Object
            ? JsTruthyString(user, "id")
            : string.Empty;
        if (userId.Length == 0)
        {
            await WriteNodeErrorAsync(context, 502, "InfiniSynapse 未返回有效用户资料");
            return;
        }

        var token = RandomBase64Url32();
        var nickname = JsTruthyString(user, "nickname");
        if (nickname.Length == 0) nickname = JsTruthyString(user, "username");
        if (nickname.Length == 0) nickname = "InfiniSynapse 用户";
        var apiKey = JsTruthyString(data, "apiKey");
        _sessions[token] = new SessionRecord(
            new PartnerSsoUser(userId, nickname, JsTruthyString(user, "email"), JsTruthyString(user, "avatar")),
            apiKey,
            NowMs() + _options.LoginSessionTtlMs);
        _logger.LogInformation("partner sso login completed: userId={UserId} hasPartnerKey={HasPartnerKey}", userId, apiKey.Length > 0);

        var trimmedBase = _options.PublicBase.TrimEnd('/');
        context.Response.StatusCode = 302;
        context.Response.Headers.Location = LoginResultUrl(trimmedBase, pending.ReturnPath, "success");
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.SetCookie = new Microsoft.Extensions.Primitives.StringValues(
        [
            BuildCookie("fx_session", token, _options.LoginSessionTtlMs / 1000),
            BuildCookie("fx_oauth", string.Empty, 0),
        ]);
    }

    /// <summary>
    /// Node String(x || "")：只有 truthy 值参与字符串化——数字 0、空串、null、false
    /// 一律折叠为空串；非零数字按 JS String() 规则转文本。
    /// </summary>
    private static string JsTruthyString(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var raw)) return string.Empty;
        return raw.ValueKind switch
        {
            JsonValueKind.String => raw.GetString()!,
            JsonValueKind.Number => raw.GetDouble() == 0 ? string.Empty : raw.GetRawText(),
            JsonValueKind.True => "true",
            _ => string.Empty,
        };
    }

    /// <summary>partner-sso.js identity(): fx_session lookup with lazy expiry.</summary>
    public PartnerSsoSession? Identity(HttpRequest request) => IdentityByToken(ReadCookie(request, "fx_session"));

    /// <summary>Token-keyed lookup for the internal session-resolve endpoint (Node migration proxy).</summary>
    public PartnerSsoSession? IdentityByToken(string token)
    {
        if (token.Length == 0 || !_sessions.TryGetValue(token, out var hit)) return null;
        if (hit.ExpiresAtMs <= NowMs())
        {
            _sessions.TryRemove(token, out _);
            return null;
        }
        return new PartnerSsoSession(token, hit.User, hit.ApiKey);
    }

    public Task MeAsync(HttpContext context)
    {
        var hit = Identity(context.Request);
        return WriteNodeJsonAsync(context, 200, new
        {
            enabled = Enabled,
            authenticated = hit is not null,
            user = hit?.User,
            canUseAi = hit is { ApiKey.Length: > 0 },
            integration = "InfiniSynapse Partner SSO (B)",
        });
    }

    public Task LogoutAsync(HttpContext context)
    {
        var hit = Identity(context.Request);
        if (hit is not null) _sessions.TryRemove(hit.Token, out _);
        context.Response.Headers.SetCookie = BuildCookie("fx_session", string.Empty, 0);
        return WriteNodeJsonAsync(context, 200, new { ok = true });
    }

    public void Sweep(long nowMs)
    {
        foreach (var (key, value) in _pending)
        {
            if (nowMs - value.CreatedAtMs > OAuthTtlMs) _pending.TryRemove(key, out _);
        }
        foreach (var (key, value) in _sessions)
        {
            if (value.ExpiresAtMs <= nowMs) _sessions.TryRemove(key, out _);
        }
    }

    public void Dispose()
    {
        _sweeper?.Dispose();
        _http.Dispose();
    }
}
