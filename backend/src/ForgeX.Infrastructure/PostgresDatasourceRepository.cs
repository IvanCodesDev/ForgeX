using Npgsql;
using NpgsqlTypes;

namespace ForgeX.Infrastructure;

public sealed record DatasourceRecord(
    string Id,
    string TenantId,
    string OwnerId,
    string Name,
    string Csv,
    string RowsJson,
    string ContentSha256,
    string CacheKey,
    string WarningsJson,
    string ProvenanceJson,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ExpiresAt);

/// <summary>
/// Stage 8.4: read access to forgex.datasources so the analysis-task compute leg can
/// resolve a datasourceId without Node shipping the full row payload. Behavioral twin
/// of the read side of server/services/postgres-datasource.js: same table, same RLS
/// contract (per-transaction app.tenant_id / app.owner_id GUCs), same field mapping
/// (rows_json / content_sha256 / cache_key / warnings_json / provenance_json), and the
/// same expiry semantics — a record whose expires_at_utc has passed reads as absent.
/// The builtin "sample" datasource lives only in Node memory (it is rebuilt from code
/// on every start and never persisted), so it is not resolvable here by design; the
/// Node migration proxy keeps sending inline rows for builtin datasources.
/// </summary>
public sealed class PostgresDatasourceRepository : IAsyncDisposable
{
    private readonly NpgsqlDataSource _dataSource;

    public PostgresDatasourceRepository(string connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new ArgumentException("A PostgreSQL connection string is required.", nameof(connectionString));
        }

        var builder = new NpgsqlDataSourceBuilder(connectionString);
        builder.ConnectionStringBuilder.ApplicationName = "forgex-api";
        _dataSource = builder.Build();
    }

    /// <summary>
    /// Schema constraint: id char shape ds_ + 24 lowercase hex (0003_datasources.sql).
    /// Anything else — including the Node-only builtin "sample" — can never exist in
    /// the table, so callers may reject it up front with the same stable not-found.
    /// </summary>
    public static bool IsPersistedId(string id)
    {
        if (id.Length != 27 || !id.StartsWith("ds_", StringComparison.Ordinal))
        {
            return false;
        }

        for (var index = 3; index < id.Length; index++)
        {
            if (id[index] is not (>= '0' and <= '9' or >= 'a' and <= 'f'))
            {
                return false;
            }
        }

        return true;
    }

    public Task ProbeAsync(CancellationToken cancellationToken) =>
        WithOwnerTransactionAsync("tn_local", "ow_local", async (connection, transaction) =>
        {
            await using var command = new NpgsqlCommand(
                "SELECT 1 FROM forgex.datasources LIMIT 0",
                connection,
                transaction);
            await command.ExecuteNonQueryAsync(cancellationToken);
            return true;
        }, cancellationToken);

    /// <summary>
    /// Owner-scoped single read. Wrong tenant/owner reads as absent through RLS plus
    /// the explicit predicate, exactly like the Node store. Expiry mirrors the Node
    /// get() check (`Date.now() > expiresAt` reads as absent): live while now is at
    /// or before expires_at_utc, and records without an expiry never expire.
    /// </summary>
    public Task<DatasourceRecord?> GetAsync(
        string tenantId,
        string ownerId,
        string id,
        CancellationToken cancellationToken) =>
        WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
        {
            await using var select = new NpgsqlCommand(
                """
                SELECT * FROM forgex.datasources
                WHERE id=$1 AND tenant_id=$2 AND owner_id=$3
                  AND (expires_at_utc IS NULL OR expires_at_utc >= $4)
                """,
                connection,
                transaction);
            select.Parameters.Add(Text(id));
            select.Parameters.Add(Text(tenantId));
            select.Parameters.Add(Text(ownerId));
            select.Parameters.Add(Timestamp(DateTimeOffset.UtcNow));
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            return await reader.ReadAsync(cancellationToken) ? Map(reader) : null;
        }, cancellationToken);

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

    private static DatasourceRecord Map(NpgsqlDataReader reader)
    {
        return new DatasourceRecord(
            reader.GetString(reader.GetOrdinal("id")),
            reader.GetString(reader.GetOrdinal("tenant_id")),
            reader.GetString(reader.GetOrdinal("owner_id")),
            reader.GetString(reader.GetOrdinal("name")),
            reader.GetString(reader.GetOrdinal("csv")),
            reader.GetString(reader.GetOrdinal("rows_json")),
            reader.GetString(reader.GetOrdinal("content_sha256")),
            reader.GetString(reader.GetOrdinal("cache_key")),
            reader.GetString(reader.GetOrdinal("warnings_json")),
            reader.GetString(reader.GetOrdinal("provenance_json")),
            ReadTimestamp(reader, reader.GetOrdinal("created_at_utc")),
            reader.IsDBNull(reader.GetOrdinal("expires_at_utc"))
                ? null
                : ReadTimestamp(reader, reader.GetOrdinal("expires_at_utc")));
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
