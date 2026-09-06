using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using ForgeX.Application;
using Npgsql;
using NpgsqlTypes;

namespace ForgeX.Infrastructure;

/// <summary>
/// PostgreSQL-backed share store. Behavioral twin of the Node implementation in
/// server/services/postgres-share.js: same table (forgex.shares), same RLS contract
/// (per-transaction GUCs app.tenant_id / app.owner_id, public reads via
/// app.share_public), same token/revoke-key shapes, same TTL capping, expiry-on-read
/// deletion, access counting, and per-owner eviction. Divergence here would fail the
/// Stage 8 dual-run comparison, so any intentional change must land in both runtimes.
/// </summary>
public sealed class PostgresShareRepository : IShareRepository, IAsyncDisposable
{
    public static readonly TimeSpan DefaultTtl = TimeSpan.FromHours(24);
    public const int DefaultMaxSharesPerOwner = 2000;

    private readonly PostgresSession _session;
    private readonly TimeSpan _ttl;
    private readonly int _maxSharesPerOwner;
    private readonly ConcurrentDictionary<(string TenantId, string OwnerId), byte> _seenOwners = new();

    public PostgresShareRepository(
        string connectionString,
        TimeSpan? ttl = null,
        int maxSharesPerOwner = DefaultMaxSharesPerOwner)
    {
        if (maxSharesPerOwner < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxSharesPerOwner));
        }

        _session = new PostgresSession(connectionString);
        _ttl = ttl is { } value && value > TimeSpan.Zero ? value : DefaultTtl;
        _maxSharesPerOwner = maxSharesPerOwner;
    }

    public TimeSpan Ttl => _ttl;

    public string ResourceName => "shares";

    /// <summary>Readiness probe mirroring the Node store: touch the table under a local context.</summary>
    public Task ProbeAsync(CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync("tn_local", "ow_local", async (connection, transaction) =>
        {
            await using var command = new NpgsqlCommand("SELECT 1 FROM forgex.shares LIMIT 0", connection, transaction);
            await command.ExecuteNonQueryAsync(cancellationToken);
            return true;
        }, cancellationToken);

    public async Task<ShareCreated> CreateAsync(
        string tenantId,
        string ownerId,
        string reportJson,
        string question,
        string engine,
        string? upstreamTaskId,
        long? requestedTtlMs,
        CancellationToken cancellationToken)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(9));
        var revokeKey = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(9));
        var revokeHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(revokeKey)));
        var ttl = requestedTtlMs is > 0
            ? TimeSpan.FromMilliseconds(Math.Min(requestedTtlMs.Value, _ttl.TotalMilliseconds))
            : _ttl;
        var createdAt = DateTimeOffset.UtcNow;
        var expiresAt = createdAt + ttl;

        _seenOwners.TryAdd((tenantId, ownerId), 0);
        await _session.WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
        {
            await using (var insert = new NpgsqlCommand(
                """
                INSERT INTO forgex.shares
                  (token, tenant_id, owner_id, revoke_hash, report_json, question, engine,
                   upstream_task_id, created_at_utc, expires_at_utc, access_count)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0)
                """,
                connection,
                transaction))
            {
                insert.Parameters.Add(PostgresSession.Text(token));
                insert.Parameters.Add(PostgresSession.Text(tenantId));
                insert.Parameters.Add(PostgresSession.Text(ownerId));
                insert.Parameters.Add(PostgresSession.Text(revokeHash));
                insert.Parameters.Add(PostgresSession.Jsonb(reportJson));
                insert.Parameters.Add(PostgresSession.Text(question));
                insert.Parameters.Add(PostgresSession.Text(engine));
                insert.Parameters.Add(new NpgsqlParameter { Value = (object?)upstreamTaskId ?? DBNull.Value, NpgsqlDbType = NpgsqlDbType.Varchar });
                insert.Parameters.Add(PostgresSession.Timestamp(createdAt));
                insert.Parameters.Add(PostgresSession.Timestamp(expiresAt));
                await insert.ExecuteNonQueryAsync(cancellationToken);
            }

            // Parity note (decision A5): keep the newest `max` rows, remove the oldest surplus.
            // Node's postgres-share.js `_evict` uses the same DESC window; change both sides
            // together or the dual-run comparison will flag it.
            await using (var evict = new NpgsqlCommand(
                """
                DELETE FROM forgex.shares
                WHERE tenant_id=$1 AND owner_id=$2 AND token IN (
                  SELECT token FROM forgex.shares
                  WHERE tenant_id=$1 AND owner_id=$2
                  ORDER BY created_at_utc DESC, token DESC
                  OFFSET $3
                )
                """,
                connection,
                transaction))
            {
                evict.Parameters.Add(PostgresSession.Text(tenantId));
                evict.Parameters.Add(PostgresSession.Text(ownerId));
                evict.Parameters.Add(PostgresSession.Integer(_maxSharesPerOwner));
                await evict.ExecuteNonQueryAsync(cancellationToken);
            }

            return true;
        }, cancellationToken);

        return new ShareCreated(token, revokeKey, expiresAt);
    }

    /// <summary>
    /// Public fetch used by the share page: expired records are deleted on read and
    /// reported as absent; live records get their access counter bumped.
    /// </summary>
    public async Task<ShareRecord?> GetPublicAsync(string token, CancellationToken cancellationToken)
    {
        var key = token ?? string.Empty;
        var record = await _session.WithPublicTransactionAsync(async (connection, transaction) =>
        {
            await using var select = new NpgsqlCommand(
                "SELECT * FROM forgex.shares WHERE token=$1",
                connection,
                transaction);
            select.Parameters.Add(PostgresSession.Text(key));
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            return await reader.ReadAsync(cancellationToken) ? Map(reader) : null;
        }, cancellationToken);

        if (record is null)
        {
            return null;
        }

        if (DateTimeOffset.UtcNow > record.ExpiresAt)
        {
            await _session.WithOwnerTransactionAsync(record.TenantId, record.OwnerId, async (connection, transaction) =>
            {
                await using var delete = new NpgsqlCommand(
                    "DELETE FROM forgex.shares WHERE token=$1 AND tenant_id=$2 AND owner_id=$3",
                    connection,
                    transaction);
                delete.Parameters.Add(PostgresSession.Text(record.Token));
                delete.Parameters.Add(PostgresSession.Text(record.TenantId));
                delete.Parameters.Add(PostgresSession.Text(record.OwnerId));
                await delete.ExecuteNonQueryAsync(cancellationToken);
                return true;
            }, cancellationToken);
            return null;
        }

        var access = await _session.WithOwnerTransactionAsync(record.TenantId, record.OwnerId, async (connection, transaction) =>
        {
            await using var update = new NpgsqlCommand(
                """
                UPDATE forgex.shares
                SET access_count=access_count+1, last_accessed_at_utc=$2
                WHERE token=$1
                RETURNING access_count, last_accessed_at_utc
                """,
                connection,
                transaction);
            update.Parameters.Add(PostgresSession.Text(record.Token));
            update.Parameters.Add(PostgresSession.Timestamp(DateTimeOffset.UtcNow));
            await using var reader = await update.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                return ((long AccessCount, DateTimeOffset? LastAccessedAt)?)null;
            }
            var count = reader.GetInt64(0);
            var accessedAt = reader.IsDBNull(1) ? (DateTimeOffset?)null : ReadTimestamp(reader, 1);
            return (count, accessedAt);
        }, cancellationToken);

        return access is { } bumped
            ? record with { AccessCount = bumped.AccessCount, LastAccessedAt = bumped.LastAccessedAt }
            : record;
    }

    public async Task<ShareRevokeOutcome> RevokeAsync(
        string token,
        string? revokeKey,
        string tenantId,
        string ownerId,
        CancellationToken cancellationToken)
    {
        var key = token ?? string.Empty;
        return await _session.WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
        {
            string? storedHash;
            await using (var select = new NpgsqlCommand(
                "SELECT revoke_hash FROM forgex.shares WHERE token=$1 AND tenant_id=$2 AND owner_id=$3",
                connection,
                transaction))
            {
                select.Parameters.Add(PostgresSession.Text(key));
                select.Parameters.Add(PostgresSession.Text(tenantId));
                select.Parameters.Add(PostgresSession.Text(ownerId));
                storedHash = (string?)await select.ExecuteScalarAsync(cancellationToken);
            }

            if (storedHash is null)
            {
                return ShareRevokeOutcome.NotFound;
            }

            var given = SHA256.HashData(Encoding.UTF8.GetBytes(revokeKey ?? string.Empty));
            var want = Convert.FromHexString(storedHash);
            if (given.Length != want.Length || !CryptographicOperations.FixedTimeEquals(given, want))
            {
                return ShareRevokeOutcome.BadKey;
            }

            await using (var delete = new NpgsqlCommand(
                "DELETE FROM forgex.shares WHERE token=$1 AND tenant_id=$2 AND owner_id=$3",
                connection,
                transaction))
            {
                delete.Parameters.Add(PostgresSession.Text(key));
                delete.Parameters.Add(PostgresSession.Text(tenantId));
                delete.Parameters.Add(PostgresSession.Text(ownerId));
                await delete.ExecuteNonQueryAsync(cancellationToken);
            }

            return ShareRevokeOutcome.Revoked;
        }, cancellationToken);
    }

    /// <summary>
    /// Live shares across the (tenant, owner) pairs this process has created for. RLS hides
    /// everything else, so — exactly like the Node store's <c>size</c> — this is a process-local view.
    /// </summary>
    public async Task<long> CountAsync(CancellationToken cancellationToken)
    {
        long total = 0;
        foreach (var (tenantId, ownerId) in _seenOwners.Keys)
        {
            total += await _session.WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
            {
                await using var count = new NpgsqlCommand(
                    "SELECT count(*) FROM forgex.shares WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc > $3",
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
                    "DELETE FROM forgex.shares WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc <= $3",
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

    private static ShareRecord Map(NpgsqlDataReader reader)
    {
        return new ShareRecord(
            reader.GetString(reader.GetOrdinal("token")),
            reader.GetString(reader.GetOrdinal("tenant_id")),
            reader.GetString(reader.GetOrdinal("owner_id")),
            reader.GetString(reader.GetOrdinal("revoke_hash")),
            reader.GetString(reader.GetOrdinal("report_json")),
            reader.GetString(reader.GetOrdinal("question")),
            reader.GetString(reader.GetOrdinal("engine")),
            PostgresSession.ReadNullableString(reader, "upstream_task_id"),
            PostgresSession.ReadTimestamp(reader, "created_at_utc"),
            PostgresSession.ReadTimestamp(reader, "expires_at_utc"),
            reader.GetInt64(reader.GetOrdinal("access_count")),
            PostgresSession.ReadNullableTimestamp(reader, "last_accessed_at_utc"));
    }

    private static DateTimeOffset ReadTimestamp(NpgsqlDataReader reader, int ordinal)
    {
        var value = reader.GetFieldValue<DateTime>(ordinal);
        return new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc));
    }
}
