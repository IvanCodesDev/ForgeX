using System.Text.Json;
using System.Text.Json.Serialization;
using ForgeX.Application;

namespace ForgeX.Infrastructure;

/// <summary>
/// 每条记录一个 JSON 文件的租户/所有者感知集合。它是 Node <c>server/lib/store.js</c> 系列
/// file 存储在 C# 侧的对等物：单进程、零依赖、原子写（临时文件 + 覆盖移动）、
/// 过期即不可见、内建（builtin）记录免于清扫。
/// </summary>
public sealed record FileEnvelope<T>(
    string Id,
    string TenantId,
    string OwnerId,
    long CreatedAt,
    long? ExpiresAt,
    bool Builtin,
    T Payload)
{
    // Node FileStore._isExpired: `now > rec.expiresAt` (strict), builtin records never expire.
    public bool IsExpired(long nowMs) => !Builtin && ExpiresAt is { } expiresAt && nowMs > expiresAt;
}

public sealed class JsonFileCollection<T>
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _directory;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public JsonFileCollection(string directory)
    {
        if (string.IsNullOrWhiteSpace(directory))
        {
            throw new ArgumentException("A storage directory is required.", nameof(directory));
        }

        _directory = Path.GetFullPath(directory);
        Directory.CreateDirectory(_directory);
    }

    public string RootDirectory => _directory;

    /// <summary>Serialises multi-step operations (read-modify-write) inside one process.</summary>
    public async Task<IDisposable> LockAsync(CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        return new Releaser(_lock);
    }

    public static bool IsSafeId(string? id) => ResourceIds.IsSafe(id);

    /// <summary>
    /// Returns the live record for <paramref name="id"/>, or <c>null</c> when it is missing, expired,
    /// or belongs to another (tenant, owner). Builtin records are visible to every caller.
    /// </summary>
    public async Task<FileEnvelope<T>?> GetAsync(
        string id,
        string? tenantId,
        string? ownerId,
        long nowMs,
        CancellationToken cancellationToken)
    {
        if (!IsSafeId(id))
        {
            return null;
        }

        var envelope = await ReadAsync(PathFor(id), cancellationToken);
        if (envelope is null || envelope.IsExpired(nowMs))
        {
            return null;
        }

        return Visible(envelope, tenantId, ownerId) ? envelope : null;
    }

    /// <summary>Live records visible to (tenant, owner), oldest first (createdAt asc, id asc).</summary>
    public async Task<IReadOnlyList<FileEnvelope<T>>> ListAsync(
        string? tenantId,
        string? ownerId,
        long nowMs,
        CancellationToken cancellationToken)
    {
        var items = new List<FileEnvelope<T>>();
        foreach (var path in EnumerateFiles())
        {
            var envelope = await ReadAsync(path, cancellationToken);
            if (envelope is null || envelope.IsExpired(nowMs) || !Visible(envelope, tenantId, ownerId))
            {
                continue;
            }

            items.Add(envelope);
        }

        return items
            .OrderBy(item => item.CreatedAt)
            .ThenBy(item => item.Id, StringComparer.Ordinal)
            .ToList();
    }

    public async Task PutAsync(FileEnvelope<T> envelope, CancellationToken cancellationToken)
    {
        if (!IsSafeId(envelope.Id))
        {
            throw new ArgumentException($"Unsafe record id '{envelope.Id}'.", nameof(envelope));
        }

        var target = PathFor(envelope.Id);
        var partial = $"{target}.{Guid.NewGuid():N}.partial";
        var json = JsonSerializer.Serialize(envelope, SerializerOptions);
        await File.WriteAllTextAsync(partial, json, cancellationToken);
        File.Move(partial, target, overwrite: true);
    }

    public Task<bool> DeleteAsync(string id, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!IsSafeId(id))
        {
            return Task.FromResult(false);
        }

        var path = PathFor(id);
        if (!File.Exists(path))
        {
            return Task.FromResult(false);
        }

        File.Delete(path);
        return Task.FromResult(true);
    }

    /// <summary>
    /// Keeps the newest <paramref name="max"/> non-builtin live records for (tenant, owner) and deletes the rest
    /// (oldest first — decision A5). Returns the number of deleted records.
    /// </summary>
    public async Task<int> EvictBeyondAsync(
        string tenantId,
        string ownerId,
        int max,
        long nowMs,
        CancellationToken cancellationToken)
    {
        if (max <= 0)
        {
            return 0;
        }

        var owned = (await ListAsync(tenantId, ownerId, nowMs, cancellationToken))
            .Where(item => !item.Builtin && item.TenantId == tenantId && item.OwnerId == ownerId)
            .ToList();
        var surplus = owned.Count - max;
        if (surplus <= 0)
        {
            return 0;
        }

        var deleted = 0;
        foreach (var victim in owned.Take(surplus))
        {
            if (await DeleteAsync(victim.Id, cancellationToken))
            {
                deleted++;
            }
        }

        return deleted;
    }

    /// <summary>Live records across every tenant/owner (used by /metrics gauges).</summary>
    public async Task<long> CountAsync(long nowMs, CancellationToken cancellationToken)
    {
        long count = 0;
        foreach (var path in EnumerateFiles())
        {
            var envelope = await ReadAsync(path, cancellationToken);
            if (envelope is not null && !envelope.IsExpired(nowMs))
            {
                count++;
            }
        }

        return count;
    }

    /// <summary>Deletes expired non-builtin records; returns how many were removed.</summary>
    public async Task<int> SweepExpiredAsync(long nowMs, CancellationToken cancellationToken)
    {
        var removed = 0;
        foreach (var path in EnumerateFiles())
        {
            var envelope = await ReadAsync(path, cancellationToken);
            if (envelope is null || envelope.Builtin || !envelope.IsExpired(nowMs))
            {
                continue;
            }

            File.Delete(path);
            removed++;
        }

        return removed;
    }

    private static bool Visible(FileEnvelope<T> envelope, string? tenantId, string? ownerId)
    {
        if (envelope.Builtin)
        {
            return true;
        }

        if (tenantId is not null && envelope.TenantId != tenantId)
        {
            return false;
        }

        return ownerId is null || envelope.OwnerId == ownerId;
    }

    private string PathFor(string id) => Path.Combine(_directory, id + ".json");

    private IEnumerable<string> EnumerateFiles() =>
        Directory.Exists(_directory)
            ? Directory.EnumerateFiles(_directory, "*.json", SearchOption.TopDirectoryOnly)
            : Array.Empty<string>();

    private static async Task<FileEnvelope<T>?> ReadAsync(string path, CancellationToken cancellationToken)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync<FileEnvelope<T>>(stream, SerializerOptions, cancellationToken);
        }
        catch (JsonException)
        {
            // A torn or foreign file must not take the whole collection down; it is simply invisible.
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    private sealed class Releaser(SemaphoreSlim semaphore) : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                semaphore.Release();
            }
        }
    }
}

/// <summary>
/// 单文件 JSON 文档（原子写）。用于校准治理这种「一个状态文件」的存储形态，
/// 文件格式由调用方的 <typeparamref name="T"/> 决定，因此可以直接读写 Node 写出的 calibrations.json。
/// </summary>
public sealed class JsonFileDocument<T>
    where T : class
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        NewLine = "\n",
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // Node's JSON.stringify leaves non-ASCII text (Chinese notes / reasons) readable; a local state
        // file is never embedded in HTML, so the relaxed encoder keeps the two writers interchangeable.
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly string _path;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public JsonFileDocument(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("A document path is required.", nameof(path));
        }

        _path = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
    }

    public string FilePath => _path;

    public async Task<IDisposable> LockAsync(CancellationToken cancellationToken)
    {
        await _lock.WaitAsync(cancellationToken);
        return new Releaser(_lock);
    }

    public async Task<T?> LoadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_path))
        {
            return null;
        }

        await using var stream = File.OpenRead(_path);
        return await JsonSerializer.DeserializeAsync<T>(stream, SerializerOptions, cancellationToken);
    }

    public async Task SaveAsync(T document, CancellationToken cancellationToken)
    {
        var partial = $"{_path}.{Guid.NewGuid():N}.partial";
        var json = JsonSerializer.Serialize(document, SerializerOptions);
        await File.WriteAllTextAsync(partial, json, cancellationToken);
        File.Move(partial, _path, overwrite: true);
    }

    private sealed class Releaser(SemaphoreSlim semaphore) : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                semaphore.Release();
            }
        }
    }
}
