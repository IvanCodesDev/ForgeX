// Stage 8 work item 5 static-hosting parity gate (V2 manual §4.2「静态托管」).
//
// The gate boots real Kestrel pipelines wired through the SAME middleware code as
// ForgeX.Api (CallerContextBoundary.BuildMiddleware + StaticFileHosting.BuildMiddleware,
// via InternalsVisibleTo) over fixture static roots, and asserts the Node behavior
// contract from server/lib/http.js rule for rule: entry mapping (/ → dist/react with
// classic fallback, /legacy, /react + /react/assets/*), the deny-by-default allowlist,
// MIME + cache headers, HEAD handling, strict raw-target normalization guards
// (dot segments / backslashes / control chars checked BEFORE any folding — the
// Stage 7.1 commit 724c85a contract), directory-listing refusal, endpoint priority and
// the CallerContext boundary staying out of static paths. Nasty request targets are
// sent over a raw TCP socket so no client-side URL normalization can launder them.
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using ForgeX.Api;
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
var fixtureRoot = Path.Combine(Path.GetTempPath(), "forgex-static-gate-" + Guid.NewGuid().ToString("N"));
var apps = new List<WebApplication>();

void Check(string name, bool condition, object? actual = null)
{
    checks.Add(new { name, pass = condition, actual = actual?.ToString() });
    if (!condition) throw new InvalidOperationException($"{name} failed: {actual}");
    passed++;
    Console.WriteLine($"  PASS  {name}");
}

string Origin(WebApplication app) =>
    app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();

const string InternalSecret = "static-gate-internal-secret-32-bytes-x";
const string NotFoundJson = /*lang=json,strict*/ "{\"error\":\"资源不存在\"}";
const string BadPathJson = /*lang=json,strict*/ "{\"error\":\"路径不合法\"}";
const string ReactIndexFixture = "<!doctype html><title>React fixture</title>";
const string ClassicIndexFixture = "<!doctype html><title>Classic fixture</title>FORGE·X classic";
const string ReactAssetFixture = "globalThis.__REACT_FIXTURE__=true;";

try
{
    // ── 固件静态根：与 tests/server.test.js 的 Node 侧固件同构 ────────────────────
    void WriteFixture(string root, string relativePath, string content)
    {
        var target = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.WriteAllText(target, content, new UTF8Encoding(false));
    }

    var fullRoot = Path.Combine(fixtureRoot, "full");
    WriteFixture(fullRoot, "index.html", ClassicIndexFixture);
    WriteFixture(fullRoot, "README.md", "# fixture readme");
    WriteFixture(fullRoot, "frontend/classic/css/style.css", "body{--fixture:classic}");
    WriteFixture(fullRoot, "frontend/classic/css/blob.bin", "binary-fixture");
    WriteFixture(fullRoot, "frontend/classic/js/util.js", "globalThis.FXU={fixture:true};");
    WriteFixture(fullRoot, "contracts/profiles/example-bundle.json", "{\"format\":\"forgex-profile-bundle\"}");
    WriteFixture(fullRoot, "contracts/profiles/profile-bundle.schema.json", "{\"$id\":\"profile-schema\"}");
    WriteFixture(fullRoot, "contracts/calibration/example-bundle.json", "{\"format\":\"forgex-calibration-bundle\"}");
    WriteFixture(fullRoot, "contracts/calibration/calibration-bundle.schema.json", "{\"$id\":\"calibration-schema\"}");
    WriteFixture(fullRoot, "contracts/validation/fixture-manifest.json", "{\"fixture\":true}");
    WriteFixture(fullRoot, "contracts/validation/time-calibration-report.json", "{\"report\":true}");
    WriteFixture(fullRoot, "dist/react/index.html", ReactIndexFixture);
    WriteFixture(fullRoot, "dist/react/index.html.map", "{}");
    WriteFixture(fullRoot, "dist/react/assets/app-abc123.js", ReactAssetFixture);
    WriteFixture(fullRoot, "dist/react/assets/nested/deep.css", ".deep{--fixture:nested}");
    WriteFixture(fullRoot, "server/.env", "SECRET=never-served");
    WriteFixture(fullRoot, "server/index.js", "// server runtime fixture");
    WriteFixture(fullRoot, ".env", "ROOT_SECRET=never-served");
    WriteFixture(fullRoot, "package.json", "{}");

    // 无 dist 构建产物的根：验证「产物缺失回落经典入口」契约。
    var noDistRoot = Path.Combine(fixtureRoot, "no-dist");
    WriteFixture(noDistRoot, "index.html", ClassicIndexFixture);

    // ── 配置面：默认零变化 + 启用校验 ────────────────────────────────────────────
    static IConfiguration Config(params (string Key, string? Value)[] pairs)
    {
        var builder = new ConfigurationBuilder();
        builder.AddInMemoryCollection(pairs.ToDictionary(static pair => pair.Key, static pair => pair.Value));
        return builder.Build();
    }

    var defaults = StaticHostingOptions.FromConfiguration(Config(), fixtureRoot);
    Check("config-default-disabled", !defaults.Enabled && defaults.RootFullPath.Length == 0, defaults.Enabled);

    static string? Throws(Action action)
    {
        try
        {
            action();
            return null;
        }
        catch (InvalidOperationException exception)
        {
            return exception.Message;
        }
    }

    Check("config-invalid-enabled-rejected",
        Throws(() => StaticHostingOptions.FromConfiguration(Config(("StaticHosting:Enabled", "maybe")), fixtureRoot))
            is { } invalidMessage && invalidMessage.Contains("StaticHosting:Enabled"),
        "maybe");
    Check("config-enabled-requires-root",
        Throws(() => StaticHostingOptions.FromConfiguration(Config(("StaticHosting:Enabled", "1")), fixtureRoot))
            is { } missingMessage && missingMessage.Contains("StaticHosting:Root"),
        "root missing");
    Check("config-root-must-exist",
        Throws(() => StaticHostingOptions.FromConfiguration(
            Config(("StaticHosting:Enabled", "true"), ("StaticHosting:Root", Path.Combine(fixtureRoot, "nope"))), fixtureRoot))
            is { } absentMessage && absentMessage.Contains("does not exist"),
        "root absent");

    // ── 被测应用：与 Program.cs 相同的接线顺序（边界中间件 → 静态中间件 → 端点） ──
    async Task<WebApplication> StartAppAsync(string? staticRoot, string internalSecret)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var settings = new Dictionary<string, string?>();
        if (staticRoot is not null)
        {
            settings["StaticHosting:Enabled"] = "1";
            settings["StaticHosting:Root"] = staticRoot;
        }
        builder.Configuration.AddInMemoryCollection(settings);
        var app = builder.Build();
        apps.Add(app);
        app.Use(CallerContextBoundary.BuildMiddleware(internalSecret, string.Empty));
        var options = StaticHostingOptions.FromConfiguration(app.Configuration, app.Environment.ContentRootPath);
        if (options.Enabled)
        {
            app.Use(StaticFileHosting.BuildMiddleware(options));
        }
        app.MapGet("/healthz", static () => Results.Json(new { ok = true, source = "endpoint" }));
        app.MapGet("/share/{token}", static (string token) => Results.Text("share-endpoint:" + token, "text/html; charset=utf-8"));
        app.MapGet("/api/v1/jobs/{id}", static (HttpContext context, string id) =>
        {
            var caller = CallerContextBoundary.GetRequired(context);
            return Results.Json(new { id, tenantId = caller.TenantId });
        });
        await app.StartAsync();
        return app;
    }

    using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });

    async Task<(HttpResponseMessage Response, string Body)> SendAsync(string origin, string pathAndQuery, HttpMethod? method = null)
    {
        using var request = new HttpRequestMessage(method ?? HttpMethod.Get, origin + pathAndQuery);
        var response = await http.SendAsync(request);
        return (response, await response.Content.ReadAsStringAsync());
    }

    // 原始 TCP 请求：绕过一切客户端 URL 规范化，把 request-target 逐字节交给 Kestrel。
    async Task<(int Status, Dictionary<string, string> Headers, string Body)> RawAsync(string origin, string requestTarget, string method = "GET")
    {
        var uri = new Uri(origin);
        using var client = new TcpClient();
        await client.ConnectAsync(uri.Host, uri.Port);
        await using var stream = client.GetStream();
        var head = $"{method} {requestTarget} HTTP/1.1\r\nHost: {uri.Host}:{uri.Port}\r\nConnection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(head));
        using var memory = new MemoryStream();
        await stream.CopyToAsync(memory);
        var raw = Encoding.UTF8.GetString(memory.ToArray());
        var split = raw.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        var headerBlock = split >= 0 ? raw[..split] : raw;
        var body = split >= 0 ? raw[(split + 4)..] : string.Empty;
        var lines = headerBlock.Split("\r\n");
        var status = int.Parse(lines[0].Split(' ')[1], CultureInfo.InvariantCulture);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon > 0) headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
        }
        return (status, headers, body);
    }

    // ═══ 应用 1：无静态托管（未配置 = 与迁移前完全一致的零默认变化基线） ═══════════
    var baseline = await StartAppAsync(staticRoot: null, internalSecret: string.Empty);
    var baselineOrigin = Origin(baseline);
    var (baselineRoot, baselineRootBody) = await SendAsync(baselineOrigin, "/");
    Check("baseline-root-404-without-static",
        baselineRoot.StatusCode == HttpStatusCode.NotFound && !baselineRootBody.Contains("资源不存在"),
        $"{(int)baselineRoot.StatusCode} body={baselineRootBody}");

    // ═══ 应用 2：静态托管 + 已配置内部密钥（静态面必须完全不卷入鉴权边界） ═════════
    var appFull = await StartAppAsync(fullRoot, InternalSecret);
    var origin = Origin(appFull);

    // ── 入口映射（Stage 7.1 契约） ────────────────────────────────────────────────
    var (rootEntry, rootBody) = await SendAsync(origin, "/");
    Check("root-serves-react-index",
        rootEntry.StatusCode == HttpStatusCode.OK && rootBody == ReactIndexFixture &&
        rootEntry.Content.Headers.ContentType?.ToString() == "text/html; charset=utf-8",
        rootBody);
    Check("root-entry-no-cache", rootEntry.Headers.CacheControl?.ToString() == "no-cache", rootEntry.Headers.CacheControl);
    var (_, reactBody) = await SendAsync(origin, "/react");
    Check("react-entry-no-slash", reactBody == ReactIndexFixture, reactBody);
    var (_, reactSlashBody) = await SendAsync(origin, "/react/");
    Check("react-entry-slash", reactSlashBody == ReactIndexFixture, reactSlashBody);
    var (_, legacyBody) = await SendAsync(origin, "/legacy");
    Check("legacy-entry", legacyBody == ClassicIndexFixture, legacyBody);
    var (_, legacySlashBody) = await SendAsync(origin, "/legacy/");
    Check("legacy-entry-slash", legacySlashBody == ClassicIndexFixture, legacySlashBody);
    var (queryEntry, queryBody) = await SendAsync(origin, "/react?probe=1");
    Check("query-string-ignored", queryEntry.StatusCode == HttpStatusCode.OK && queryBody == ReactIndexFixture, queryBody);

    // ── React 资产：MIME、immutable 缓存、Content-Length、HEAD ───────────────────
    var (asset, assetBody) = await SendAsync(origin, "/react/assets/app-abc123.js");
    Check("react-asset-served",
        asset.StatusCode == HttpStatusCode.OK && assetBody == ReactAssetFixture &&
        asset.Content.Headers.ContentType?.ToString() == "text/javascript; charset=utf-8",
        assetBody);
    Check("react-asset-immutable-cache",
        asset.Headers.CacheControl?.ToString().Contains("immutable") == true &&
        asset.Headers.CacheControl?.ToString().Contains("max-age=31536000") == true,
        asset.Headers.CacheControl);
    Check("react-asset-content-length",
        asset.Content.Headers.ContentLength == Encoding.UTF8.GetByteCount(ReactAssetFixture),
        asset.Content.Headers.ContentLength);
    var (nestedAsset, nestedBody) = await SendAsync(origin, "/react/assets/nested/deep.css");
    Check("react-asset-nested-served",
        nestedAsset.StatusCode == HttpStatusCode.OK &&
        nestedAsset.Content.Headers.ContentType?.ToString() == "text/css; charset=utf-8",
        nestedBody);
    var (headAsset, headAssetBody) = await SendAsync(origin, "/react/assets/app-abc123.js", HttpMethod.Head);
    Check("head-asset-no-body",
        headAsset.StatusCode == HttpStatusCode.OK && headAssetBody.Length == 0 &&
        headAsset.Content.Headers.ContentLength == Encoding.UTF8.GetByteCount(ReactAssetFixture),
        headAssetBody);
    var (headRoot, headRootBody) = await SendAsync(origin, "/", HttpMethod.Head);
    Check("head-root-no-body", headRoot.StatusCode == HttpStatusCode.OK && headRootBody.Length == 0, headRootBody);

    // ── 白名单逐条可达 + MIME 表 ─────────────────────────────────────────────────
    var (readme, _) = await SendAsync(origin, "/README.md");
    Check("allow-readme", readme.StatusCode == HttpStatusCode.OK &&
        readme.Content.Headers.ContentType?.ToString() == "text/markdown; charset=utf-8", readme.Content.Headers.ContentType);
    var (css, cssBody) = await SendAsync(origin, "/frontend/classic/css/style.css");
    Check("allow-classic-css", css.StatusCode == HttpStatusCode.OK && cssBody.Contains("--fixture:classic"), cssBody);
    var (js, jsBody) = await SendAsync(origin, "/frontend/classic/js/util.js");
    Check("allow-classic-js", js.StatusCode == HttpStatusCode.OK && jsBody.Contains("FXU"), jsBody);
    foreach (var contractPath in new[]
    {
        "/contracts/profiles/example-bundle.json",
        "/contracts/profiles/profile-bundle.schema.json",
        "/contracts/calibration/example-bundle.json",
        "/contracts/calibration/calibration-bundle.schema.json",
        "/contracts/validation/fixture-manifest.json",
        "/contracts/validation/time-calibration-report.json",
    })
    {
        var (contract, _) = await SendAsync(origin, contractPath);
        Check("allow-contract:" + contractPath,
            contract.StatusCode == HttpStatusCode.OK &&
            contract.Content.Headers.ContentType?.ToString() == "application/json; charset=utf-8",
            contract.StatusCode);
    }
    var (blob, _) = await SendAsync(origin, "/frontend/classic/css/blob.bin");
    Check("mime-fallback-octet-stream",
        blob.StatusCode == HttpStatusCode.OK &&
        blob.Content.Headers.ContentType?.ToString() == "application/octet-stream",
        blob.Content.Headers.ContentType);

    // ── deny-by-default：dist 不直达、构建文件不外泄、server/.env 永不可达 ─────────
    async Task CheckDenied(string name, string pathAndQuery)
    {
        var (denied, deniedBody) = await SendAsync(origin, pathAndQuery);
        Check(name, denied.StatusCode == HttpStatusCode.NotFound && deniedBody == NotFoundJson,
            $"{(int)denied.StatusCode} body={deniedBody}");
    }

    await CheckDenied("deny-dist-direct", "/dist/react/index.html");
    await CheckDenied("deny-root-assets", "/assets/app-abc123.js");
    await CheckDenied("deny-react-extra-entry", "/react/index.html");
    await CheckDenied("deny-react-sourcemap", "/react/index.html.map");
    await CheckDenied("deny-assets-dir-listing", "/react/assets/");
    await CheckDenied("deny-classic-dir-listing", "/frontend/classic/css/");
    await CheckDenied("deny-server-env", "/server/.env");
    await CheckDenied("deny-root-env", "/.env");
    await CheckDenied("deny-server-js", "/server/index.js");
    await CheckDenied("deny-package-json", "/package.json");
    await CheckDenied("trailing-slash-file-denied", "/index.html/");
    var (unknown, unknownBody) = await SendAsync(origin, "/definitely-not-a-page");
    Check("static-404-shape",
        unknown.StatusCode == HttpStatusCode.NotFound && unknownBody == NotFoundJson &&
        unknown.Content.Headers.ContentType?.ToString() == "application/json; charset=utf-8",
        unknownBody);

    // ── 严格规范化防护（原始 request-target，先于任何折叠检查） ───────────────────
    var encodedTraversal = await RawAsync(origin, "/react/assets/%2e%2e%2Fassets%2Fapp-abc123.js");
    Check("raw-encoded-traversal-denied",
        encodedTraversal.Status == 404 && encodedTraversal.Body == NotFoundJson,
        $"{encodedTraversal.Status} body={encodedTraversal.Body}");
    var plainTraversal = await RawAsync(origin, "/react/assets/../assets/app-abc123.js");
    Check("raw-plain-dotdot-denied",
        plainTraversal.Status == 404 && plainTraversal.Body != ReactAssetFixture,
        $"{plainTraversal.Status} body={plainTraversal.Body}");
    var backslashTraversal = await RawAsync(origin, "/react/assets/..%5Cassets%5Capp-abc123.js");
    Check("raw-backslash-denied",
        backslashTraversal.Status == 404 && backslashTraversal.Body == NotFoundJson,
        $"{backslashTraversal.Status} body={backslashTraversal.Body}");
    var doubleSlashReact = await RawAsync(origin, "/react//assets/app-abc123.js");
    Check("raw-double-slash-react-denied",
        doubleSlashReact.Status == 404 && doubleSlashReact.Body == NotFoundJson,
        $"{doubleSlashReact.Status} body={doubleSlashReact.Body}");
    var controlChar = await RawAsync(origin, "/%01probe");
    Check("raw-control-char-denied",
        controlChar.Status == 404 && controlChar.Body == NotFoundJson,
        $"{controlChar.Status} body={controlChar.Body}");
    var invalidPercent = await RawAsync(origin, "/%zz");
    Check("raw-invalid-percent-400",
        invalidPercent.Status == 400 && invalidPercent.Body == BadPathJson,
        $"{invalidPercent.Status} body={invalidPercent.Body}");
    // Node path.posix.normalize 会折叠重复斜杠后再对白名单放行——C# 侧逐字节对齐。
    var doubleSlashAllowlist = await RawAsync(origin, "//frontend//classic/css/style.css");
    Check("raw-allowlist-double-slash-normalized",
        doubleSlashAllowlist.Status == 200 && doubleSlashAllowlist.Body.Contains("--fixture:classic"),
        $"{doubleSlashAllowlist.Status} body={doubleSlashAllowlist.Body}");

    // ── 路由优先级与鉴权边界 ─────────────────────────────────────────────────────
    var (health, healthBody) = await SendAsync(origin, "/healthz");
    Check("endpoint-priority-healthz",
        health.StatusCode == HttpStatusCode.OK && healthBody.Contains("\"source\":\"endpoint\""),
        healthBody);
    var (share, shareBody) = await SendAsync(origin, "/share/fixture-token");
    Check("endpoint-priority-share",
        share.StatusCode == HttpStatusCode.OK && shareBody == "share-endpoint:fixture-token",
        shareBody);
    var (guardedJob, guardedJobBody) = await SendAsync(origin, "/api/v1/jobs/abc");
    Check("api-boundary-still-guards",
        guardedJob.StatusCode == HttpStatusCode.Unauthorized && guardedJobBody.Contains("internal_auth_required"),
        guardedJobBody);
    Check("static-bypasses-caller-context", rootEntry.StatusCode == HttpStatusCode.OK, rootEntry.StatusCode);
    var (apiUnknown, apiUnknownBody) = await SendAsync(origin, "/api/v1/definitely-not-a-route");
    Check("api-unknown-not-claimed-by-static",
        apiUnknown.StatusCode == HttpStatusCode.NotFound && apiUnknownBody != NotFoundJson,
        $"{(int)apiUnknown.StatusCode} body={apiUnknownBody}");
    var (postRoot, postRootBody) = await SendAsync(origin, "/", HttpMethod.Post);
    Check("post-not-claimed-by-static",
        postRoot.StatusCode == HttpStatusCode.NotFound && postRootBody != NotFoundJson,
        $"{(int)postRoot.StatusCode} body={postRootBody}");

    // ═══ 应用 3：dist 构建产物缺失（clean checkout 语义：根入口回落经典页） ═══════
    var appNoDist = await StartAppAsync(noDistRoot, internalSecret: string.Empty);
    var noDistOrigin = Origin(appNoDist);
    var (missingReact, missingReactBody) = await SendAsync(noDistOrigin, "/react");
    Check("missing-dist-react-404",
        missingReact.StatusCode == HttpStatusCode.NotFound && missingReactBody == NotFoundJson,
        missingReactBody);
    var (fallbackRoot, fallbackBody) = await SendAsync(noDistOrigin, "/");
    Check("missing-dist-root-falls-back-classic",
        fallbackRoot.StatusCode == HttpStatusCode.OK && fallbackBody == ClassicIndexFixture,
        fallbackBody);
    var (missingAsset, missingAssetBody) = await SendAsync(noDistOrigin, "/react/assets/app-abc123.js");
    Check("missing-dist-asset-404",
        missingAsset.StatusCode == HttpStatusCode.NotFound && missingAssetBody == NotFoundJson,
        missingAssetBody);

    // ── 汇总（沿用 AuthGate 的 artifact 约定，静态对齐证据进 CI） ─────────────────
    var report = new
    {
        schemaVersion = "1.0",
        generatedAtUtc = DateTimeOffset.UtcNow,
        contract = "server/lib/http.js serveStatic/staticDiskPath parity",
        result = "pass",
        passed,
        total = checks.Count,
        checks,
    };
    var artifact = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "artifacts", "static-hosting-parity.json"));
    Directory.CreateDirectory(Path.GetDirectoryName(artifact)!);
    await File.WriteAllTextAsync(artifact, JsonSerializer.Serialize(report, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
    Console.WriteLine($"Static hosting parity gate PASS: {passed}/{checks.Count}");
    Console.WriteLine(artifact);
}
finally
{
    foreach (var app in apps)
    {
        await app.DisposeAsync();
    }
    if (Directory.Exists(fixtureRoot)) Directory.Delete(fixtureRoot, recursive: true);
}

return 0;
