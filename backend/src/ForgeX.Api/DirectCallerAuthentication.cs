using System.Security.Cryptography;
using System.Text;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.2: direct caller identity resolved inside ForgeX.Api, mirroring the Node
/// chain (server/lib/auth.js + identity.js) exactly so tenants keep their data when
/// traffic moves off the Node proxy:
///   API key  → caller "key:{first 8 hex of sha256(key)}"
///   anonymous → caller "ip:{remote address}"
/// and canonical ids tn_/ow_ + first 32 hex of sha256(caller). Semantics preserved:
/// auth activates only when keys are configured, RequireAuth without keys degrades
/// to disabled, and key comparison is constant-time over the whole key list.
/// </summary>
internal sealed class DirectAuthOptions
{
    public DirectAuthOptions(IReadOnlyList<string> apiKeys, bool requireAuth)
    {
        ApiKeys = apiKeys;
        Enabled = apiKeys.Count > 0;
        // Node parity: REQUIRE_AUTH without configured keys cannot protect anything.
        RequireAuth = requireAuth && Enabled;
    }

    public IReadOnlyList<string> ApiKeys { get; }
    public bool Enabled { get; }
    public bool RequireAuth { get; }

    public static DirectAuthOptions FromConfiguration(IConfiguration configuration)
    {
        var keys = (configuration["DirectAuth:ApiKeys"] ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var required = string.Equals(configuration["DirectAuth:RequireAuth"], "true", StringComparison.OrdinalIgnoreCase)
            || configuration["DirectAuth:RequireAuth"] == "1";
        return new DirectAuthOptions(keys, required);
    }
}

internal static class DirectCallerAuthentication
{
    /// <summary>
    /// Resolves a direct caller (no trusted-node headers present). Returns a problem
    /// result only when RequireAuth rejects an unauthenticated request.
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
