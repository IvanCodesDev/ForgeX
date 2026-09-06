using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ForgeX.Application;
using Npgsql;

namespace ForgeX.Infrastructure;

/// <summary>
/// 校准治理 PostgreSQL 腿——server/services/postgres-calibration.js 的行为孪生：同一对表
/// （forgex.calibration_submissions / calibration_releases）、同一套 RLS、部署级单租户
/// （tenant 来自配置而非调用方）。状态机与文案取 Node file 版（决策 A6），由
/// <see cref="CalibrationGovernanceRules"/> 提供；提交记录里的 bundle 保持 candidate 版。
/// </summary>
public sealed class PostgresCalibrationGovernanceStore : ICalibrationGovernanceStore, IAsyncDisposable
{
    private static readonly JsonSerializerOptions EventOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly PostgresSession _session;
    private readonly int _maxSubmissions;

    public PostgresCalibrationGovernanceStore(
        string connectionString,
        string tenantId = "tn_local",
        string? ownerId = null,
        int maxSubmissions = CalibrationGovernanceRules.DefaultMaxSubmissions)
    {
        if (maxSubmissions < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxSubmissions), maxSubmissions, "maxSubmissions must be at least 1.");
        }

        TenantId = tenantId;
        OwnerId = ownerId ?? OwnerIdFor(tenantId);
        if (!IsCanonical(TenantId, "tn_") || !IsCanonical(OwnerId, "ow_"))
        {
            throw new ArgumentException("PostgreSQL calibration tenant/owner context is invalid");
        }

        _session = new PostgresSession(connectionString);
        _maxSubmissions = maxSubmissions;
    }

    public string TenantId { get; }

    public string OwnerId { get; }

    /// <summary>Node postgres-calibration.js ownerIdFor(): tn_local → ow_local, otherwise ow_ + sha256(tenantId)[..32].</summary>
    public static string OwnerIdFor(string tenantId) =>
        tenantId == "tn_local"
            ? "ow_local"
            : "ow_" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(tenantId)))[..32];

    public Task ProbeAsync(CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync(TenantId, OwnerId, async (connection, transaction) =>
        {
            await using var command = new NpgsqlCommand("SELECT 1 FROM forgex.calibration_submissions LIMIT 0", connection, transaction);
            await command.ExecuteNonQueryAsync(cancellationToken);
            return true;
        }, cancellationToken);

    public Task<IReadOnlyList<CalibrationRelease>> ListApprovedAsync(CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync<IReadOnlyList<CalibrationRelease>>(TenantId, OwnerId, async (connection, transaction) =>
        {
            await using var select = new NpgsqlCommand(
                "SELECT bundle_id, revision, digest, bundle_json, approved_at_utc, approved_by FROM forgex.calibration_releases WHERE tenant_id=$1 ORDER BY bundle_id",
                connection,
                transaction);
            select.Parameters.Add(PostgresSession.Text(TenantId));
            var releases = new List<CalibrationRelease>();
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                releases.Add(new CalibrationRelease(
                    reader.GetString(reader.GetOrdinal("bundle_id")),
                    reader.GetInt32(reader.GetOrdinal("revision")),
                    reader.GetString(reader.GetOrdinal("digest")),
                    ParseElement(reader.GetString(reader.GetOrdinal("bundle_json"))),
                    PostgresSession.ReadTimestamp(reader, "approved_at_utc").ToUnixTimeMilliseconds(),
                    reader.GetString(reader.GetOrdinal("approved_by"))));
            }

            return releases;
        }, cancellationToken);

    public Task<IReadOnlyList<CalibrationSubmission>> ListSubmissionsAsync(CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync<IReadOnlyList<CalibrationSubmission>>(TenantId, OwnerId, async (connection, transaction) =>
        {
            await using var select = new NpgsqlCommand(
                "SELECT * FROM forgex.calibration_submissions WHERE tenant_id=$1 AND owner_id=$2 ORDER BY created_at_utc DESC",
                connection,
                transaction);
            select.Parameters.Add(PostgresSession.Text(TenantId));
            select.Parameters.Add(PostgresSession.Text(OwnerId));
            var submissions = new List<CalibrationSubmission>();
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                submissions.Add(Map(reader));
            }

            return submissions;
        }, cancellationToken);

    public Task<CalibrationGovernanceStats> StatsAsync(CancellationToken cancellationToken) =>
        _session.WithOwnerTransactionAsync(TenantId, OwnerId, async (connection, transaction) =>
        {
            await using var select = new NpgsqlCommand(
                """
                SELECT
                  (SELECT count(*)::int FROM forgex.calibration_releases WHERE tenant_id=$1) AS approved,
                  (SELECT count(*)::int FROM forgex.calibration_submissions WHERE tenant_id=$1 AND owner_id=$2 AND status='pending') AS pending
                """,
                connection,
                transaction);
            select.Parameters.Add(PostgresSession.Text(TenantId));
            select.Parameters.Add(PostgresSession.Text(OwnerId));
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            await reader.ReadAsync(cancellationToken);
            return new CalibrationGovernanceStats(reader.GetInt32(0), reader.GetInt32(1));
        }, cancellationToken);

    public Task<CalibrationGovernanceOutcome> SubmitAsync(JsonElement? bundle, JsonElement? note, string actor, CancellationToken cancellationToken)
    {
        var preparation = CalibrationGovernanceRules.PrepareSubmit(bundle);
        if (preparation.Failure is not null)
        {
            return Task.FromResult(preparation.Failure);
        }

        var key = CalibrationGovernanceRules.SubmissionKey(preparation.Id, preparation.Revision);
        return _session.WithOwnerTransactionAsync(TenantId, OwnerId, async (connection, transaction) =>
        {
            bool duplicateExists;
            await using (var existing = new NpgsqlCommand(
                "SELECT key FROM forgex.calibration_submissions WHERE tenant_id=$1 AND owner_id=$2 AND key=$3",
                connection,
                transaction))
            {
                existing.Parameters.Add(PostgresSession.Text(TenantId));
                existing.Parameters.Add(PostgresSession.Text(OwnerId));
                existing.Parameters.Add(PostgresSession.Text(key));
                duplicateExists = await existing.ExecuteScalarAsync(cancellationToken) is not null;
            }

            var approvedRevision = await ReadApprovedRevisionAsync(connection, transaction, preparation.Id, forUpdate: false, cancellationToken);
            var outcome = CalibrationGovernanceRules.CompleteSubmit(
                preparation,
                note,
                actor,
                duplicateExists,
                approvedRevision,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (!outcome.Ok)
            {
                return outcome;
            }

            var record = outcome.Submission!;
            await using (var insert = new NpgsqlCommand(
                """
                INSERT INTO forgex.calibration_submissions
                  (tenant_id, owner_id, key, bundle_id, revision, status, digest, bundle_json,
                   created_at_utc, updated_at_utc, submitted_by, note, events_json)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12)
                """,
                connection,
                transaction))
            {
                insert.Parameters.Add(PostgresSession.Text(TenantId));
                insert.Parameters.Add(PostgresSession.Text(OwnerId));
                insert.Parameters.Add(PostgresSession.Text(record.Key));
                insert.Parameters.Add(PostgresSession.Text(record.Id));
                insert.Parameters.Add(PostgresSession.Integer(record.Revision));
                insert.Parameters.Add(PostgresSession.Text(record.Status));
                insert.Parameters.Add(PostgresSession.Text(record.Digest));
                insert.Parameters.Add(PostgresSession.Jsonb(record.Bundle.GetRawText()));
                insert.Parameters.Add(PostgresSession.Timestamp(DateTimeOffset.FromUnixTimeMilliseconds(record.CreatedAt)));
                insert.Parameters.Add(PostgresSession.Text(record.SubmittedBy));
                insert.Parameters.Add(PostgresSession.Text(record.Note));
                insert.Parameters.Add(PostgresSession.Jsonb(JsonSerializer.Serialize(record.Events, EventOptions)));
                await insert.ExecuteNonQueryAsync(cancellationToken);
            }

            await using (var evict = new NpgsqlCommand(
                """
                DELETE FROM forgex.calibration_submissions
                WHERE tenant_id=$1 AND owner_id=$2 AND key IN (
                  SELECT key FROM forgex.calibration_submissions
                  WHERE tenant_id=$1 AND owner_id=$2 AND status <> 'pending'
                  ORDER BY updated_at_utc ASC
                  LIMIT GREATEST((SELECT count(*) FROM forgex.calibration_submissions
                                  WHERE tenant_id=$1 AND owner_id=$2) - $3, 0)
                )
                """,
                connection,
                transaction))
            {
                evict.Parameters.Add(PostgresSession.Text(TenantId));
                evict.Parameters.Add(PostgresSession.Text(OwnerId));
                evict.Parameters.Add(PostgresSession.Integer(_maxSubmissions));
                await evict.ExecuteNonQueryAsync(cancellationToken);
            }

            return outcome;
        }, cancellationToken);
    }

    public Task<CalibrationGovernanceOutcome> ReviewAsync(string id, int revision, JsonElement? decision, JsonElement? reason, string actor, CancellationToken cancellationToken)
    {
        var key = CalibrationGovernanceRules.SubmissionKey(id, revision);
        return _session.WithOwnerTransactionAsync(TenantId, OwnerId, async (connection, transaction) =>
        {
            CalibrationSubmission? existing = null;
            await using (var found = new NpgsqlCommand(
                "SELECT * FROM forgex.calibration_submissions WHERE tenant_id=$1 AND owner_id=$2 AND key=$3 FOR UPDATE",
                connection,
                transaction))
            {
                found.Parameters.Add(PostgresSession.Text(TenantId));
                found.Parameters.Add(PostgresSession.Text(OwnerId));
                found.Parameters.Add(PostgresSession.Text(key));
                await using var reader = await found.ExecuteReaderAsync(cancellationToken);
                if (await reader.ReadAsync(cancellationToken))
                {
                    existing = Map(reader);
                }
            }

            var approvedRevision = existing is null
                ? null
                : await ReadApprovedRevisionAsync(connection, transaction, existing.Id, forUpdate: true, cancellationToken);
            var outcome = CalibrationGovernanceRules.DecideReview(
                existing,
                decision,
                reason,
                actor,
                approvedRevision,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                out var release);
            if (!outcome.Ok)
            {
                return outcome;
            }

            if (release is not null)
            {
                await using var upsert = new NpgsqlCommand(
                    """
                    INSERT INTO forgex.calibration_releases
                      (tenant_id, owner_id, bundle_id, revision, digest, bundle_json, approved_at_utc, approved_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                    ON CONFLICT (tenant_id, bundle_id) DO UPDATE SET
                      owner_id=EXCLUDED.owner_id, revision=EXCLUDED.revision, digest=EXCLUDED.digest,
                      bundle_json=EXCLUDED.bundle_json, approved_at_utc=EXCLUDED.approved_at_utc, approved_by=EXCLUDED.approved_by
                    """,
                    connection,
                    transaction);
                upsert.Parameters.Add(PostgresSession.Text(TenantId));
                upsert.Parameters.Add(PostgresSession.Text(OwnerId));
                upsert.Parameters.Add(PostgresSession.Text(release.Id));
                upsert.Parameters.Add(PostgresSession.Integer(release.Revision));
                upsert.Parameters.Add(PostgresSession.Text(release.Digest));
                upsert.Parameters.Add(PostgresSession.Jsonb(release.Bundle.GetRawText()));
                upsert.Parameters.Add(PostgresSession.Timestamp(DateTimeOffset.FromUnixTimeMilliseconds(release.ApprovedAt)));
                upsert.Parameters.Add(PostgresSession.Text(release.ApprovedBy));
                await upsert.ExecuteNonQueryAsync(cancellationToken);
            }

            var record = outcome.Submission!;
            await using (var update = new NpgsqlCommand(
                """
                UPDATE forgex.calibration_submissions
                SET status=$4, updated_at_utc=$5, reviewed_by=$6, review_reason=$7, bundle_json=$8, events_json=$9
                WHERE tenant_id=$1 AND owner_id=$2 AND key=$3
                """,
                connection,
                transaction))
            {
                update.Parameters.Add(PostgresSession.Text(TenantId));
                update.Parameters.Add(PostgresSession.Text(OwnerId));
                update.Parameters.Add(PostgresSession.Text(key));
                update.Parameters.Add(PostgresSession.Text(record.Status));
                update.Parameters.Add(PostgresSession.Timestamp(DateTimeOffset.FromUnixTimeMilliseconds(record.UpdatedAt)));
                update.Parameters.Add(PostgresSession.Text(record.ReviewedBy!));
                update.Parameters.Add(PostgresSession.Text(record.ReviewReason!));
                update.Parameters.Add(PostgresSession.Jsonb(record.Bundle.GetRawText()));
                update.Parameters.Add(PostgresSession.Jsonb(JsonSerializer.Serialize(record.Events, EventOptions)));
                await update.ExecuteNonQueryAsync(cancellationToken);
            }

            return outcome;
        }, cancellationToken);
    }

    public ValueTask DisposeAsync() => _session.DisposeAsync();

    private async Task<int?> ReadApprovedRevisionAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, string bundleId, bool forUpdate, CancellationToken cancellationToken)
    {
        await using var select = new NpgsqlCommand(
            "SELECT revision FROM forgex.calibration_releases WHERE tenant_id=$1 AND bundle_id=$2" + (forUpdate ? " FOR UPDATE" : string.Empty),
            connection,
            transaction);
        select.Parameters.Add(PostgresSession.Text(TenantId));
        select.Parameters.Add(PostgresSession.Text(bundleId));
        return await select.ExecuteScalarAsync(cancellationToken) is int revision ? revision : null;
    }

    private static CalibrationSubmission Map(NpgsqlDataReader reader)
    {
        var events = JsonSerializer.Deserialize<List<CalibrationEvent>>(reader.GetString(reader.GetOrdinal("events_json")), EventOptions) ?? [];
        return new CalibrationSubmission(
            reader.GetString(reader.GetOrdinal("key")),
            reader.GetString(reader.GetOrdinal("bundle_id")),
            reader.GetInt32(reader.GetOrdinal("revision")),
            reader.GetString(reader.GetOrdinal("status")),
            reader.GetString(reader.GetOrdinal("digest")),
            ParseElement(reader.GetString(reader.GetOrdinal("bundle_json"))),
            PostgresSession.ReadTimestamp(reader, "created_at_utc").ToUnixTimeMilliseconds(),
            PostgresSession.ReadTimestamp(reader, "updated_at_utc").ToUnixTimeMilliseconds(),
            reader.GetString(reader.GetOrdinal("submitted_by")),
            PostgresSession.ReadNullableString(reader, "note") ?? string.Empty,
            events,
            PostgresSession.ReadNullableString(reader, "reviewed_by"),
            PostgresSession.ReadNullableString(reader, "review_reason"));
    }

    private static JsonElement ParseElement(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static bool IsCanonical(string value, string prefix) =>
        value == prefix + "local" ||
        (value.Length == prefix.Length + 32 &&
         value.StartsWith(prefix, StringComparison.Ordinal) &&
         value[prefix.Length..].All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f'));
}
