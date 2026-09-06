using ForgeX.Application;
using ForgeX.Contracts;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.6a：校准治理端点——server/routes/calibration.js 四条路由 + stats 的 C# 权威腿。
/// 状态机在 Infrastructure 的 CalibrationGovernanceRules；这里只做身份三态（§7.2）与形状映射。
/// 与 Node 一致：身份判定先于请求体读取（503 / 401 / 403 早于 413 / 400）。
/// </summary>
internal static class CalibrationGovernanceEndpoints
{
    private const long MaxSubmitBodyBytes = 2L * 1024 * 1024 + 64 * 1024;
    private const long MaxReviewBodyBytes = 16L * 1024;

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/calibrations", CatalogAsync)
            .WithName("ListCalibrationCatalog")
            .ExcludeFromDescription();

        app.MapGet("/api/v1/calibrations/stats", StatsAsync)
            .WithName("CalibrationGovernanceStats")
            .ExcludeFromDescription();

        app.MapGet("/api/v1/calibrations/submissions", ListSubmissionsAsync)
            .WithName("ListCalibrationSubmissions")
            .ExcludeFromDescription();

        app.MapPost("/api/v1/calibrations/submissions", SubmitAsync)
            .WithName("SubmitCalibrationCandidate")
            .ExcludeFromDescription();

        app.MapPost("/api/v1/calibrations/{id:regex(^[A-Za-z0-9._-]+$)}/revisions/{revision:int}/review", ReviewAsync)
            .WithName("ReviewCalibrationSubmission")
            .ExcludeFromDescription();
    }

    public static async Task<IResult> CatalogAsync(ICalibrationGovernanceStore store, CancellationToken cancellationToken)
    {
        var items = await store.ListApprovedAsync(cancellationToken);
        return Results.Json(new CalibrationCatalogResponseDto(
            "forgex-calibration-catalog",
            1,
            items.Select(ToDto).ToList()));
    }

    public static async Task<IResult> StatsAsync(ICalibrationGovernanceStore store, CancellationToken cancellationToken)
    {
        var stats = await store.StatsAsync(cancellationToken);
        return Results.Json(new CalibrationStatsResponseDto(stats.Approved, stats.Pending));
    }

    public static async Task<IResult> ListSubmissionsAsync(HttpContext context, ICalibrationGovernanceStore store, DirectAuthOptions directAuth)
    {
        var (_, problem) = ResolveActor(context, CallerContextBoundary.ReviewerRole, directAuth);
        if (problem is not null)
        {
            return problem;
        }

        var submissions = await store.ListSubmissionsAsync(context.RequestAborted);
        return Results.Json(new CalibrationSubmissionsResponseDto(submissions.Select(ToDto).ToList()));
    }

    public static async Task<IResult> SubmitAsync(HttpContext context, ICalibrationGovernanceStore store, DirectAuthOptions directAuth)
    {
        var (actor, problem) = ResolveActor(context, CallerContextBoundary.SubmitterRole, directAuth);
        if (problem is not null)
        {
            return problem;
        }

        var body = await EndpointBodies.ReadJsonAsync<CalibrationSubmitRequestDto>(context, MaxSubmitBodyBytes, "请求体过大");
        if (body.Problem is not null)
        {
            return body.Problem;
        }

        var outcome = await store.SubmitAsync(body.Value?.Bundle, body.Value?.Note, actor!, context.RequestAborted);
        if (!outcome.Ok)
        {
            return Failure(context, outcome);
        }

        var record = outcome.Submission!;
        return Results.Json(
            new CalibrationSubmitResponseDto(record.Id, record.Revision, record.Status, record.Digest, record.SubmittedBy),
            statusCode: StatusCodes.Status201Created);
    }

    public static async Task<IResult> ReviewAsync(HttpContext context, string id, int revision, ICalibrationGovernanceStore store, DirectAuthOptions directAuth)
    {
        var (actor, problem) = ResolveActor(context, CallerContextBoundary.ReviewerRole, directAuth);
        if (problem is not null)
        {
            return problem;
        }

        var body = await EndpointBodies.ReadJsonAsync<CalibrationReviewRequestDto>(context, MaxReviewBodyBytes, "请求体过大");
        if (body.Problem is not null)
        {
            return body.Problem;
        }

        var outcome = await store.ReviewAsync(id, revision, body.Value?.Decision, body.Value?.Reason, actor!, context.RequestAborted);
        if (!outcome.Ok)
        {
            return Failure(context, outcome);
        }

        var record = outcome.Submission!;
        return Results.Json(new CalibrationReviewResponseDto(record.Id, record.Revision, record.Status, record.ReviewedBy!, record.ReviewReason!));
    }

    /// <summary>
    /// §7.2 三态。可信通道：Node 已经用自己的 API_KEYS / CALIBRATION_REVIEW_KEYS 判定过，这里只要求
    /// actor 头存在且角色匹配；直连：与 Node submitter() / reviewer() 逐条对齐。
    /// </summary>
    internal static (string? Actor, IResult? Problem) ResolveActor(HttpContext context, string role, DirectAuthOptions directAuth)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var submitter = role == CallerContextBoundary.SubmitterRole;
        if (caller.Trusted)
        {
            if (caller.ActorKeyId is not null && caller.ActorRole == role)
            {
                return (caller.ActorKeyId, null);
            }

            return submitter
                ? (null, ApiProblemResults.Create(context, 401, "api_key_required", "校准候选提交需要有效 API Key"))
                : (null, ApiProblemResults.Create(context, 401, "review_key_required", "校准审核需要审核密钥"));
        }

        if (submitter)
        {
            if (!directAuth.Enabled)
            {
                return (null, ApiProblemResults.Create(context, 503, "submissions_disabled", "校准候选提交接口未启用：请先配置 API_KEYS"));
            }

            var keyId = DirectCallerAuthentication.IdentifySubmitter(context.Request, directAuth);
            return keyId is null
                ? (null, ApiProblemResults.Create(context, 401, "api_key_required", "校准候选提交需要有效 API Key"))
                : (keyId, null);
        }

        if (!directAuth.ReviewEnabled)
        {
            return (null, ApiProblemResults.Create(context, 503, "review_disabled", "校准审核接口未启用：请先配置 CALIBRATION_REVIEW_KEYS"));
        }

        if (!DirectCallerAuthentication.HasCredential(context.Request))
        {
            return (null, ApiProblemResults.Create(context, 401, "review_key_required", "校准审核需要审核密钥"));
        }

        var reviewerId = DirectCallerAuthentication.IdentifyReviewer(context.Request, directAuth);
        return reviewerId is null
            ? (null, ApiProblemResults.Create(context, 403, "review_forbidden", "当前凭据没有校准审核权限"))
            : (reviewerId, null);
    }

    private static IResult Failure(HttpContext context, CalibrationGovernanceOutcome outcome)
    {
        var code = outcome.Status switch
        {
            404 => "submission_not_found",
            409 => "calibration_conflict",
            _ => "calibration_invalid",
        };
        return ApiProblemResults.Create(context, outcome.Status, code, outcome.Error ?? "校准治理请求被拒绝");
    }

    private static CalibrationReleaseDto ToDto(CalibrationRelease release) =>
        new(release.Id, release.Revision, release.Digest, release.Bundle, release.ApprovedAt, release.ApprovedBy);

    private static CalibrationSubmissionDto ToDto(CalibrationSubmission submission) =>
        new(
            submission.Key,
            submission.Id,
            submission.Revision,
            submission.Status,
            submission.Digest,
            submission.Bundle,
            submission.CreatedAt,
            submission.UpdatedAt,
            submission.SubmittedBy,
            submission.Note,
            submission.Events.Select(static e => new CalibrationEventDto(e.Action, e.At, e.Actor, e.Reason)).ToList(),
            submission.ReviewedBy,
            submission.ReviewReason);
}
