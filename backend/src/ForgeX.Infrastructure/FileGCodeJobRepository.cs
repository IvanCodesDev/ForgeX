using System.Text.Json;
using System.Text.Json.Serialization;
using ForgeX.Application;
using ForgeX.Domain;

namespace ForgeX.Infrastructure;

public sealed class FileGCodeJobRepository : IGCodeJobRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private readonly string _root;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public FileGCodeJobRepository(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        _root = Path.GetFullPath(root);
    }

    public async Task<CreateJobResult> CreateOrGetAsync(
        GCodeJobRecord candidate,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            Directory.CreateDirectory(_root);
            if (!string.IsNullOrWhiteSpace(candidate.IdempotencyKey))
            {
                foreach (var path in Directory.EnumerateFiles(_root, "*.json"))
                {
                    var existing = await ReadAsync(path, cancellationToken).ConfigureAwait(false);
                    if (!string.Equals(existing.TenantId, candidate.TenantId, StringComparison.Ordinal) ||
                        !string.Equals(existing.OwnerId, candidate.OwnerId, StringComparison.Ordinal) ||
                        !string.Equals(existing.IdempotencyKey, candidate.IdempotencyKey, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    return new CreateJobResult(
                        existing,
                        false,
                        !string.Equals(existing.Fingerprint, candidate.Fingerprint, StringComparison.Ordinal));
                }
            }

            await WriteAsync(candidate, cancellationToken).ConfigureAwait(false);
            return new CreateJobResult(candidate, true, false);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<GCodeJobRecord?> GetAsync(string id, CancellationToken cancellationToken)
    {
        ValidateId(id);
        if (!Directory.Exists(_root)) return null;
        var path = Path.Combine(_root, id + ".json");
        if (!File.Exists(path)) return null;
        return await ReadAsync(path, cancellationToken).ConfigureAwait(false);
    }

    public async Task<GCodeJobRecord?> GetOwnedAsync(
        string tenantId,
        string ownerId,
        string id,
        CancellationToken cancellationToken)
    {
        ValidateCallerContext(tenantId, ownerId);
        var job = await GetAsync(id, cancellationToken).ConfigureAwait(false);
        return job is not null &&
               string.Equals(job.TenantId, tenantId, StringComparison.Ordinal) &&
               string.Equals(job.OwnerId, ownerId, StringComparison.Ordinal)
            ? job
            : null;
    }

    public async Task<IReadOnlyList<GCodeJobRecord>> ListAsync(CancellationToken cancellationToken)
    {
        var jobs = new List<GCodeJobRecord>();
        if (!Directory.Exists(_root)) return jobs;
        foreach (var path in Directory.EnumerateFiles(_root, "*.json").Order(StringComparer.Ordinal))
        {
            jobs.Add(await ReadAsync(path, cancellationToken).ConfigureAwait(false));
        }

        return jobs;
    }

    public async Task<GCodeJobRecord> SaveAsync(GCodeJobRecord job, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            Directory.CreateDirectory(_root);
            await WriteAsync(job, cancellationToken).ConfigureAwait(false);
            return job;
        }
        finally
        {
            _gate.Release();
        }
    }

    private static async Task<GCodeJobRecord> ReadAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, true);
        var job = await JsonSerializer.DeserializeAsync<GCodeJobRecord>(stream, JsonOptions, cancellationToken)
            .ConfigureAwait(false) ?? throw new InvalidDataException($"Job record is empty: {Path.GetFileName(path)}");
        // Stage 3-B records did not yet contain tenant/owner fields. They remain readable only
        // inside the explicit local-development scope instead of becoming globally visible.
        return job with
        {
            TenantId = string.IsNullOrWhiteSpace(job.TenantId) ? "tn_local" : job.TenantId,
            OwnerId = string.IsNullOrWhiteSpace(job.OwnerId) ? "ow_local" : job.OwnerId,
        };
    }

    private async Task WriteAsync(GCodeJobRecord job, CancellationToken cancellationToken)
    {
        ValidateId(job.Id);
        ValidateCallerContext(job.TenantId, job.OwnerId);
        var finalPath = Path.Combine(_root, job.Id + ".json");
        var temporary = finalPath + $".{Guid.NewGuid():N}.partial";
        try
        {
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, true))
            {
                await JsonSerializer.SerializeAsync(stream, job, JsonOptions, cancellationToken).ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            File.Move(temporary, finalPath, true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static void ValidateId(string id)
    {
        if (id.Length != 32 || id.Any(static character => !char.IsAsciiHexDigit(character)))
        {
            throw new ArgumentException("Job id must contain exactly 32 hexadecimal characters.", nameof(id));
        }
    }

    private static void ValidateCallerContext(string tenantId, string ownerId)
    {
        if (!IsContextId(tenantId, "tn_") || !IsContextId(ownerId, "ow_"))
        {
            throw new ArgumentException("Tenant and owner ids must use canonical opaque context ids.");
        }
    }

    private static bool IsContextId(string value, string prefix)
    {
        if (value is "tn_local" or "ow_local") return value.StartsWith(prefix, StringComparison.Ordinal);
        return value.Length == prefix.Length + 32 &&
               value.StartsWith(prefix, StringComparison.Ordinal) &&
               value[prefix.Length..].All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    }
}
