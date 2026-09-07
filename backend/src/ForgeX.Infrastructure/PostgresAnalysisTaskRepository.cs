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
/// Access to forgex.node_analysis_tasks. Stage 8.1 gave C# the read side (history, snapshot,
/// event replay) of the snapshots Node upserts once per progress event. Stage 8.6c-2b adds the
/// write side with the very same upsert shape, so a task created by C# and a task created by
/// Node are indistinguishable rows: Node's PostgresAnalysisStore.ready() can still load them and
/// the read endpoints serve both. Same RLS contract: per-transaction app.tenant_id / app.owner_id.
/// </summary>
public sealed class PostgresAnalysisTaskRepository : IAsyncDisposable
{
    /// <summary>Node PostgresAnalysisStore.ready() marks interrupted work with this exact message.</summary>
    public const string InterruptedMessage = "服务重启时任务中断";

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

    /// <summary>
    /// Full-snapshot upsert — the same statement Node's PostgresAnalysisStore._save issues, so a
    /// C#-owned task row is byte-compatible with a Node-owned one (Stage 8.6c-2b).
    /// </summary>
    public Task UpsertAsync(AnalysisTaskRecord record, CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync(record.TenantId, record.OwnerId, async (connection, transaction) =>
        {
            await using var upsert = new NpgsqlCommand(
                """
                INSERT INTO forgex.node_analysis_tasks
                  (id, tenant_id, owner_id, question, datasource_id, engine, provider, credential_scope,
                   status, progress, phase, message, report_json, error_message, upstream_task_id,
                   events_json, created_at_utc, finished_at_utc, expires_at_utc, updated_at_utc)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                ON CONFLICT (id) DO UPDATE SET
                  status=EXCLUDED.status, progress=EXCLUDED.progress, phase=EXCLUDED.phase,
                  message=EXCLUDED.message, report_json=EXCLUDED.report_json,
                  error_message=EXCLUDED.error_message, upstream_task_id=EXCLUDED.upstream_task_id,
                  events_json=EXCLUDED.events_json, finished_at_utc=EXCLUDED.finished_at_utc,
                  expires_at_utc=EXCLUDED.expires_at_utc, updated_at_utc=EXCLUDED.updated_at_utc
                """,
                connection,
                transaction);
            upsert.Parameters.Add(Text(record.Id));
            upsert.Parameters.Add(Text(record.TenantId));
            upsert.Parameters.Add(Text(record.OwnerId));
            upsert.Parameters.Add(Text(record.Question));
            upsert.Parameters.Add(Text(record.DatasourceId));
            upsert.Parameters.Add(Text(record.Engine));
            upsert.Parameters.Add(Text(record.Provider));
            upsert.Parameters.Add(Text(record.CredentialScope));
            upsert.Parameters.Add(Text(record.Status));
            upsert.Parameters.Add(new NpgsqlParameter { Value = record.Progress, NpgsqlDbType = NpgsqlDbType.Double });
            upsert.Parameters.Add(Text(record.Phase));
            upsert.Parameters.Add(Text(record.Message));
            upsert.Parameters.Add(NullableJsonb(record.ReportJson));
            upsert.Parameters.Add(PostgresSession.NullableText(record.ErrorMessage));
            upsert.Parameters.Add(PostgresSession.NullableText(record.UpstreamTaskId));
            upsert.Parameters.Add(PostgresSession.Jsonb(record.EventsJson));
            upsert.Parameters.Add(Timestamp(record.CreatedAt));
            upsert.Parameters.Add(PostgresSession.NullableTimestamp(record.FinishedAt));
            upsert.Parameters.Add(Timestamp(record.ExpiresAt));
            upsert.Parameters.Add(Timestamp(record.UpdatedAt));
            await upsert.ExecuteNonQueryAsync(cancellationToken);
            return true;
        }, cancellationToken);

    /// <summary>
    /// Node's ready() recovery, made RLS-friendly: for one (tenant, owner) mark running rows that
    /// nobody has touched since <paramref name="staleBefore"/> as failed with Node's exact message.
    /// The staleness guard is what keeps a concurrent live worker's task alive; the caller passes
    /// the ids it is executing itself so they are never recovered from under it.
    /// </summary>
    public Task<int> RecoverStaleAsync(
        string tenantId,
        string ownerId,
        DateTimeOffset staleBefore,
        IReadOnlyCollection<string> liveIds,
        CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync(tenantId, ownerId, async (connection, transaction) =>
        {
            await using var update = new NpgsqlCommand(
                """
                UPDATE forgex.node_analysis_tasks
                SET status='failed', error_message=$4, finished_at_utc=$5, progress=1, phase='recovered', updated_at_utc=$5
                WHERE tenant_id=$1 AND owner_id=$2 AND status='running' AND updated_at_utc < $3 AND NOT (id = ANY($6))
                """,
                connection,
                transaction);
            var now = DateTimeOffset.UtcNow;
            update.Parameters.Add(Text(tenantId));
            update.Parameters.Add(Text(ownerId));
            update.Parameters.Add(Timestamp(staleBefore));
            update.Parameters.Add(Text(InterruptedMessage));
            update.Parameters.Add(Timestamp(now));
            update.Parameters.Add(new NpgsqlParameter
            {
                Value = liveIds.ToArray(),
                NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Text,
            });
            return await update.ExecuteNonQueryAsync(cancellationToken);
        }, cancellationToken);

    public ValueTask DisposeAsync() => _session.DisposeAsync();

    private static NpgsqlParameter NullableJsonb(string? json) =>
        new() { Value = (object?)json ?? DBNull.Value, NpgsqlDbType = NpgsqlDbType.Jsonb };

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
