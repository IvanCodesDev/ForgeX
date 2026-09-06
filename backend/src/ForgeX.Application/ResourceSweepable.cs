namespace ForgeX.Application;

/// <summary>
/// 可被周期清扫器驱动的资源仓库：过期清理 + 供 /metrics 使用的存量计数。
/// PostgreSQL 腿受 RLS 约束，只能统计/清理本进程见过的 (tenant, owner) 对——语义与 Node 一致。
/// </summary>
public interface IResourceSweepable
{
    string ResourceName { get; }

    Task<int> SweepAsync(DateTimeOffset now, CancellationToken cancellationToken);

    Task<long> CountAsync(CancellationToken cancellationToken);
}
