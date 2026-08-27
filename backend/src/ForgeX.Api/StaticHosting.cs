using System.Text;
using Microsoft.AspNetCore.Http.Features;

namespace ForgeX.Api;

/// <summary>
/// Stage 8 (V2 manual §4.2 work item 5): static hosting options. Disabled by default,
/// which keeps ForgeX.Api byte-identical to the pre-migration behavior; when enabled the
/// middleware serves the same static plane as server/lib/http.js so a single
/// ForgeX.Api process can deliver frontend + API (single-process deployment).
/// </summary>
internal sealed class StaticHostingOptions
{
    private StaticHostingOptions(bool enabled, string rootFullPath)
    {
        Enabled = enabled;
        RootFullPath = rootFullPath;
    }

    public bool Enabled { get; }

    /// <summary>
    /// Absolute static root. Same semantics as Node cfg.staticRoot (the repository root
    /// in development, the published content root in deployment): the allowlist spans
    /// /index.html, /frontend/classic/*, /contracts/* and /dist/react/*, so the root is
    /// the directory containing those entries — not dist/react itself.
    /// </summary>
    public string RootFullPath { get; }

    public static StaticHostingOptions FromConfiguration(IConfiguration configuration, string contentRootPath)
    {
        var enabledRaw = (configuration["StaticHosting:Enabled"] ?? string.Empty).Trim();
        var enabled = enabledRaw switch
        {
            "" => false,
            _ when enabledRaw == "1" || string.Equals(enabledRaw, "true", StringComparison.OrdinalIgnoreCase) => true,
            _ when enabledRaw == "0" || string.Equals(enabledRaw, "false", StringComparison.OrdinalIgnoreCase) => false,
            _ => throw new InvalidOperationException("StaticHosting:Enabled must be one of 1/0/true/false."),
        };
        if (!enabled)
        {
            return new StaticHostingOptions(false, string.Empty);
        }

        var root = configuration["StaticHosting:Root"];
        if (string.IsNullOrWhiteSpace(root))
        {
            throw new InvalidOperationException(
                "StaticHosting:Root is required when StaticHosting:Enabled=1. Point it at the static root " +
                "containing index.html, frontend/classic/, contracts/ and dist/react/ (Node cfg.staticRoot equivalent).");
        }

        var fullPath = Path.GetFullPath(root, contentRootPath);
        if (!Directory.Exists(fullPath))
        {
            throw new InvalidOperationException($"StaticHosting:Root directory does not exist: {fullPath}");
        }

        return new StaticHostingOptions(true, fullPath);
    }
}

/// <summary>
/// Behavioral twin of serveStatic()/staticDiskPath() in server/lib/http.js — the routing
/// table, MIME table, cache headers, deny-by-default allowlist and the strict
/// normalization guards (raw request-target checked before any dot-segment folding, see
/// Stage 7.1 commit 724c85a) are ported rule for rule. Node keeps no SPA deep-link
/// fallback, so none is invented here. Divergence would break the Node/C# static parity
/// gate (ForgeX.StaticGate), so any intentional change must land in both runtimes.
/// </summary>
internal static class StaticFileHosting
{
    private const string NotFoundBody = /*lang=json,strict*/ "{\"error\":\"资源不存在\"}";
    private const string BadPathBody = /*lang=json,strict*/ "{\"error\":\"路径不合法\"}";
    private const string ReactAssetPrefix = "/react/assets/";
    private const string ImmutableCache = "public, max-age=31536000, immutable";

    /// <summary>Node http.js MIME table, copied verbatim (fallback application/octet-stream).</summary>
    private static readonly IReadOnlyDictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [".html"] = "text/html; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".json"] = "application/json; charset=utf-8",
        [".csv"] = "text/csv; charset=utf-8",
        [".md"] = "text/markdown; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".webp"] = "image/webp",
        [".ico"] = "image/x-icon",
        [".map"] = "application/json",
        [".wasm"] = "application/wasm",
        [".woff"] = "font/woff",
        [".woff2"] = "font/woff2",
    };

    /// <summary>
    /// The exact middleware used by Program.cs, exposed so the static parity gate
    /// exercises the same code path over a real Kestrel pipeline (AuthGate precedent).
    /// Endpoint-mapped routes (API/SSE/share/health/metrics) always win: the middleware
    /// only handles requests no endpoint claimed, mirroring Node's router-then-static
    /// order. Static paths never enter CallerContextBoundary (it applies to /api/v1/*).
    /// </summary>
    public static Func<HttpContext, RequestDelegate, Task> BuildMiddleware(StaticHostingOptions options)
    {
        var rootFullPath = options.RootFullPath;
        var reactIndexProbe = Path.Combine(rootFullPath, "dist", "react", "index.html");
        return async (context, next) =>
        {
            if (context.GetEndpoint() is not null)
            {
                await next(context);
                return;
            }

            var isGet = HttpMethods.IsGet(context.Request.Method);
            var isHead = HttpMethods.IsHead(context.Request.Method);
            if (!isGet && !isHead)
            {
                await next(context);
                return;
            }

            // Node parity: unmatched /api/* stays an API 404 (handled by UseStatusCodePages
            // upstream), the static plane never claims it.
            if ((context.Request.Path.Value ?? string.Empty).StartsWith("/api/", StringComparison.Ordinal))
            {
                await next(context);
                return;
            }

            await ServeAsync(context, rootFullPath, reactIndexProbe, isHead);
        };
    }

    private static async Task ServeAsync(HttpContext context, string rootFullPath, string reactIndexProbe, bool isHead)
    {
        // The raw request-target must be checked before any dot-segment folding: Kestrel
        // (like WHATWG URL in Node) folds /assets/../assets/x into a clean path, which
        // would launder traversal attempts before the allowlist ever sees them.
        var rawTarget = context.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (string.IsNullOrEmpty(rawTarget))
        {
            rawTarget = context.Request.Path.Value ?? "/";
        }

        var queryStart = rawTarget.AsSpan().IndexOfAny('?', '#');
        var rawPath = queryStart >= 0 ? rawTarget[..queryStart] : rawTarget;

        if (!TryDecodeUriComponent(rawPath, out var decodedPath))
        {
            await SendJsonAsync(context, StatusCodes.Status400BadRequest, BadPathBody, isHead);
            return;
        }

        if (HasForbiddenRawShape(decodedPath))
        {
            await SendJsonAsync(context, StatusCodes.Status404NotFound, NotFoundBody, isHead);
            return;
        }

        var path = decodedPath;
        if (path.Length == 0 || path[0] != '/')
        {
            // Absolute-form request targets fall outside the origin-form contract Node serves.
            await SendJsonAsync(context, StatusCodes.Status404NotFound, NotFoundBody, isHead);
            return;
        }

        var normalized = PosixNormalize(path);
        var isEntryTree = path == "/react" || path.StartsWith("/react/", StringComparison.Ordinal) ||
            path == "/legacy" || path.StartsWith("/legacy/", StringComparison.Ordinal);
        if (isEntryTree && !string.Equals(path, normalized, StringComparison.Ordinal))
        {
            await SendJsonAsync(context, StatusCodes.Status404NotFound, NotFoundBody, isHead);
            return;
        }

        path = normalized;
        if (path == "/")
        {
            // Stage 7.1 contract: the root entry is React; a missing build artifact
            // (clean checkout) falls back to the classic entry so the app still boots.
            path = File.Exists(reactIndexProbe) ? "/react" : "/index.html";
        }

        // Defense-in-depth mirror of Node's post-normalization guard.
        if (path[0] != '/' || path.Contains("..", StringComparison.Ordinal) ||
            path.Contains('\\') || path.Contains('\0'))
        {
            await SendJsonAsync(context, StatusCodes.Status404NotFound, NotFoundBody, isHead);
            return;
        }

        var diskPath = StaticDiskPath(path);
        if (diskPath.Length == 0)
        {
            await SendJsonAsync(context, StatusCodes.Status404NotFound, NotFoundBody, isHead);
            return;
        }

        var absolute = Path.GetFullPath(diskPath[1..].Replace('/', Path.DirectorySeparatorChar), rootFullPath);
        var relative = Path.GetRelativePath(rootFullPath, absolute);
        if (relative.Length == 0 || relative == "." || relative == ".." ||
            relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) ||
            Path.IsPathRooted(relative))
        {
            await SendJsonAsync(context, StatusCodes.Status404NotFound, NotFoundBody, isHead);
            return;
        }

        var file = new FileInfo(absolute);
        if (!file.Exists)
        {
            // FileInfo.Exists is false for directories, which also forbids listings.
            await SendJsonAsync(context, StatusCodes.Status404NotFound, NotFoundBody, isHead);
            return;
        }

        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.ContentType = Mime.GetValueOrDefault(Path.GetExtension(absolute).ToLowerInvariant(), "application/octet-stream");
        context.Response.ContentLength = file.Length;
        // Node cache contract: only /react/assets/* is immutable (hashed by the build);
        // entries and allowlisted files are no-cache. No further tiers exist in Node.
        context.Response.Headers.CacheControl = path.StartsWith(ReactAssetPrefix, StringComparison.Ordinal)
            ? ImmutableCache
            : "no-cache";
        if (isHead)
        {
            return;
        }

        await context.Response.SendFileAsync(absolute, context.RequestAborted);
    }

    /// <summary>URL→disk mapping ported from staticDiskPath(): deny-by-default, only the
    /// React entry + hashed assets, the /legacy classic entry and the explicit allowlist
    /// resolve to disk. dist/ itself is deliberately not exposed.</summary>
    private static string StaticDiskPath(string path)
    {
        if (path is "/react" or "/react/")
        {
            return "/dist/react/index.html";
        }
        if (path.StartsWith(ReactAssetPrefix, StringComparison.Ordinal) &&
            path.Length > ReactAssetPrefix.Length &&
            path[ReactAssetPrefix.Length] != '/')
        {
            return "/dist/react/assets/" + path[ReactAssetPrefix.Length..];
        }
        if (path is "/legacy" or "/legacy/")
        {
            return "/index.html";
        }
        return IsAllowlisted(path) ? path : string.Empty;
    }

    /// <summary>STATIC_ALLOW ported rule for rule (server/lib/http.js).</summary>
    private static bool IsAllowlisted(string path) =>
        path is "/index.html" or "/README.md"
            or "/contracts/profiles/example-bundle.json"
            or "/contracts/profiles/profile-bundle.schema.json"
            or "/contracts/calibration/example-bundle.json"
            or "/contracts/calibration/calibration-bundle.schema.json"
            or "/contracts/validation/fixture-manifest.json"
            or "/contracts/validation/time-calibration-report.json" ||
        path.StartsWith("/frontend/classic/css/", StringComparison.Ordinal) ||
        path.StartsWith("/frontend/classic/js/", StringComparison.Ordinal);

    /// <summary>Raw-target guard: backslashes, control characters and "."/".." segments
    /// are rejected before any normalization, exactly like Node's serveStatic().</summary>
    private static bool HasForbiddenRawShape(string decodedPath)
    {
        foreach (var character in decodedPath)
        {
            if (character < ' ' || character == '\u007f' || character == '\\')
            {
                return true;
            }
        }
        foreach (var segment in decodedPath.Split('/'))
        {
            if (segment is "." or "..")
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// decodeURIComponent semantics: %XX must be two hex digits and the decoded byte
    /// sequence must be valid UTF-8, otherwise the request is malformed (Node answers
    /// 400 路径不合法). Uri.UnescapeDataString is deliberately not used because it
    /// silently passes invalid escapes through.
    /// </summary>
    private static bool TryDecodeUriComponent(string input, out string decoded)
    {
        decoded = string.Empty;
        var bytes = new List<byte>(input.Length);
        for (var index = 0; index < input.Length; index++)
        {
            var character = input[index];
            if (character == '%')
            {
                if (index + 2 >= input.Length ||
                    !TryHexNibble(input[index + 1], out var high) ||
                    !TryHexNibble(input[index + 2], out var low))
                {
                    return false;
                }
                bytes.Add((byte)((high << 4) | low));
                index += 2;
            }
            else if (character < 0x80)
            {
                bytes.Add((byte)character);
            }
            else
            {
                // Kestrel enforces ASCII request targets; this branch keeps literal
                // non-ASCII characters faithful if another server implementation allows them.
                var chunk = char.IsHighSurrogate(character) && index + 1 < input.Length && char.IsLowSurrogate(input[index + 1])
                    ? input.Substring(index++, 2)
                    : character.ToString();
                bytes.AddRange(Encoding.UTF8.GetBytes(chunk));
            }
        }

        try
        {
            decoded = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true)
                .GetString(bytes.ToArray());
            return true;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }

    private static bool TryHexNibble(char character, out int value)
    {
        value = character switch
        {
            >= '0' and <= '9' => character - '0',
            >= 'a' and <= 'f' => character - 'a' + 10,
            >= 'A' and <= 'F' => character - 'A' + 10,
            _ => -1,
        };
        return value >= 0;
    }

    /// <summary>path.posix.normalize() port: collapses duplicate separators, resolves
    /// "." and ".." segments and preserves a trailing slash (Node keeps it).</summary>
    private static string PosixNormalize(string path)
    {
        var segments = new List<string>();
        foreach (var segment in path.Split('/'))
        {
            if (segment.Length == 0 || segment == ".")
            {
                continue;
            }
            if (segment == "..")
            {
                if (segments.Count > 0)
                {
                    segments.RemoveAt(segments.Count - 1);
                }
                continue;
            }
            segments.Add(segment);
        }

        if (segments.Count == 0)
        {
            return "/";
        }
        var normalized = "/" + string.Join('/', segments);
        return path.EndsWith('/') ? normalized + "/" : normalized;
    }

    private static async Task SendJsonAsync(HttpContext context, int statusCode, string body, bool isHead)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        context.Response.StatusCode = statusCode;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength = bytes.Length;
        if (isHead)
        {
            return;
        }
        await context.Response.Body.WriteAsync(bytes, context.RequestAborted);
    }
}
