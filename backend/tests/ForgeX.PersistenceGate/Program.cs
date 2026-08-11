using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using ForgeX.Domain;
using ForgeX.Infrastructure;

var root = Path.Combine(Path.GetTempPath(), "forgex-persistence-gate-" + Guid.NewGuid().ToString("N"));
var checks = new List<object>();
var passed = 0;

void Check(string name, bool condition, object? actual = null)
{
    checks.Add(new { name, pass = condition, actual });
    if (!condition) throw new InvalidOperationException($"{name} failed: {actual}");
    passed++;
}

try
{
    const string tenantA = "tn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const string ownerA = "ow_11111111111111111111111111111111";
    const string tenantB = "tn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const string ownerB = "ow_22222222222222222222222222222222";
    var sourceRoot = Path.Combine(root, "source");
    var repository = new FileGCodeJobRepository(sourceRoot);
    var now = DateTimeOffset.UtcNow;
    var first = CreateJob(Guid.NewGuid().ToString("N"), tenantA, ownerA, "backup-a", now);
    var second = CreateJob(Guid.NewGuid().ToString("N"), tenantB, ownerB, "backup-b", now.AddSeconds(1));
    await repository.SaveAsync(first, CancellationToken.None);
    await repository.SaveAsync(second, CancellationToken.None);

    var sourceHealth = await repository.ProbeAsync(CancellationToken.None);
    Check("source-health-ready", sourceHealth.Ready, sourceHealth);
    Check("source-health-count", sourceHealth.RecordCount == 2, sourceHealth.RecordCount);
    Check("source-health-provider-schema", sourceHealth.Provider == "file-json" && sourceHealth.SchemaVersion == 1, sourceHealth);

    using var backup = new MemoryStream();
    var created = await repository.BackupAsync(backup, CancellationToken.None);
    Check("backup-format", created.Format == "forgex-gcode-job-backup/v1", created.Format);
    Check("backup-job-count", created.JobCount == 2, created.JobCount);
    Check("backup-nonempty", backup.Length > 0, backup.Length);

    var artifacts = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "artifacts"));
    Directory.CreateDirectory(artifacts);
    var backupArtifact = Path.Combine(artifacts, "persistence-recovery-gate.fxbackup");
    await File.WriteAllBytesAsync(backupArtifact, backup.ToArray());
    var backupSha256 = Convert.ToHexStringLower(SHA256.HashData(backup.ToArray()));

    backup.Position = 0;
    var verified = await repository.VerifyBackupAsync(backup, CancellationToken.None);
    Check("backup-verify", verified.JobCount == 2 && verified.RepositorySchemaVersion == 1, verified);
    await using (var nonSeekable = new NonSeekableReadStream(new MemoryStream(backup.ToArray(), writable: false)))
    {
        var streamed = await repository.VerifyBackupAsync(nonSeekable, CancellationToken.None);
        Check("nonseekable-backup-verify", streamed.JobCount == 2, streamed.JobCount);
    }

    backup.Position = 0;
    var restoreRoot = Path.Combine(root, "restored");
    var restoredRepository = new FileGCodeJobRepository(restoreRoot);
    var restored = await restoredRepository.RestoreAsync(backup, CancellationToken.None);
    Check("restore-job-count", restored.JobCount == 2, restored.JobCount);
    var restoredHealth = await restoredRepository.ProbeAsync(CancellationToken.None);
    Check("restored-health-ready", restoredHealth.Ready && restoredHealth.RecordCount == 2, restoredHealth);
    Check("restore-owner-a", (await restoredRepository.GetOwnedAsync(tenantA, ownerA, first.Id, CancellationToken.None))?.Id == first.Id);
    Check("restore-owner-b", (await restoredRepository.GetOwnedAsync(tenantB, ownerB, second.Id, CancellationToken.None))?.Id == second.Id);
    Check("restore-cross-tenant-hidden", await restoredRepository.GetOwnedAsync(tenantB, ownerB, first.Id, CancellationToken.None) is null);

    using var corrupt = new MemoryStream(backup.ToArray(), writable: true);
    using (var archive = new ZipArchive(corrupt, ZipArchiveMode.Update, leaveOpen: true))
    {
        var jobEntry = archive.Entries
            .Where(entry => entry.FullName.StartsWith("jobs/", StringComparison.Ordinal))
            .OrderBy(static entry => entry.FullName, StringComparer.Ordinal)
            .First();
        var name = jobEntry.FullName;
        jobEntry.Delete();
        var replacement = archive.CreateEntry(name);
        await using var output = replacement.Open();
        await output.WriteAsync("{}"u8.ToArray());
    }
    corrupt.Position = 0;
    var corruptRejected = false;
    try
    {
        await repository.VerifyBackupAsync(corrupt, CancellationToken.None);
    }
    catch (InvalidDataException exception)
    {
        corruptRejected = exception.Message == "BACKUP_JOB_HASH_MISMATCH";
    }
    Check("corrupt-backup-rejected", corruptRejected);

    var nonemptyRoot = Path.Combine(root, "nonempty");
    Directory.CreateDirectory(nonemptyRoot);
    var sentinel = Path.Combine(nonemptyRoot, "sentinel.txt");
    await File.WriteAllTextAsync(sentinel, "preserve");
    backup.Position = 0;
    var nonemptyRejected = false;
    try
    {
        await new FileGCodeJobRepository(nonemptyRoot).RestoreAsync(backup, CancellationToken.None);
    }
    catch (InvalidOperationException exception)
    {
        nonemptyRejected = exception.Message == "RESTORE_TARGET_NOT_EMPTY";
    }
    Check("nonempty-restore-rejected", nonemptyRejected && await File.ReadAllTextAsync(sentinel) == "preserve");

    var invalidRoot = Path.Combine(root, "invalid");
    Directory.CreateDirectory(invalidRoot);
    await File.WriteAllTextAsync(Path.Combine(invalidRoot, Guid.NewGuid().ToString("N") + ".json"), "{");
    var invalidHealth = await new FileGCodeJobRepository(invalidRoot).ProbeAsync(CancellationToken.None);
    Check("invalid-repository-not-ready", !invalidHealth.Ready && invalidHealth.ErrorCode == "JOB_REPOSITORY_UNAVAILABLE", invalidHealth);

    var report = new
    {
        schemaVersion = "1.0",
        generatedAtUtc = DateTimeOffset.UtcNow,
        result = "pass",
        passed,
        total = checks.Count,
        source = new { provider = sourceHealth.Provider, schemaVersion = sourceHealth.SchemaVersion, jobs = sourceHealth.RecordCount },
        backup = new { path = backupArtifact, bytes = new FileInfo(backupArtifact).Length, sha256 = backupSha256 },
        checks,
    };
    var reportArtifact = Path.Combine(artifacts, "persistence-recovery-gate.json");
    await File.WriteAllTextAsync(reportArtifact, JsonSerializer.Serialize(report, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
    Console.WriteLine($"Persistence recovery gate PASS: {passed}/{checks.Count}");
    Console.WriteLine(reportArtifact);
    Console.WriteLine(backupArtifact);
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
}

static GCodeJobRecord CreateJob(string id, string tenantId, string ownerId, string idempotencyKey, DateTimeOffset now) =>
    new(
        id,
        idempotencyKey,
        new string('f', 64),
        new string('a', 64),
        123,
        new GCodeAnalysisOptions(),
        GCodeJobStatus.Queued,
        0,
        "queued",
        now,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [new GCodeJobEvent(1, "progress", now, GCodeJobStatus.Queued, 0, "queued")],
        tenantId,
        ownerId);

sealed class NonSeekableReadStream(Stream inner) : Stream
{
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() => throw new NotSupportedException();
    public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
        inner.ReadAsync(buffer, cancellationToken);
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    protected override void Dispose(bool disposing)
    {
        if (disposing) inner.Dispose();
        base.Dispose(disposing);
    }
    public override async ValueTask DisposeAsync()
    {
        await inner.DisposeAsync();
        GC.SuppressFinalize(this);
    }
}
