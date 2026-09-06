using System.Collections.Concurrent;
using ForgeX.Application;
using Npgsql;

namespace ForgeX.Infrastructure;

/// <summary>
/// 知识库 PostgreSQL 腿——server/services/postgres-knowledge.js 的行为孪生（同一张 forgex.knowledge_docs、同一套 RLS）。
/// 列表读取前先清掉本所有者的过期文档（Node ready() 的做法），淘汰窗口按决策 A5 保留最新 max 条。
/// </summary>
public sealed class PostgresKnowledgeRepository : IKnowledgeRepository, IAsyncDisposable
{
    private readonly PostgresSession _session;
    private readonly int _maxPerOwner;
    private readonly ConcurrentDictionary<(string TenantId, string OwnerId), byte> _seenOwners = new();

    public PostgresKnowledgeRepository(string connectionString, int maxPerOwner)
    {
        if (maxPerOwner < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxPerOwner));
        }

        _session = new PostgresSession(connectionString);
        _maxPerOwner = maxPerOwner;
    }

    public string ResourceName => "knowledge";

    public Task ProbeAsync(CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync("tn_local", "ow_local", async (connection, transaction) =>
        {
            await using var command = new NpgsqlCommand("SELECT 1 FROM forgex.knowledge_docs LIMIT 0", connection, transaction);
            await command.ExecuteNonQueryAsync(cancellationToken);
            return true;
        }, cancellationToken);

    public Task<KnowledgeDocument> CreateAsync(KnowledgeDocument document, CancellationToken cancellationToken)
    {
        _seenOwners.TryAdd((document.TenantId, document.OwnerId), 0);
        return _session.WithOwnerTransactionAsync(document.TenantId, document.OwnerId, async (connection, transaction) =>
        {
            await using (var insert = new NpgsqlCommand(
                """
                INSERT INTO forgex.knowledge_docs
                  (id, tenant_id, owner_id, name, text, created_at_utc, expires_at_utc)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
                """,
                connection,
                transaction))
            {
                insert.Parameters.Add(PostgresSession.Text(document.Id));
                insert.Parameters.Add(PostgresSession.Text(document.TenantId));
                insert.Parameters.Add(PostgresSession.Text(document.OwnerId));
                insert.Parameters.Add(PostgresSession.Text(document.Name));
                insert.Parameters.Add(PostgresSession.Text(document.Text));
                insert.Parameters.Add(PostgresSession.Timestamp(DateTimeOffset.FromUnixTimeMilliseconds(document.CreatedAt)));
                insert.Parameters.Add(PostgresSession.NullableTimestamp(document.ExpiresAt is { } expires ? DateTimeOffset.FromUnixTimeMilliseconds(expires) : null));
                await insert.ExecuteNonQueryAsync(cancellationToken);
            }

            await using (var evict = new NpgsqlCommand(
                """
                DELETE FROM forgex.knowledge_docs
                WHERE tenant_id=$1 AND owner_id=$2 AND id IN (
                  SELECT id FROM forgex.knowledge_docs
                  WHERE tenant_id=$1 AND owner_id=$2
                  ORDER BY created_at_utc DESC, id DESC
                  OFFSET $3
                )
                """,
                connection,
                transaction))
            {
                evict.Parameters.Add(PostgresSession.Text(document.TenantId));
                evict.Parameters.Add(PostgresSession.Text(document.OwnerId));
                evict.Parameters.Add(PostgresSession.Integer(_maxPerOwner));
                await evict.ExecuteNonQueryAsync(cancellationToken);
            }

            return document;
        }, cancellationToken);
    }

    public Task<IReadOnlyList<KnowledgeDocument>> ListAsync(string tenantId, string ownerId, CancellationToken cancellationToken)
    {
        _seenOwners.TryAdd((tenantId, ownerId), 0);
        return _session.WithOwnerTransactionAsync<IReadOnlyList<KnowledgeDocument>>(tenantId, ownerId, async (connection, transaction) =>
        {
            await using (var purge = new NpgsqlCommand(
                "DELETE FROM forgex.knowledge_docs WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc IS NOT NULL AND expires_at_utc <= $3",
                connection,
                transaction))
            {
                purge.Parameters.Add(PostgresSession.Text(tenantId));
                purge.Parameters.Add(PostgresSession.Text(ownerId));
                purge.Parameters.Add(PostgresSession.Timestamp(DateTimeOffset.UtcNow));
                await purge.ExecuteNonQueryAsync(cancellationToken);
            }

            await using var select = new NpgsqlCommand(
                "SELECT * FROM forgex.knowledge_docs WHERE tenant_id=$1 AND owner_id=$2 ORDER BY created_at_utc ASC, id ASC",
                connection,
                transaction);
            select.Parameters.Add(PostgresSession.Text(tenantId));
            select.Parameters.Add(PostgresSession.Text(ownerId));
            var documents = new List<KnowledgeDocument>();
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                documents.Add(new KnowledgeDocument(
                    reader.GetString(reader.GetOrdinal("id")),
                    reader.GetString(reader.GetOrdinal("tenant_id")),
                    reader.GetString(reader.GetOrdinal("owner_id")),
                    reader.GetString(reader.GetOrdinal("name")),
                    reader.GetString(reader.GetOrdinal("text")),
                    PostgresSession.ReadTimestamp(reader, "created_at_utc").ToUnixTimeMilliseconds(),
                    PostgresSession.ReadNullableTimestamp(reader, "expires_at_utc")?.ToUnixTimeMilliseconds()));
            }

            return documents;
        }, cancellationToken);
    }

    public async Task<long> CountAsync(CancellationToken cancellationToken)
    {
        long total = 0;
        foreach (var (tenantId, ownerId) in _seenOwners.Keys)
        {
            total += await _session.WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
            {
                await using var count = new NpgsqlCommand(
                    "SELECT count(*) FROM forgex.knowledge_docs WHERE tenant_id=$1 AND owner_id=$2 AND (expires_at_utc IS NULL OR expires_at_utc >= $3)",
                    connection,
                    transaction);
                count.Parameters.Add(PostgresSession.Text(tenantId));
                count.Parameters.Add(PostgresSession.Text(ownerId));
                count.Parameters.Add(PostgresSession.Timestamp(DateTimeOffset.UtcNow));
                return (long)(await count.ExecuteScalarAsync(cancellationToken) ?? 0L);
            }, cancellationToken);
        }

        return total;
    }

    public async Task<int> SweepAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var removed = 0;
        foreach (var (tenantId, ownerId) in _seenOwners.Keys)
        {
            removed += await _session.WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
            {
                await using var delete = new NpgsqlCommand(
                    "DELETE FROM forgex.knowledge_docs WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc IS NOT NULL AND expires_at_utc < $3",
                    connection,
                    transaction);
                delete.Parameters.Add(PostgresSession.Text(tenantId));
                delete.Parameters.Add(PostgresSession.Text(ownerId));
                delete.Parameters.Add(PostgresSession.Timestamp(now));
                return await delete.ExecuteNonQueryAsync(cancellationToken);
            }, cancellationToken);
        }

        return removed;
    }

    public ValueTask DisposeAsync() => _session.DisposeAsync();
}
