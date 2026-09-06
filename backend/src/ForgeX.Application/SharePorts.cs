namespace ForgeX.Application;

public sealed record ShareRecord(
    string Token,
    string TenantId,
    string OwnerId,
    string RevokeHash,
    string ReportJson,
    string Question,
    string Engine,
    string? UpstreamTaskId,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    long AccessCount,
    DateTimeOffset? LastAccessedAt);

public sealed record ShareCreated(string Token, string RevokeKey, DateTimeOffset ExpiresAt);

public enum ShareRevokeOutcome
{
    Revoked,
    NotFound,
    BadKey,
}

/// <summary>
/// Stage 8.6a：分享存储端口。Stage 8.1 只有 PostgreSQL 一条腿；为了保住「零配置单进程部署」
/// 与 Node ShareStore 的 file 腿对等，这里抽出接口，file / postgres 两个实现共用同一套端点。
/// </summary>
public interface IShareRepository : IResourceSweepable
{
    Task<ShareCreated> CreateAsync(
        string tenantId,
        string ownerId,
        string reportJson,
        string question,
        string engine,
        string? upstreamTaskId,
        long? requestedTtlMs,
        CancellationToken cancellationToken);

    Task<ShareRecord?> GetPublicAsync(string token, CancellationToken cancellationToken);

    Task<ShareRevokeOutcome> RevokeAsync(
        string token,
        string? revokeKey,
        string tenantId,
        string ownerId,
        CancellationToken cancellationToken);

    Task ProbeAsync(CancellationToken cancellationToken);
}
