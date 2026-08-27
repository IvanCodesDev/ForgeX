using System.Security.Cryptography;
using System.Text;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.2: direct caller identity resolved inside ForgeX.Api, mirroring the Node
/// chain (server/lib/auth.js + identity.js) exactly so tenants keep their data when
/// traffic moves off the Node proxy:
///   API key             → caller "key:{first 8 hex of sha256(key)}"
///   anonymous           → caller "ip:{remote address}"
/// and canonical ids tn_/ow_ + first 32 hex of sha256(caller). Semantics preserved:
/// API-key auth activates only when keys are configured, RequireAuth without keys
/// degrades to disabled, and key comparison is constant-time over the whole key
/// list. Calibration review keys stay a separate table (Node auth.js
/// identifyReviewer): holding an ordinary key never implies review rights, and the
/// shared digest keeps the four-eyes rule enforceable.
/// </summary>
internal sealed class DirectAuthOptions
{
    public DirectAuthOptions(IReadOnlyList<string> apiKeys, bool requireAuth, IReadOnlyList<string>? calibrationReviewKeys = null)
    {
        ApiKeys = apiKeys;
        Enabled = apiKeys.Count > 0;
        // Node parity: REQUIRE_AUTH without configured keys cannot protect anything.
        RequireAuth = requireAuth && Enabled;
        CalibrationReviewKeys = calibrationReviewKeys ?? [];
        ReviewEnabled = CalibrationReviewKeys.Count > 0;
    }

    public IReadOnlyList<string> ApiKeys { get; }
    public bool Enabled { get; }
    public bool RequireAuth { get; }
    public IReadOnlyList<string> CalibrationReviewKeys { get; }
    public bool ReviewEnabled { get; }

    public static DirectAuthOptions FromConfiguration(IConfiguration configuration)
    {
        var keys = SplitKeys(configuration["DirectAuth:ApiKeys"]);
        var reviewKeys = SplitKeys(configuration["DirectAuth:CalibrationReviewKeys"]);
        var required = string.Equals(configuration["DirectAuth:RequireAuth"], "true", StringComparison.OrdinalIgnoreCase)
            || configuration["DirectAuth:RequireAuth"] == "1";
        return new DirectAuthOptions(keys, required, reviewKeys);
    }

    private static string[] SplitKeys(string? value) =>
        (value ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}

internal static class DirectCallerAuthentication
{
    /// <summary>
    /// Resolves a direct caller (no trusted-node headers present) with Node's
    /// resolveIdentity() priority: API key > anonymous IP.
    /// Returns a problem result when the caller must be rejected.
    /// </summary>
    public static IResult? Resolve(HttpContext context, DirectAuthOptions options, out ForgeXCallerContext? caller)
    {
        var key = ReadApiKey(context.Request);
        if (options.Enabled && key.Length > 0)
        {
            var keyId = MatchKey(options.ApiKeys, key);
            if (keyId is not null)
            {
                caller = FromCallerString("key:" + keyId);
                return null;
            }
        }

        if (options.RequireAuth)
        {
            caller = null;
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status401Unauthorized,
                "api_key_required",
                "需要 API Key：请在 Authorization: Bearer <key> 或 X-API-Key 头中提供");
        }

        var remote = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        caller = FromCallerString("ip:" + remote);
        return null;
    }

    /// <summary>
    /// Node auth.js identifyReviewer(): matches only the review-key table and returns
    /// the same 8-hex digest id as ordinary keys, or null when the credential carries
    /// no review authority. Ordinary API keys never gain review rights implicitly.
    /// </summary>
    public static string? IdentifyReviewer(HttpRequest request, DirectAuthOptions options)
    {
        if (!options.ReviewEnabled) return null;
        var key = ReadApiKey(request);
        return key.Length == 0 ? null : MatchKey(options.CalibrationReviewKeys, key);
    }

    /// <summary>Same caller string → same canonical ids as Node's storageId()/opaqueContextId().</summary>
    internal static ForgeXCallerContext FromCallerString(string callerId)
    {
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(callerId)))[..32];
        return new ForgeXCallerContext("tn_" + digest, "ow_" + digest, false);
    }

    private static string ReadApiKey(HttpRequest request)
    {
        var authorization = request.Headers.Authorization.ToString();
        if (authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return authorization["Bearer ".Length..].Trim();
        }
        var explicitKey = request.Headers["X-API-Key"].ToString();
        return explicitKey.Trim();
    }

    private static string? MatchKey(IReadOnlyList<string> keys, string candidate)
    {
        // Node parity: never exit on first hit so a key's list position cannot leak
        // through timing; identity is the first 8 hex chars of the key digest.
        string? matched = null;
        foreach (var configured in keys)
        {
            if (FixedTimeEquals(configured, candidate)) matched = configured;
        }
        return matched is null
            ? null
            : Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(matched)))[..8];
    }

    private static bool FixedTimeEquals(string expected, string supplied)
    {
        var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(expected));
        var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
        return CryptographicOperations.FixedTimeEquals(expectedHash, suppliedHash);
    }
}
