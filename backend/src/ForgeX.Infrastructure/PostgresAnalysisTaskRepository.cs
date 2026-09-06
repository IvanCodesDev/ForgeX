using Npgsql;
using NpgsqlTypes;

namespace ForgeX.Infrastructure;

public sealed record AnalysisTaskRecord(
    string Id,
    string TenantId,
    string OwnerId,
    string Question,
    string DatasourceId,
    string Engine,
    string Provider,
    string CredentialScope,
    string Status,
    double Progress,
    string Phase,
    string Message,
    string? ReportJson,
    string? ErrorMessage,
    string? UpstreamTaskId,
    string EventsJson,
    DateTimeOffset CreatedAt,
    DateTimeOffset? FinishedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset UpdatedAt);

/// <summary>
/// Read-side access to forgex.node_analysis_tasks. Stage 8.1 boundary: the Node
/// runtime still owns the computation and writes every snapshot (one upsert per
/// progress event), so serving reads and event replay from this table gives C#
/// live visibility without duplicating the write path. Same RLS contract as the
/// Node store: per-transaction app.tenant_id / app.owner_id GUCs.
/// </summary>
public sealed class PostgresAnalysisTaskRepository : IAsyncDisposable
{
    private readonly PostgresSession _session;

    public PostgresAnalysisTaskRepository(string connectionString)
    {
        _session = new PostgresSession(connectionString);
    }

    public Task ProbeAsync(CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync("tn_local", "ow_local", async (connection, transaction) =>
        {
            await using var command = new NpgsqlCommand(
                "SELECT 1 FROM forgex.node_analysis_tasks LIMIT 0",
                connection,
                transaction);
            await command.ExecuteNonQueryAsync(cancellationToken);
            return true;
        }, cancellationToken);

    /// <summary>Owner-scoped history, newest first; expired records are filtered out.</summary>
    public Task<IReadOnlyList<AnalysisTaskRecord>> ListAsync(
        string tenantId,
        string ownerId,
        int limit,
        CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync<IReadOnlyList<AnalysisTaskRecord>>(tenantId, ownerId, async (connection, transaction) =>
        {
            await using var select = new NpgsqlCommand(
                """
                SELECT * FROM forgex.node_analysis_tasks
                WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc > $3
                ORDER BY created_at_utc DESC, id ASC
                LIMIT $4
                """,
                connection,
                transaction);
            select.Parameters.Add(Text(tenantId));
            select.Parameters.Add(Text(ownerId));
            select.Parameters.Add(Timestamp(DateTimeOffset.UtcNow));
            select.Parameters.Add(new NpgsqlParameter { Value = limit, NpgsqlDbType = NpgsqlDbType.Integer });
            var records = new List<AnalysisTaskRecord>();
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                records.Add(Map(reader));
            }
            return records;
        }, cancellationToken);

    /// <summary>Owner-scoped single read; expired records read as absent.</summary>
    public Task<AnalysisTaskRecord?> GetAsync(
        string tenantId,
        string ownerId,
        string id,
        CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
        {
            await using var select = new NpgsqlCommand(
                """
                SELECT * FROM forgex.node_analysis_tasks
                WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND expires_at_utc > $4
                """,
                connection,
                transaction);
            select.Parameters.Add(Text(tenantId));
            select.Parameters.Add(Text(ownerId));
            select.Parameters.Add(Text(id));
            select.Parameters.Add(Timestamp(DateTimeOffset.UtcNow));
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            return await reader.ReadAsync(cancellationToken) ? Map(reader) : null;
        }, cancellationToken);

    public ValueTask DisposeAsync() => _session.DisposeAsync();

    private static AnalysisTaskRecord Map(NpgsqlDataReader reader)
    {
        return new AnalysisTaskRecord(
            reader.GetString(reader.GetOrdinal("id")),
            reader.GetString(reader.GetOrdinal("tenant_id")),
            reader.GetString(reader.GetOrdinal("owner_id")),
            reader.GetString(reader.GetOrdinal("question")),
            reader.GetString(reader.GetOrdinal("datasource_id")),
            reader.GetString(reader.GetOrdinal("engine")),
            reader.GetString(reader.GetOrdinal("provider")),
            reader.GetString(reader.GetOrdinal("credential_scope")),
            reader.GetString(reader.GetOrdinal("status")),
            reader.GetDouble(reader.GetOrdinal("progress")),
            reader.GetString(reader.GetOrdinal("phase")),
            reader.GetString(reader.GetOrdinal("message")),
            NullableString(reader, "report_json"),
            NullableString(reader, "error_message"),
            NullableString(reader, "upstream_task_id"),
            reader.GetString(reader.GetOrdinal("events_json")),
            ReadTimestamp(reader, reader.GetOrdinal("created_at_utc")),
            reader.IsDBNull(reader.GetOrdinal("finished_at_utc"))
                ? null
                : ReadTimestamp(reader, reader.GetOrdinal("finished_at_utc")),
            ReadTimestamp(reader, reader.GetOrdinal("expires_at_utc")),
            ReadTimestamp(reader, reader.GetOrdinal("updated_at_utc")));
    }

    private static string? NullableString(NpgsqlDataReader reader, string column) =>
        PostgresSession.ReadNullableString(reader, column);

    private static DateTimeOffset ReadTimestamp(NpgsqlDataReader reader, int ordinal)
    {
        var value = reader.GetFieldValue<DateTime>(ordinal);
        return new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc));
    }

    private static NpgsqlParameter Text(string value) => PostgresSession.Text(value);

    private static NpgsqlParameter Timestamp(DateTimeOffset value) => PostgresSession.Timestamp(value);
}
