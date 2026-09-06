using System.Text.Json;

namespace ForgeX.Application;

/// <summary>
/// 一条数据源记录——Node <c>services/datasource.js</c> / <c>postgres-datasource.js</c> 记录形状的 C# 对等物。
/// 时间戳统一为 Unix 毫秒（与 Node 的 <c>Date.now()</c> 一致）；<see cref="ExpiresAt"/> 为空表示永不过期。
/// </summary>
public sealed record DatasourceRecord(
    string Id,
    string TenantId,
    string OwnerId,
    string Name,
    string Csv,
    JsonElement Rows,
    string ContentSha256,
    string CacheKey,
    IReadOnlyList<string> Warnings,
    JsonElement Provenance,
    long CreatedAt,
    long? ExpiresAt,
    bool Builtin = false);

public sealed record DatasourceCreateResult(DatasourceRecord Record, bool Deduplicated);

/// <summary>
/// 数据源存储端口。内置 <c>sample</c> 数据集由端点层直接从 FarmDataset 提供，不进仓库；
/// 仓库只管用户上传：按 (tenant, owner, cacheKey) 去重、TTL、每所有者上限淘汰（最旧先走，决策 A5）。
/// </summary>
public interface IDatasourceRepository : IResourceSweepable
{
    /// <summary>
    /// 同 (tenant, owner) 下已有相同 cacheKey 且未过期的记录 → 原记录 + Deduplicated=true（Node 语义：返回旧记录的 name）；
    /// 过期的旧记录先删再插；否则插入 <paramref name="candidate"/> 并按上限淘汰。
    /// </summary>
    Task<DatasourceCreateResult> CreateOrGetAsync(DatasourceRecord candidate, CancellationToken cancellationToken);

    Task<DatasourceRecord?> GetAsync(string tenantId, string ownerId, string id, CancellationToken cancellationToken);

    Task ProbeAsync(CancellationToken cancellationToken);
}

/// <summary>一篇知识库文档（Node <c>services/knowledge.js</c> 记录形状）。</summary>
public sealed record KnowledgeDocument(
    string Id,
    string TenantId,
    string OwnerId,
    string Name,
    string Text,
    long CreatedAt,
    long? ExpiresAt);

public interface IKnowledgeRepository : IResourceSweepable
{
    Task<KnowledgeDocument> CreateAsync(KnowledgeDocument document, CancellationToken cancellationToken);

    /// <summary>Live documents for (tenant, owner), oldest first (createdAt asc, id asc) — the order BM25 retrieval consumes.</summary>
    Task<IReadOnlyList<KnowledgeDocument>> ListAsync(string tenantId, string ownerId, CancellationToken cancellationToken);

    Task ProbeAsync(CancellationToken cancellationToken);
}

/// <summary>校准治理审计事件（Node <c>CalibrationStore._event</c>）；<see cref="At"/> 为 Unix 毫秒。</summary>
public sealed record CalibrationEvent(string Action, long At, string Actor, string Reason);

/// <summary>
/// 一条候选校准包提交（Node <c>services/calibration.js</c> 记录形状，file 状态文件里按 <see cref="Key"/> 索引）。
/// <see cref="ReviewedBy"/> / <see cref="ReviewReason"/> 在审核前缺省（Node 里是 undefined，序列化时不输出键）。
/// </summary>
public sealed record CalibrationSubmission(
    string Key,
    string Id,
    int Revision,
    string Status,
    string Digest,
    JsonElement Bundle,
    long CreatedAt,
    long UpdatedAt,
    string SubmittedBy,
    string Note,
    IReadOnlyList<CalibrationEvent> Events,
    string? ReviewedBy = null,
    string? ReviewReason = null);

/// <summary>当前已发布（active）的校准包（Node <c>approved[id]</c> 形状）。</summary>
public sealed record CalibrationRelease(
    string Id,
    int Revision,
    string Digest,
    JsonElement Bundle,
    long ApprovedAt,
    string ApprovedBy);

public sealed record CalibrationGovernanceStats(int Approved, int Pending);

/// <summary>
/// 提交 / 审核的裁决：<see cref="Status"/> 为 201 / 200 时 <see cref="Submission"/> 非空；
/// 为 400 / 404 / 409 时 <see cref="Error"/> 携带 Node 原文文案（端点直接用作 problem title）。
/// </summary>
public sealed record CalibrationGovernanceOutcome(int Status, string? Error, CalibrationSubmission? Submission)
{
    public bool Ok => Status is 200 or 201;

    public static CalibrationGovernanceOutcome Failure(int status, string error) => new(status, error, null);

    public static CalibrationGovernanceOutcome Success(int status, CalibrationSubmission submission) => new(status, null, submission);
}

/// <summary>
/// 校准治理存储端口：部署级单租户（Node PG 版 <c>cfg.postgresTenantId || "tn_local"</c>），不按调用方分租户；
/// 状态机与文案由 Infrastructure 的 <c>CalibrationGovernanceRules</c> 在 file / PG 两腿之间共用。
/// </summary>
public interface ICalibrationGovernanceStore
{
    /// <summary>Published bundles ordered by id (ordinal).</summary>
    Task<IReadOnlyList<CalibrationRelease>> ListApprovedAsync(CancellationToken cancellationToken);

    /// <summary>All retained submissions, newest first (createdAt desc).</summary>
    Task<IReadOnlyList<CalibrationSubmission>> ListSubmissionsAsync(CancellationToken cancellationToken);

    Task<CalibrationGovernanceStats> StatsAsync(CancellationToken cancellationToken);

    Task<CalibrationGovernanceOutcome> SubmitAsync(JsonElement? bundle, JsonElement? note, string actor, CancellationToken cancellationToken);

    Task<CalibrationGovernanceOutcome> ReviewAsync(string id, int revision, JsonElement? decision, JsonElement? reason, string actor, CancellationToken cancellationToken);

    Task ProbeAsync(CancellationToken cancellationToken);
}
