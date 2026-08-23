using System.Security.Cryptography;
using System.Text;

namespace ForgeX.Api;

internal sealed record ForgeXCallerContext(string TenantId, string OwnerId, bool Trusted);

internal static class CallerContextBoundary
{
    private const string ContextItemKey = "ForgeX.CallerContext";
    private const string InternalTokenHeader = "X-ForgeX-Internal-Token";
    private const string TenantHeader = "X-ForgeX-Tenant-Id";
    private const string OwnerHeader = "X-ForgeX-Owner-Id";

    public static bool AppliesTo(PathString path) =>
        path.StartsWithSegments("/api/v1/gcode/analyses", StringComparison.Ordinal) ||
        path.StartsWithSegments("/api/v1/jobs", StringComparison.Ordinal) ||
        // Stage 8.1: share creation/revocation need the trusted caller context;
        // the public share page (/share/{token}) intentionally stays outside.
        path.StartsWithSegments("/api/v1/shares", StringComparison.Ordinal) ||
        path.StartsWithSegments("/api/v1/analysis-tasks", StringComparison.Ordinal);

    public static IResult? Resolve(
        HttpContext context,
        string sharedSecret,
        string previousSharedSecret,
        DirectAuthOptions? directAuth = null)
    {
        var secretsConfigured = !string.IsNullOrEmpty(sharedSecret) || !string.IsNullOrEmpty(previousSharedSecret);
        var tokenSupplied = context.Request.Headers.ContainsKey(InternalTokenHeader);

        // ① 可信 Node 代理：带内部令牌就必须验签成功，失败不落到直连路径。
        if (secretsConfigured && tokenSupplied)
        {
            if (!TryReadSingle(context, InternalTokenHeader, out var suppliedToken) ||
                (!FixedTimeEquals(suppliedToken, sharedSecret) &&
                 !FixedTimeEquals(suppliedToken, previousSharedSecret)))
            {
                return ApiProblemResults.Create(
                    context,
                    StatusCodes.Status401Unauthorized,
                    "internal_auth_required",
                    "Trusted sidecar caller context is required");
            }

            if (!TryReadSingle(context, TenantHeader, out var tenantId) ||
                !TryReadSingle(context, OwnerHeader, out var ownerId) ||
                !IsCanonicalId(tenantId, "tn_") ||
                !IsCanonicalId(ownerId, "ow_"))
            {
                return ApiProblemResults.Create(
                    context,
                    StatusCodes.Status400BadRequest,
                    "invalid_caller_context",
                    "Trusted caller context is invalid");
            }

            context.Items[ContextItemKey] = new ForgeXCallerContext(tenantId, ownerId, true);
            return null;
        }

        // ② Stage 8.2 直连身份：配置了 DirectAuth:ApiKeys 后，无内部令牌的请求
        //    按 Node 同一套映射解析（API key → key:{id8}，匿名 → ip:{addr}）。
        if (directAuth is { Enabled: true })
        {
            var problem = DirectCallerAuthentication.Resolve(context, directAuth, out var caller);
            if (problem is not null) return problem;
            context.Items[ContextItemKey] = caller!;
            return null;
        }

        // ③ 兜底：与迁移前行为一致——配了内部密钥但无令牌 → 401；全未配置 → 本地上下文。
        if (secretsConfigured)
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status401Unauthorized,
                "internal_auth_required",
                "Trusted sidecar caller context is required");
        }

        context.Items[ContextItemKey] = new ForgeXCallerContext("tn_local", "ow_local", false);
        return null;
    }

    public static ForgeXCallerContext GetRequired(HttpContext context) =>
        context.Items.TryGetValue(ContextItemKey, out var value) && value is ForgeXCallerContext caller
            ? caller
            : throw new InvalidOperationException("Caller context middleware did not run for this endpoint.");

    private static bool TryReadSingle(HttpContext context, string name, out string value)
    {
        var values = context.Request.Headers[name];
        if (values.Count != 1 || string.IsNullOrWhiteSpace(values[0]))
        {
            value = string.Empty;
            return false;
        }

        value = values[0]!;
        return true;
    }

    private static bool FixedTimeEquals(string supplied, string expected)
    {
        if (string.IsNullOrEmpty(expected)) return false;
        var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
        var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(expected));
        return CryptographicOperations.FixedTimeEquals(suppliedHash, expectedHash);
    }

    private static bool IsCanonicalId(string value, string prefix) =>
        value.Length == prefix.Length + 32 &&
        value.StartsWith(prefix, StringComparison.Ordinal) &&
        value[prefix.Length..].All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
}
