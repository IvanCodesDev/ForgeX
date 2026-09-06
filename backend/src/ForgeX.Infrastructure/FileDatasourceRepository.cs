using System.Text.Json;
using ForgeX.Application;

namespace ForgeX.Infrastructure;

/// <summary>
/// 数据源 file 腿。语义对齐 <see cref="PostgresDatasourceRepository"/>（而非 Node 的内存 FileStore）：
/// 按 (tenant, owner, cacheKey) 去重、TTL、每所有者上限最旧先淘汰。
/// </summary>
public sealed class FileDatasourceRepository : IDatasourceRepository
{
    private sealed record DatasourcePayload(
        string Name,
        string Csv,
        JsonElement Rows,
        string ContentSha256,
        string CacheKey,
        IReadOnlyList<string> Warnings,
        JsonElement Provenance);

    private readonly JsonFileCollection<DatasourcePayload> _files;
    private readonly int _maxPerOwner;

    public FileDatasourceRepository(string directory, int maxPerOwner)
    {
        if (maxPerOwner < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxPerOwner));
        }

        _files = new JsonFileCollection<DatasourcePayload>(directory);
        _maxPerOwner = maxPerOwner;
    }

    public string ResourceName => "datasources";

    public string RootDirectory => _files.RootDirectory;

    public Task ProbeAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Directory.CreateDirectory(_files.RootDirectory);
        return Task.CompletedTask;
    }

    public async Task<DatasourceCreateResult> CreateOrGetAsync(DatasourceRecord candidate, CancellationToken cancellationToken)
    {
        using (await _files.LockAsync(cancellationToken))
        {
            var nowMs = candidate.CreatedAt;
            var existing = (await _files.ListAsync(candidate.TenantId, candidate.OwnerId, long.MinValue, cancellationToken))
                .FirstOrDefault(item => !item.Builtin && item.TenantId == candidate.TenantId && item.OwnerId == candidate.OwnerId && item.Payload.CacheKey == candidate.CacheKey);
            if (existing is not null)
            {
                if (!existing.IsExpired(nowMs))
                {
                    return new DatasourceCreateResult(Map(existing), Deduplicated: true);
                }

                await _files.DeleteAsync(existing.Id, cancellationToken);
            }

            var collision = await _files.GetAsync(candidate.Id, tenantId: null, ownerId: null, long.MinValue, cancellationToken);
            if (collision is not null && (collision.TenantId != candidate.TenantId || collision.OwnerId != candidate.OwnerId))
            {
                // Same PK semantics as forgex.datasources: the id is derived from (tenant, cacheKey), so another
                // owner in the same tenant holding identical content is a hard conflict, not a silent overwrite.
                throw new InvalidOperationException($"datasource id '{candidate.Id}' already belongs to another owner");
            }

            await _files.PutAsync(
                new FileEnvelope<DatasourcePayload>(
                    candidate.Id,
                    candidate.TenantId,
                    candidate.OwnerId,
                    candidate.CreatedAt,
                    candidate.ExpiresAt,
                    Builtin: false,
                    new DatasourcePayload(
                        candidate.Name,
                        candidate.Csv,
                        candidate.Rows,
                        candidate.ContentSha256,
                        candidate.CacheKey,
                        candidate.Warnings,
                        candidate.Provenance)),
                cancellationToken);
            await _files.EvictBeyondAsync(candidate.TenantId, candidate.OwnerId, _maxPerOwner, nowMs, cancellationToken);
            return new DatasourceCreateResult(candidate, Deduplicated: false);
        }
    }

    public async Task<DatasourceRecord?> GetAsync(string tenantId, string ownerId, string id, CancellationToken cancellationToken)
    {
        var envelope = await _files.GetAsync(id, tenantId, ownerId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), cancellationToken);
        return envelope is null || envelope.Builtin ? null : Map(envelope);
    }

    public Task<long> CountAsync(CancellationToken cancellationToken) =>
        _files.CountAsync(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), cancellationToken);

    public async Task<int> SweepAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        using (await _files.LockAsync(cancellationToken))
        {
            return await _files.SweepExpiredAsync(now.ToUnixTimeMilliseconds(), cancellationToken);
        }
    }

    private static DatasourceRecord Map(FileEnvelope<DatasourcePayload> envelope) =>
        new(
            envelope.Id,
            envelope.TenantId,
            envelope.OwnerId,
            envelope.Payload.Name,
            envelope.Payload.Csv,
            envelope.Payload.Rows,
            envelope.Payload.ContentSha256,
            envelope.Payload.CacheKey,
            envelope.Payload.Warnings,
            envelope.Payload.Provenance,
            envelope.CreatedAt,
            envelope.ExpiresAt);
}
