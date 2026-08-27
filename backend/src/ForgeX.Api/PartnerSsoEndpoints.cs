namespace ForgeX.Api;

/// <summary>
/// Stage 8.2: route surface for the migrated Partner SSO service. The four public
/// routes match server/services/partner-sso.js register() verbatim (registered
/// unconditionally — an unconfigured service answers 503/enabled:false exactly like
/// Node). The internal session-resolve route lets the migration-period Node proxy
/// keep serving its own business endpoints (quota, task ownership, AI user keys)
/// while ForgeX.Api owns the session store; it rides the same X-ForgeX-Internal-Token
/// trust channel as the caller-context headers because the response carries the
/// user's Partner API key, which must never be readable from the browser.
/// </summary>
internal static class PartnerSsoEndpoints
{
    internal const string SessionTokenHeader = "X-ForgeX-Session-Token";

    public static void Map(
        IEndpointRouteBuilder app,
        PartnerSsoService sso,
        string internalSharedSecret,
        string previousInternalSharedSecret)
    {
        app.MapGet("/api/auth/infini/login", sso.BeginAsync)
            .WithName("BeginPartnerSsoLogin")
            .ExcludeFromDescription();

        app.MapGet("/api/auth/infini/callback", sso.CallbackAsync)
            .WithName("CompletePartnerSsoLogin")
            .ExcludeFromDescription();

        app.MapGet("/api/auth/infini/me", sso.MeAsync)
            .WithName("GetPartnerSsoProfile")
            .ExcludeFromDescription();

        app.MapPost("/api/auth/infini/logout", sso.LogoutAsync)
            .WithName("LogoutPartnerSso")
            .ExcludeFromDescription();

        app.MapGet("/api/v1/auth/infini/session", (HttpContext context) =>
                ResolveSession(context, sso, internalSharedSecret, previousInternalSharedSecret))
            .WithName("ResolvePartnerSsoSession")
            .ExcludeFromDescription();
    }

    private static IResult ResolveSession(
        HttpContext context,
        PartnerSsoService sso,
        string internalSharedSecret,
        string previousInternalSharedSecret)
    {
        var suppliedToken = context.Request.Headers["X-ForgeX-Internal-Token"].ToString();
        if (suppliedToken.Length == 0 ||
            (!CallerContextBoundary.FixedTimeEquals(suppliedToken, internalSharedSecret) &&
             !CallerContextBoundary.FixedTimeEquals(suppliedToken, previousInternalSharedSecret)))
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status401Unauthorized,
                "internal_auth_required",
                "Trusted sidecar caller context is required");
        }

        var sessionToken = context.Request.Headers[SessionTokenHeader].ToString();
        var session = sessionToken.Length == 0 ? null : sso.IdentityByToken(sessionToken);
        return session is null
            ? ApiProblemResults.Create(
                context,
                StatusCodes.Status404NotFound,
                "session_not_found",
                "Partner SSO session not found or expired")
            : Results.Json(new { user = session.User, apiKey = session.ApiKey });
    }
}
