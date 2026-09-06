using System.Security.Cryptography;
using System.Text;
using ForgeX.Application;

namespace ForgeX.Infrastructure;

/// <summary>
/// 单进程 file 腿的分享存储——Node <c>server/services/share.js</c>（ShareStore）的 C# 对等物。
/// token / revokeKey 形状、TTL 上限、读时过期删除、访问计数、每所有者上限淘汰
/// 与 <see cref="PostgresShareRepository"/> 完全一致；唯一差别是持久化介质。
/// </summary>
public sealed class FileShareRepository : IShareRepository
{
    private sealed record SharePayload(
        string RevokeHash,
        string ReportJson,
        string Question,
        string Engine,
        string? UpstreamTaskId,
        long AccessCount,
        long? LastAccessedAt);

    private readonly JsonFileCollection<SharePayload> _files;
    private readonly TimeSpan _ttl;
    private readonly int _maxSharesPerOwner;

    public FileShareRepository(
        string directory,
        TimeSpan? ttl = null,
        int maxSharesPerOwner = PostgresShareRepository.DefaultMaxSharesPerOwner)
    {
        if (maxSharesPerOwner < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxSharesPerOwner));
        }

        _files = new JsonFileCollection<SharePayload>(directory);
        _ttl = ttl is { } value && value > TimeSpan.Zero ? value : PostgresShareRepository.DefaultTtl;
        _maxSharesPerOwner = maxSharesPerOwner;
    }

    public TimeSpan Ttl => _ttl;

    public string ResourceName => "shares";

    public Task ProbeAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Directory.CreateDirectory(_files.RootDirectory);
        return Task.CompletedTask;
    }

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

        using (await _files.LockAsync(cancellationToken))
        {
            await _files.PutAsync(
                new FileEnvelope<SharePayload>(
                    token,
                    tenantId,
                    ownerId,
                    createdAt.ToUnixTimeMilliseconds(),
                    expiresAt.ToUnixTimeMilliseconds(),
                    Builtin: false,
                    new SharePayload(revokeHash, reportJson, question, engine, upstreamTaskId, 0, null)),
                cancellationToken);
            await _files.EvictBeyondAsync(tenantId, ownerId, _maxSharesPerOwner, createdAt.ToUnixTimeMilliseconds(), cancellationToken);
        }

        return new ShareCreated(token, revokeKey, expiresAt);
    }

    public async Task<ShareRecord?> GetPublicAsync(string token, CancellationToken cancellationToken)
    {
        var key = token ?? string.Empty;
        using (await _files.LockAsync(cancellationToken))
        {
            var now = DateTimeOffset.UtcNow;
            // Expiry is handled below (delete-on-read, like the PG twin), so the lookup itself must not filter it.
            var envelope = await _files.GetAsync(key, tenantId: null, ownerId: null, long.MinValue, cancellationToken);
            if (envelope is null)
            {
                return null;
            }

            if (envelope.IsExpired(now.ToUnixTimeMilliseconds()))
            {
                await _files.DeleteAsync(envelope.Id, cancellationToken);
                return null;
            }

            var bumped = envelope with
            {
                Payload = envelope.Payload with
                {
                    AccessCount = envelope.Payload.AccessCount + 1,
                    LastAccessedAt = now.ToUnixTimeMilliseconds(),
                },
            };
            await _files.PutAsync(bumped, cancellationToken);
            return Map(bumped);
        }
    }

    public async Task<ShareRevokeOutcome> RevokeAsync(
        string token,
        string? revokeKey,
        string tenantId,
        string ownerId,
        CancellationToken cancellationToken)
    {
        var key = token ?? string.Empty;
        using (await _files.LockAsync(cancellationToken))
        {
            var envelope = await _files.GetAsync(key, tenantId, ownerId, long.MinValue, cancellationToken);
            if (envelope is null || envelope.TenantId != tenantId || envelope.OwnerId != ownerId)
            {
                return ShareRevokeOutcome.NotFound;
            }

            var given = SHA256.HashData(Encoding.UTF8.GetBytes(revokeKey ?? string.Empty));
            var want = Convert.FromHexString(envelope.Payload.RevokeHash);
            if (given.Length != want.Length || !CryptographicOperations.FixedTimeEquals(given, want))
            {
                return ShareRevokeOutcome.BadKey;
            }

            await _files.DeleteAsync(envelope.Id, cancellationToken);
            return ShareRevokeOutcome.Revoked;
        }
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

    private static ShareRecord Map(FileEnvelope<SharePayload> envelope) =>
        new(
            envelope.Id,
            envelope.TenantId,
            envelope.OwnerId,
            envelope.Payload.RevokeHash,
            envelope.Payload.ReportJson,
            envelope.Payload.Question,
            envelope.Payload.Engine,
            envelope.Payload.UpstreamTaskId,
            DateTimeOffset.FromUnixTimeMilliseconds(envelope.CreatedAt),
            DateTimeOffset.FromUnixTimeMilliseconds(envelope.ExpiresAt ?? envelope.CreatedAt),
            envelope.Payload.AccessCount,
            envelope.Payload.LastAccessedAt is { } accessedAt
                ? DateTimeOffset.FromUnixTimeMilliseconds(accessedAt)
                : null);
}
