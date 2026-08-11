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
        path.StartsWithSegments("/api/v1/jobs", StringComparison.Ordinal);

    public static IResult? Resolve(HttpContext context, string sharedSecret, string previousSharedSecret)
    {
        if (string.IsNullOrEmpty(sharedSecret) && string.IsNullOrEmpty(previousSharedSecret))
        {
            context.Items[ContextItemKey] = new ForgeXCallerContext("tn_local", "ow_local", false);
            return null;
        }

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
