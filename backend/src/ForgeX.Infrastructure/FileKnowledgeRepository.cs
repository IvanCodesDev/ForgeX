using ForgeX.Application;

namespace ForgeX.Infrastructure;

/// <summary>知识库 file 腿：每篇文档一个 JSON 文件，TTL + 每所有者上限（最旧先淘汰，决策 A5）。</summary>
public sealed class FileKnowledgeRepository : IKnowledgeRepository
{
    private sealed record KnowledgePayload(string Name, string Text);

    private readonly JsonFileCollection<KnowledgePayload> _files;
    private readonly int _maxPerOwner;

    public FileKnowledgeRepository(string directory, int maxPerOwner)
    {
        if (maxPerOwner < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxPerOwner));
        }

        _files = new JsonFileCollection<KnowledgePayload>(directory);
        _maxPerOwner = maxPerOwner;
    }

    public string ResourceName => "knowledge";

    public string RootDirectory => _files.RootDirectory;

    public Task ProbeAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Directory.CreateDirectory(_files.RootDirectory);
        return Task.CompletedTask;
    }

    public async Task<KnowledgeDocument> CreateAsync(KnowledgeDocument document, CancellationToken cancellationToken)
    {
        using (await _files.LockAsync(cancellationToken))
        {
            await _files.PutAsync(
                new FileEnvelope<KnowledgePayload>(
                    document.Id,
                    document.TenantId,
                    document.OwnerId,
                    document.CreatedAt,
                    document.ExpiresAt,
                    Builtin: false,
                    new KnowledgePayload(document.Name, document.Text)),
                cancellationToken);
            await _files.EvictBeyondAsync(document.TenantId, document.OwnerId, _maxPerOwner, document.CreatedAt, cancellationToken);
            return document;
        }
    }

    public async Task<IReadOnlyList<KnowledgeDocument>> ListAsync(string tenantId, string ownerId, CancellationToken cancellationToken)
    {
        var items = await _files.ListAsync(tenantId, ownerId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), cancellationToken);
        return items
            .Where(item => !item.Builtin)
            .Select(static item => new KnowledgeDocument(
                item.Id,
                item.TenantId,
                item.OwnerId,
                item.Payload.Name,
                item.Payload.Text,
                item.CreatedAt,
                item.ExpiresAt))
            .ToList();
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
}
