using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ForgeX.Domain;
using ForgeX.Infrastructure;

var root = Path.Combine(Path.GetTempPath(), "forgex-job-gate-" + Guid.NewGuid().ToString("N"));
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
    var objects = new ContentAddressedObjectStore(Path.Combine(root, "objects"));
    var bytes = Encoding.UTF8.GetBytes("G90\r\n; 边界\nG1 X10 Y10 E1\n");
    await using var input = new MemoryStream(bytes, writable: false);
    var stored = await objects.PutAsync(input, 1024, CancellationToken.None);
    Check("raw-byte-sha256", stored.Sha256 == Convert.ToHexStringLower(SHA256.HashData(bytes)), stored.Sha256);
    Check("object-byte-count", stored.Bytes == bytes.Length, stored.Bytes);
    await using var reopened = await objects.OpenReadAsync(stored.Sha256, CancellationToken.None);
    using var copy = new MemoryStream();
    await reopened.CopyToAsync(copy);
    Check("object-reopen-exact", copy.ToArray().SequenceEqual(bytes), copy.Length);
    Check("object-store-writable", await objects.ProbeWritableAsync(CancellationToken.None));

    var repository = new FileGCodeJobRepository(Path.Combine(root, "jobs"));
    var now = DateTimeOffset.UtcNow;
    var options = new GCodeAnalysisOptions();
    var event1 = new GCodeJobEvent(1, "progress", now, GCodeJobStatus.Queued, 0, "queued");
    var job = new GCodeJobRecord(
        Guid.NewGuid().ToString("N"), "gate-key", "fingerprint-a", stored.Sha256, stored.Bytes, options,
        GCodeJobStatus.Queued, 0, "queued", now, null, null, null, null, null, null, null, [event1]);
    var created = await repository.CreateOrGetAsync(job, CancellationToken.None);
    Check("job-created", created.Created && !created.Conflict, created);
    var replay = await repository.CreateOrGetAsync(job with { Id = Guid.NewGuid().ToString("N") }, CancellationToken.None);
    Check("idempotent-replay", !replay.Created && !replay.Conflict && replay.Job.Id == job.Id, replay.Job.Id);
    var conflict = await repository.CreateOrGetAsync(job with { Id = Guid.NewGuid().ToString("N"), Fingerprint = "fingerprint-b" }, CancellationToken.None);
    Check("idempotency-conflict", !conflict.Created && conflict.Conflict, conflict);
    var completed = job with { Status = GCodeJobStatus.Cancelled, Phase = "cancelled", FinishedAtUtc = now.AddSeconds(1) };
    await repository.SaveAsync(completed, CancellationToken.None);
    var reopenedJob = await repository.GetAsync(job.Id, CancellationToken.None);
    Check("atomic-job-save-reopen", reopenedJob?.Status == GCodeJobStatus.Cancelled, reopenedJob?.Status);

    var queue = new GCodeJobQueue(2);
    await queue.EnqueueAsync("first", CancellationToken.None);
    await queue.EnqueueAsync("second", CancellationToken.None);
    var dequeued = new List<string>();
    await foreach (var id in queue.ReadAllAsync(CancellationToken.None))
    {
        dequeued.Add(id);
        if (dequeued.Count == 2) break;
    }
    Check("bounded-queue-fifo", dequeued.SequenceEqual(["first", "second"]), string.Join(",", dequeued));

    var report = new
    {
        schemaVersion = "1.0",
        generatedAtUtc = DateTimeOffset.UtcNow,
        result = "pass",
        passed,
        total = checks.Count,
        checks,
    };
    var artifact = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "artifacts", "gcode-job-gate.json"));
    Directory.CreateDirectory(Path.GetDirectoryName(artifact)!);
    await File.WriteAllTextAsync(artifact, JsonSerializer.Serialize(report, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
    Console.WriteLine($"G-code async job gate PASS: {passed}/{checks.Count}");
    Console.WriteLine(artifact);
}
finally
{
    if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
}
