using System.Security.Cryptography;
using System.Text;
using Npgsql;
using NpgsqlTypes;

namespace ForgeX.Infrastructure;

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
/// PostgreSQL-backed share store. Behavioral twin of the Node implementation in
/// server/services/postgres-share.js: same table (forgex.shares), same RLS contract
/// (per-transaction GUCs app.tenant_id / app.owner_id, public reads via
/// app.share_public), same token/revoke-key shapes, same TTL capping, expiry-on-read
/// deletion, access counting, and per-owner eviction. Divergence here would fail the
/// Stage 8 dual-run comparison, so any intentional change must land in both runtimes.
/// </summary>
public sealed class PostgresShareRepository : IAsyncDisposable
{
    public static readonly TimeSpan DefaultTtl = TimeSpan.FromHours(24);
    public const int DefaultMaxSharesPerOwner = 2000;

    private readonly NpgsqlDataSource _dataSource;
    private readonly TimeSpan _ttl;
    private readonly int _maxSharesPerOwner;

    public PostgresShareRepository(
        string connectionString,
        TimeSpan? ttl = null,
        int maxSharesPerOwner = DefaultMaxSharesPerOwner)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new ArgumentException("A PostgreSQL connection string is required.", nameof(connectionString));
        }
        if (maxSharesPerOwner < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxSharesPerOwner));
        }

        var builder = new NpgsqlDataSourceBuilder(connectionString);
        builder.ConnectionStringBuilder.ApplicationName = "forgex-api";
        _dataSource = builder.Build();
        _ttl = ttl is { } value && value > TimeSpan.Zero ? value : DefaultTtl;
        _maxSharesPerOwner = maxSharesPerOwner;
    }

    public TimeSpan Ttl => _ttl;

    /// <summary>Readiness probe mirroring the Node store: touch the table under a local context.</summary>
    public Task ProbeAsync(CancellationToken cancellationToken) =>
        WithOwnerTransactionAsync("tn_local", "ow_local", async (connection, transaction) =>
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

        await WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
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
                insert.Parameters.Add(Text(token));
                insert.Parameters.Add(Text(tenantId));
                insert.Parameters.Add(Text(ownerId));
                insert.Parameters.Add(Text(revokeHash));
                insert.Parameters.Add(new NpgsqlParameter { Value = reportJson, NpgsqlDbType = NpgsqlDbType.Jsonb });
                insert.Parameters.Add(Text(question));
                insert.Parameters.Add(Text(engine));
                insert.Parameters.Add(new NpgsqlParameter { Value = (object?)upstreamTaskId ?? DBNull.Value, NpgsqlDbType = NpgsqlDbType.Varchar });
                insert.Parameters.Add(Timestamp(createdAt));
                insert.Parameters.Add(Timestamp(expiresAt));
                await insert.ExecuteNonQueryAsync(cancellationToken);
            }

            // Parity note: identical to the Node _evict query, including the ASC ordering
            // (rows beyond the cap ordered oldest-first are removed). Change both sides
            // together or the dual-run comparison will flag it.
            await using (var evict = new NpgsqlCommand(
                """
                DELETE FROM forgex.shares
                WHERE tenant_id=$1 AND owner_id=$2 AND token IN (
                  SELECT token FROM forgex.shares
                  WHERE tenant_id=$1 AND owner_id=$2
                  ORDER BY created_at_utc ASC, token ASC
                  OFFSET $3
                )
                """,
                connection,
                transaction))
            {
                evict.Parameters.Add(Text(tenantId));
                evict.Parameters.Add(Text(ownerId));
                evict.Parameters.Add(new NpgsqlParameter { Value = _maxSharesPerOwner, NpgsqlDbType = NpgsqlDbType.Integer });
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
        var record = await WithPublicTransactionAsync(async (connection, transaction) =>
        {
            await using var select = new NpgsqlCommand(
                "SELECT * FROM forgex.shares WHERE token=$1",
                connection,
                transaction);
            select.Parameters.Add(Text(key));
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            return await reader.ReadAsync(cancellationToken) ? Map(reader) : null;
        }, cancellationToken);

        if (record is null)
        {
            return null;
        }

        if (DateTimeOffset.UtcNow > record.ExpiresAt)
        {
            await WithOwnerTransactionAsync(record.TenantId, record.OwnerId, async (connection, transaction) =>
            {
                await using var delete = new NpgsqlCommand(
                    "DELETE FROM forgex.shares WHERE token=$1 AND tenant_id=$2 AND owner_id=$3",
                    connection,
                    transaction);
                delete.Parameters.Add(Text(record.Token));
                delete.Parameters.Add(Text(record.TenantId));
                delete.Parameters.Add(Text(record.OwnerId));
                await delete.ExecuteNonQueryAsync(cancellationToken);
                return true;
            }, cancellationToken);
            return null;
        }

        var access = await WithOwnerTransactionAsync(record.TenantId, record.OwnerId, async (connection, transaction) =>
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
            update.Parameters.Add(Text(record.Token));
            update.Parameters.Add(Timestamp(DateTimeOffset.UtcNow));
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
        return await WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
        {
            string? storedHash;
            await using (var select = new NpgsqlCommand(
                "SELECT revoke_hash FROM forgex.shares WHERE token=$1 AND tenant_id=$2 AND owner_id=$3",
                connection,
                transaction))
            {
                select.Parameters.Add(Text(key));
                select.Parameters.Add(Text(tenantId));
                select.Parameters.Add(Text(ownerId));
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
                delete.Parameters.Add(Text(key));
                delete.Parameters.Add(Text(tenantId));
                delete.Parameters.Add(Text(ownerId));
                await delete.ExecuteNonQueryAsync(cancellationToken);
            }

            return ShareRevokeOutcome.Revoked;
        }, cancellationToken);
    }

    public ValueTask DisposeAsync() => _dataSource.DisposeAsync();

    private async Task<T> WithOwnerTransactionAsync<T>(
        string tenantId,
        string ownerId,
        Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work,
        CancellationToken cancellationToken)
    {
        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var guc = new NpgsqlCommand(
            "SELECT set_config('app.tenant_id', $1, true), set_config('app.owner_id', $2, true)",
            connection,
            transaction))
        {
            guc.Parameters.Add(Text(tenantId));
            guc.Parameters.Add(Text(ownerId));
            await guc.ExecuteNonQueryAsync(cancellationToken);
        }

        var result = await work(connection, transaction);
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    private async Task<T> WithPublicTransactionAsync<T>(
        Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work,
        CancellationToken cancellationToken)
    {
        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var guc = new NpgsqlCommand(
            "SELECT set_config('app.share_public', '1', true)",
            connection,
            transaction))
        {
            await guc.ExecuteNonQueryAsync(cancellationToken);
        }

        var result = await work(connection, transaction);
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

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
            reader.IsDBNull(reader.GetOrdinal("upstream_task_id"))
                ? null
                : reader.GetString(reader.GetOrdinal("upstream_task_id")),
            ReadTimestamp(reader, reader.GetOrdinal("created_at_utc")),
            ReadTimestamp(reader, reader.GetOrdinal("expires_at_utc")),
            reader.GetInt64(reader.GetOrdinal("access_count")),
            reader.IsDBNull(reader.GetOrdinal("last_accessed_at_utc"))
                ? null
                : ReadTimestamp(reader, reader.GetOrdinal("last_accessed_at_utc")));
    }

    private static DateTimeOffset ReadTimestamp(NpgsqlDataReader reader, int ordinal)
    {
        var value = reader.GetFieldValue<DateTime>(ordinal);
        return new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc));
    }

    private static NpgsqlParameter Text(string value) =>
        new() { Value = value, NpgsqlDbType = NpgsqlDbType.Text };

    private static NpgsqlParameter Timestamp(DateTimeOffset value) =>
        new() { Value = value.UtcDateTime, NpgsqlDbType = NpgsqlDbType.TimestampTz };
}
