using System.Collections.Concurrent;
using System.Text.Json;
using ForgeX.Application;
using Npgsql;

namespace ForgeX.Infrastructure;

/// <summary>
/// 数据源 PostgreSQL 腿——server/services/postgres-datasource.js 的行为孪生：同一张 forgex.datasources、
/// 同样的 RLS 契约、同样的 (tenant, owner, cache_key) 去重与过期即删语义。
/// 淘汰窗口按决策 A5 改为「保留最新 max 条」（Node 侧同步修正）。
/// </summary>
public sealed class PostgresDatasourceRepository : IDatasourceRepository, IAsyncDisposable
{
    private readonly PostgresSession _session;
    private readonly int _maxPerOwner;
    private readonly ConcurrentDictionary<(string TenantId, string OwnerId), byte> _seenOwners = new();

    public PostgresDatasourceRepository(string connectionString, int maxPerOwner)
    {
        if (maxPerOwner < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxPerOwner));
        }

        _session = new PostgresSession(connectionString);
        _maxPerOwner = maxPerOwner;
    }

    public string ResourceName => "datasources";

    public Task ProbeAsync(CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync("tn_local", "ow_local", async (connection, transaction) =>
        {
            await using var command = new NpgsqlCommand("SELECT 1 FROM forgex.datasources LIMIT 0", connection, transaction);
            await command.ExecuteNonQueryAsync(cancellationToken);
            return true;
        }, cancellationToken);

    public Task<DatasourceCreateResult> CreateOrGetAsync(DatasourceRecord candidate, CancellationToken cancellationToken)
    {
        _seenOwners.TryAdd((candidate.TenantId, candidate.OwnerId), 0);
        return _session.WithOwnerTransactionAsync(candidate.TenantId, candidate.OwnerId, async (connection, transaction) =>
        {
            DatasourceRecord? existing = null;
            await using (var select = new NpgsqlCommand(
                "SELECT * FROM forgex.datasources WHERE tenant_id=$1 AND owner_id=$2 AND cache_key=$3",
                connection,
                transaction))
            {
                select.Parameters.Add(PostgresSession.Text(candidate.TenantId));
                select.Parameters.Add(PostgresSession.Text(candidate.OwnerId));
                select.Parameters.Add(PostgresSession.Text(candidate.CacheKey));
                await using var reader = await select.ExecuteReaderAsync(cancellationToken);
                if (await reader.ReadAsync(cancellationToken))
                {
                    existing = Map(reader);
                }
            }

            if (existing is not null)
            {
                if (existing.ExpiresAt is null || candidate.CreatedAt <= existing.ExpiresAt)
                {
                    return new DatasourceCreateResult(existing, Deduplicated: true);
                }

                await using var delete = new NpgsqlCommand(
                    "DELETE FROM forgex.datasources WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",
                    connection,
                    transaction);
                delete.Parameters.Add(PostgresSession.Text(candidate.TenantId));
                delete.Parameters.Add(PostgresSession.Text(candidate.OwnerId));
                delete.Parameters.Add(PostgresSession.Text(existing.Id));
                await delete.ExecuteNonQueryAsync(cancellationToken);
            }

            await using (var insert = new NpgsqlCommand(
                """
                INSERT INTO forgex.datasources
                  (id, tenant_id, owner_id, name, csv, rows_json, content_sha256, cache_key,
                   warnings_json, provenance_json, created_at_utc, expires_at_utc)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                """,
                connection,
                transaction))
            {
                insert.Parameters.Add(PostgresSession.Text(candidate.Id));
                insert.Parameters.Add(PostgresSession.Text(candidate.TenantId));
                insert.Parameters.Add(PostgresSession.Text(candidate.OwnerId));
                insert.Parameters.Add(PostgresSession.Text(candidate.Name));
                insert.Parameters.Add(PostgresSession.Text(candidate.Csv));
                insert.Parameters.Add(PostgresSession.Jsonb(candidate.Rows.GetRawText()));
                insert.Parameters.Add(PostgresSession.Text(candidate.ContentSha256));
                insert.Parameters.Add(PostgresSession.Text(candidate.CacheKey));
                insert.Parameters.Add(PostgresSession.Jsonb(JsonSerializer.Serialize(candidate.Warnings)));
                insert.Parameters.Add(PostgresSession.Jsonb(candidate.Provenance.GetRawText()));
                insert.Parameters.Add(PostgresSession.Timestamp(DateTimeOffset.FromUnixTimeMilliseconds(candidate.CreatedAt)));
                insert.Parameters.Add(PostgresSession.NullableTimestamp(candidate.ExpiresAt is { } expires ? DateTimeOffset.FromUnixTimeMilliseconds(expires) : null));
                await insert.ExecuteNonQueryAsync(cancellationToken);
            }

            await using (var evict = new NpgsqlCommand(
                """
                DELETE FROM forgex.datasources
                WHERE tenant_id=$1 AND owner_id=$2 AND id IN (
                  SELECT id FROM forgex.datasources
                  WHERE tenant_id=$1 AND owner_id=$2
                  ORDER BY created_at_utc DESC, id DESC
                  OFFSET $3
                )
                """,
                connection,
                transaction))
            {
                evict.Parameters.Add(PostgresSession.Text(candidate.TenantId));
                evict.Parameters.Add(PostgresSession.Text(candidate.OwnerId));
                evict.Parameters.Add(PostgresSession.Integer(_maxPerOwner));
                await evict.ExecuteNonQueryAsync(cancellationToken);
            }

            return new DatasourceCreateResult(candidate, Deduplicated: false);
        }, cancellationToken);
    }

    public Task<DatasourceRecord?> GetAsync(string tenantId, string ownerId, string id, CancellationToken cancellationToken)
    {
        _seenOwners.TryAdd((tenantId, ownerId), 0);
        return _session.WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
        {
            await using var select = new NpgsqlCommand(
                "SELECT * FROM forgex.datasources WHERE id=$1 AND tenant_id=$2 AND owner_id=$3",
                connection,
                transaction);
            select.Parameters.Add(PostgresSession.Text(id));
            select.Parameters.Add(PostgresSession.Text(tenantId));
            select.Parameters.Add(PostgresSession.Text(ownerId));
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                return null;
            }

            var record = Map(reader);
            return record.ExpiresAt is { } expiresAt && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > expiresAt ? null : record;
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
                    "SELECT count(*) FROM forgex.datasources WHERE tenant_id=$1 AND owner_id=$2 AND (expires_at_utc IS NULL OR expires_at_utc >= $3)",
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
                    "DELETE FROM forgex.datasources WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc IS NOT NULL AND expires_at_utc < $3",
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

    private static DatasourceRecord Map(NpgsqlDataReader reader)
    {
        var expiresAt = PostgresSession.ReadNullableTimestamp(reader, "expires_at_utc");
        return new DatasourceRecord(
            reader.GetString(reader.GetOrdinal("id")),
            reader.GetString(reader.GetOrdinal("tenant_id")),
            reader.GetString(reader.GetOrdinal("owner_id")),
            reader.GetString(reader.GetOrdinal("name")),
            reader.GetString(reader.GetOrdinal("csv")),
            ParseJson(reader.GetString(reader.GetOrdinal("rows_json"))),
            reader.GetString(reader.GetOrdinal("content_sha256")),
            reader.GetString(reader.GetOrdinal("cache_key")),
            JsonSerializer.Deserialize<List<string>>(reader.GetString(reader.GetOrdinal("warnings_json"))) ?? [],
            ParseJson(reader.GetString(reader.GetOrdinal("provenance_json"))),
            PostgresSession.ReadTimestamp(reader, "created_at_utc").ToUnixTimeMilliseconds(),
            expiresAt?.ToUnixTimeMilliseconds());
    }

    private static JsonElement ParseJson(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
