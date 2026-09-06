using Npgsql;
using NpgsqlTypes;

namespace ForgeX.Infrastructure;

/// <summary>
/// 所有 PostgreSQL 仓库共用的连接/事务外壳。每个事务都先用 set_config 写入
/// app.tenant_id / app.owner_id（以及公开读路径的 app.share_public），让 RLS 策略生效——
/// 与 Node 侧 <c>withOwner()</c> / <c>withPublic()</c> 完全一致。
/// </summary>
public sealed class PostgresSession : IAsyncDisposable
{
    private readonly NpgsqlDataSource _dataSource;

    public PostgresSession(string connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new ArgumentException("A PostgreSQL connection string is required.", nameof(connectionString));
        }

        var builder = new NpgsqlDataSourceBuilder(PostgresConnectionString.Normalize(connectionString));
        builder.ConnectionStringBuilder.ApplicationName = "forgex-api";
        _dataSource = builder.Build();
    }

    public async Task<T> WithOwnerTransactionAsync<T>(
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

    public async Task<T> WithPublicTransactionAsync<T>(
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

    public ValueTask DisposeAsync() => _dataSource.DisposeAsync();

    public static NpgsqlParameter Text(string value) =>
        new() { Value = value, NpgsqlDbType = NpgsqlDbType.Text };

    public static NpgsqlParameter NullableText(string? value) =>
        new() { Value = (object?)value ?? DBNull.Value, NpgsqlDbType = NpgsqlDbType.Text };

    public static NpgsqlParameter Jsonb(string json) =>
        new() { Value = json, NpgsqlDbType = NpgsqlDbType.Jsonb };

    public static NpgsqlParameter Integer(int value) =>
        new() { Value = value, NpgsqlDbType = NpgsqlDbType.Integer };

    public static NpgsqlParameter BigInt(long value) =>
        new() { Value = value, NpgsqlDbType = NpgsqlDbType.Bigint };

    public static NpgsqlParameter Timestamp(DateTimeOffset value) =>
        new() { Value = value.UtcDateTime, NpgsqlDbType = NpgsqlDbType.TimestampTz };

    public static NpgsqlParameter NullableTimestamp(DateTimeOffset? value) =>
        new()
        {
            Value = value.HasValue ? value.Value.UtcDateTime : DBNull.Value,
            NpgsqlDbType = NpgsqlDbType.TimestampTz,
        };

    public static DateTimeOffset ReadTimestamp(NpgsqlDataReader reader, string column)
    {
        var value = reader.GetFieldValue<DateTime>(reader.GetOrdinal(column));
        return new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc));
    }

    public static DateTimeOffset? ReadNullableTimestamp(NpgsqlDataReader reader, string column)
    {
        var ordinal = reader.GetOrdinal(column);
        if (reader.IsDBNull(ordinal))
        {
            return null;
        }

        var value = reader.GetFieldValue<DateTime>(ordinal);
        return new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc));
    }

    public static string? ReadNullableString(NpgsqlDataReader reader, string column)
    {
        var ordinal = reader.GetOrdinal(column);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }
}
