using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using ForgeX.Application;
using ForgeX.Domain;

namespace ForgeX.Infrastructure;

public sealed partial class FileGCodeJobRepository
{
    private const string BackupFormat = "forgex-gcode-job-backup/v1";
    private const string ProviderName = "file-json";
    private const int RepositorySchemaVersion = 1;
    private const long MaxBackupBytes = 512L * 1024 * 1024;
    private const long MaxJobRecordBytes = 16L * 1024 * 1024;
    private const int MaxBackupEntries = 100_000;
    private static readonly DateTimeOffset StableZipTimestamp = new(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);

    public async Task<JobRepositoryHealth> ProbeAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        var probe = Path.Combine(_root, $".{Guid.NewGuid():N}.probe");
        try
        {
            Directory.CreateDirectory(_root);
            await File.WriteAllBytesAsync(probe, [], cancellationToken).ConfigureAwait(false);
            foreach (var path in Directory.EnumerateFiles(_root, "*.json").Order(StringComparer.Ordinal))
            {
                var job = await ReadAsync(path, cancellationToken).ConfigureAwait(false);
                if (!string.Equals(Path.GetFileNameWithoutExtension(path), job.Id, StringComparison.Ordinal))
                {
                    return new JobRepositoryHealth(ProviderName, RepositorySchemaVersion, false, 0, "JOB_FILE_ID_MISMATCH");
                }
            }

            var count = Directory.EnumerateFiles(_root, "*.json").LongCount();
            return new JobRepositoryHealth(ProviderName, RepositorySchemaVersion, true, count);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException or JsonException)
        {
            return new JobRepositoryHealth(ProviderName, RepositorySchemaVersion, false, 0, "JOB_REPOSITORY_UNAVAILABLE");
        }
        finally
        {
            try
            {
                if (File.Exists(probe)) File.Delete(probe);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // Probe cleanup failure must not mask the repository health result.
            }
            _gate.Release();
        }
    }

    public async Task<JobBackupSummary> BackupAsync(Stream destination, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(destination);
        if (!destination.CanWrite) throw new ArgumentException("Backup destination must be writable.", nameof(destination));

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var payloads = new List<BackupPayload>();
            long totalPayloadBytes = 0;
            if (Directory.Exists(_root))
            {
                foreach (var path in Directory.EnumerateFiles(_root, "*.json").Order(StringComparer.Ordinal))
                {
                    var bytes = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
                    if (bytes.LongLength > MaxJobRecordBytes) throw new InvalidDataException("BACKUP_JOB_RECORD_TOO_LARGE");
                    totalPayloadBytes = checked(totalPayloadBytes + bytes.LongLength);
                    if (totalPayloadBytes > MaxBackupBytes) throw new InvalidDataException("BACKUP_PAYLOAD_TOO_LARGE");
                    var job = DeserializeJob(bytes, Path.GetFileName(path));
                    if (!string.Equals(Path.GetFileNameWithoutExtension(path), job.Id, StringComparison.Ordinal))
                    {
                        throw new InvalidDataException("BACKUP_JOB_FILE_ID_MISMATCH");
                    }
                    payloads.Add(new BackupPayload(job, bytes));
                }
            }

            if (payloads.Count > MaxBackupEntries) throw new InvalidDataException("BACKUP_TOO_MANY_JOBS");
            var createdAt = DateTimeOffset.UtcNow;
            var manifest = new FileBackupManifest(
                BackupFormat,
                ProviderName,
                RepositorySchemaVersion,
                createdAt,
                payloads.Count,
                [.. payloads.Select(static payload => new FileBackupEntry(
                    $"jobs/{payload.Job.Id}.json",
                    payload.Job.Id,
                    payload.Job.TenantId,
                    payload.Job.OwnerId,
                    payload.Bytes.LongLength,
                    Convert.ToHexStringLower(SHA256.HashData(payload.Bytes))))]);

            using var archive = new ZipArchive(destination, ZipArchiveMode.Create, leaveOpen: true);
            WriteEntry(archive, "manifest.json", JsonSerializer.SerializeToUtf8Bytes(manifest, JsonOptions));
            foreach (var payload in payloads)
            {
                WriteEntry(archive, $"jobs/{payload.Job.Id}.json", payload.Bytes);
            }

            return ToSummary(manifest);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<JobBackupSummary> VerifyBackupAsync(Stream source, CancellationToken cancellationToken)
    {
        var validated = await ReadBackupAsync(source, cancellationToken).ConfigureAwait(false);
        return ToSummary(validated.Manifest);
    }

    public async Task<JobBackupSummary> RestoreAsync(Stream source, CancellationToken cancellationToken)
    {
        var validated = await ReadBackupAsync(source, cancellationToken).ConfigureAwait(false);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        var staging = _root + $".restore-{Guid.NewGuid():N}.partial";
        try
        {
            if (Directory.Exists(_root) && Directory.EnumerateFileSystemEntries(_root).Any())
            {
                throw new InvalidOperationException("RESTORE_TARGET_NOT_EMPTY");
            }

            Directory.CreateDirectory(staging);
            foreach (var payload in validated.Payloads)
            {
                var path = Path.Combine(staging, payload.Job.Id + ".json");
                await using var output = new FileStream(
                    path,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    64 * 1024,
                    FileOptions.Asynchronous | FileOptions.WriteThrough);
                await output.WriteAsync(payload.Bytes, cancellationToken).ConfigureAwait(false);
                await output.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            var parent = Path.GetDirectoryName(_root)!;
            Directory.CreateDirectory(parent);
            if (Directory.Exists(_root)) Directory.Delete(_root);
            Directory.Move(staging, _root);
            return ToSummary(validated.Manifest);
        }
        finally
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
            _gate.Release();
        }
    }

    private static async Task<ValidatedBackup> ReadBackupAsync(Stream source, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (!source.CanRead) throw new ArgumentException("Backup source must be readable.", nameof(source));

        MemoryStream? buffered = null;
        var input = source;
        if (!source.CanSeek)
        {
            buffered = new MemoryStream();
            var buffer = new byte[64 * 1024];
            long total = 0;
            while (true)
            {
                var read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (read == 0) break;
                total = checked(total + read);
                if (total > MaxBackupBytes) throw new InvalidDataException("BACKUP_ARCHIVE_TOO_LARGE");
                await buffered.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
            }
            buffered.Position = 0;
            input = buffered;
        }
        else
        {
            if (source.Length > MaxBackupBytes) throw new InvalidDataException("BACKUP_ARCHIVE_TOO_LARGE");
            source.Position = 0;
        }

        try
        {
            using var archive = new ZipArchive(input, ZipArchiveMode.Read, leaveOpen: true);
            if (archive.Entries.Count is < 1 or > MaxBackupEntries + 1)
            {
                throw new InvalidDataException("BACKUP_ENTRY_COUNT_INVALID");
            }

            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entry in archive.Entries)
            {
                if (!names.Add(entry.FullName) || entry.FullName.Contains('\\') || entry.FullName.Contains("../", StringComparison.Ordinal))
                {
                    throw new InvalidDataException("BACKUP_ENTRY_PATH_INVALID");
                }
            }

            var manifestEntry = archive.GetEntry("manifest.json") ?? throw new InvalidDataException("BACKUP_MANIFEST_MISSING");
            var manifestBytes = await ReadEntryAsync(manifestEntry, 1024 * 1024, cancellationToken).ConfigureAwait(false);
            var manifest = JsonSerializer.Deserialize<FileBackupManifest>(manifestBytes, JsonOptions)
                ?? throw new InvalidDataException("BACKUP_MANIFEST_INVALID");
            if (manifest.Format != BackupFormat || manifest.Provider != ProviderName ||
                manifest.RepositorySchemaVersion != RepositorySchemaVersion || manifest.JobCount != manifest.Jobs.Count)
            {
                throw new InvalidDataException("BACKUP_MANIFEST_UNSUPPORTED");
            }
            if (manifest.JobCount > MaxBackupEntries || archive.Entries.Count != manifest.JobCount + 1)
            {
                throw new InvalidDataException("BACKUP_MANIFEST_COUNT_MISMATCH");
            }

            var payloads = new List<BackupPayload>(manifest.Jobs.Count);
            var jobIds = new HashSet<string>(StringComparer.Ordinal);
            long totalPayloadBytes = 0;
            foreach (var item in manifest.Jobs)
            {
                ValidateId(item.JobId);
                ValidateCallerContext(item.TenantId, item.OwnerId);
                var expectedPath = $"jobs/{item.JobId}.json";
                if (item.Path != expectedPath || !jobIds.Add(item.JobId) || item.Bytes is < 0 or > MaxJobRecordBytes ||
                    !IsLowerHexSha256(item.Sha256))
                {
                    throw new InvalidDataException("BACKUP_MANIFEST_JOB_INVALID");
                }
                totalPayloadBytes = checked(totalPayloadBytes + item.Bytes);
                if (totalPayloadBytes > MaxBackupBytes) throw new InvalidDataException("BACKUP_PAYLOAD_TOO_LARGE");

                var entry = archive.GetEntry(expectedPath) ?? throw new InvalidDataException("BACKUP_JOB_ENTRY_MISSING");
                var bytes = await ReadEntryAsync(entry, MaxJobRecordBytes, cancellationToken).ConfigureAwait(false);
                if (bytes.LongLength != item.Bytes ||
                    !string.Equals(Convert.ToHexStringLower(SHA256.HashData(bytes)), item.Sha256, StringComparison.Ordinal))
                {
                    throw new InvalidDataException("BACKUP_JOB_HASH_MISMATCH");
                }

                var job = DeserializeJob(bytes, entry.FullName);
                if (job.Id != item.JobId || job.TenantId != item.TenantId || job.OwnerId != item.OwnerId)
                {
                    throw new InvalidDataException("BACKUP_JOB_METADATA_MISMATCH");
                }
                payloads.Add(new BackupPayload(job, bytes));
            }

            return new ValidatedBackup(manifest, payloads);
        }
        catch (InvalidDataException)
        {
            throw;
        }
        catch (Exception exception) when (exception is JsonException or IOException)
        {
            throw new InvalidDataException("BACKUP_ARCHIVE_INVALID", exception);
        }
        finally
        {
            buffered?.Dispose();
        }
    }

    private static GCodeJobRecord DeserializeJob(byte[] bytes, string source)
    {
        var job = JsonSerializer.Deserialize<GCodeJobRecord>(bytes, JsonOptions)
            ?? throw new InvalidDataException($"BACKUP_JOB_EMPTY:{source}");
        job = NormalizePersistedJob(job);
        ValidateId(job.Id);
        ValidateCallerContext(job.TenantId, job.OwnerId);
        return job;
    }

    private static async Task<byte[]> ReadEntryAsync(ZipArchiveEntry entry, long maxBytes, CancellationToken cancellationToken)
    {
        if (entry.Length < 0 || entry.Length > maxBytes) throw new InvalidDataException("BACKUP_ENTRY_TOO_LARGE");
        await using var stream = entry.Open();
        using var output = new MemoryStream((int)entry.Length);
        await stream.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
        if (output.Length != entry.Length) throw new InvalidDataException("BACKUP_ENTRY_LENGTH_MISMATCH");
        return output.ToArray();
    }

    private static void WriteEntry(ZipArchive archive, string name, byte[] bytes)
    {
        var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
        entry.LastWriteTime = StableZipTimestamp;
        using var output = entry.Open();
        output.Write(bytes);
    }

    private static bool IsLowerHexSha256(string value) =>
        value.Length == 64 &&
        value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static JobBackupSummary ToSummary(FileBackupManifest manifest) => new(
        manifest.Format,
        manifest.Provider,
        manifest.RepositorySchemaVersion,
        manifest.JobCount,
        manifest.CreatedAtUtc);

    private sealed record BackupPayload(GCodeJobRecord Job, byte[] Bytes);
    private sealed record ValidatedBackup(FileBackupManifest Manifest, IReadOnlyList<BackupPayload> Payloads);
    private sealed record FileBackupEntry(
        string Path,
        string JobId,
        string TenantId,
        string OwnerId,
        long Bytes,
        string Sha256);
    private sealed record FileBackupManifest(
        string Format,
        string Provider,
        int RepositorySchemaVersion,
        DateTimeOffset CreatedAtUtc,
        int JobCount,
        IReadOnlyList<FileBackupEntry> Jobs);
}
