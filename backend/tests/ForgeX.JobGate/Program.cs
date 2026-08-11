using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
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
    const string tenantA = "tn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const string ownerA = "ow_11111111111111111111111111111111";
    const string tenantB = "tn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const string ownerB = "ow_22222222222222222222222222222222";
    var event1 = new GCodeJobEvent(1, "progress", now, GCodeJobStatus.Queued, 0, "queued");
    var job = new GCodeJobRecord(
        Guid.NewGuid().ToString("N"), "gate-key", "fingerprint-a", stored.Sha256, stored.Bytes, options,
        GCodeJobStatus.Queued, 0, "queued", now, null, null, null, null, null, null, null, [event1], tenantA, ownerA);
    var created = await repository.CreateOrGetAsync(job, CancellationToken.None);
    Check("job-created", created.Created && !created.Conflict, created);
    var replay = await repository.CreateOrGetAsync(job with { Id = Guid.NewGuid().ToString("N") }, CancellationToken.None);
    Check("idempotent-replay", !replay.Created && !replay.Conflict && replay.Job.Id == job.Id, replay.Job.Id);
    var conflict = await repository.CreateOrGetAsync(job with { Id = Guid.NewGuid().ToString("N"), Fingerprint = "fingerprint-b" }, CancellationToken.None);
    Check("idempotency-conflict", !conflict.Created && conflict.Conflict, conflict);
    var otherTenant = await repository.CreateOrGetAsync(job with
    {
        Id = Guid.NewGuid().ToString("N"),
        TenantId = tenantB,
        OwnerId = ownerB,
    }, CancellationToken.None);
    Check("idempotency-is-tenant-owner-scoped", otherTenant.Created && !otherTenant.Conflict, otherTenant);
    var owned = await repository.GetOwnedAsync(tenantA, ownerA, job.Id, CancellationToken.None);
    Check("owner-can-read-job", owned?.Id == job.Id, owned?.Id);
    var crossTenant = await repository.GetOwnedAsync(tenantB, ownerB, job.Id, CancellationToken.None);
    Check("cross-tenant-read-hidden", crossTenant is null, crossTenant?.Id);
    var crossOwner = await repository.GetOwnedAsync(tenantA, ownerB, job.Id, CancellationToken.None);
    Check("cross-owner-read-hidden", crossOwner is null, crossOwner?.Id);
    var completed = job with { Status = GCodeJobStatus.Cancelled, Phase = "cancelled", FinishedAtUtc = now.AddSeconds(1) };
    await repository.SaveAsync(completed, CancellationToken.None);
    var reopenedJob = await repository.GetAsync(job.Id, CancellationToken.None);
    Check(
        "atomic-job-save-reopen",
        reopenedJob?.Status == GCodeJobStatus.Cancelled && reopenedJob.TenantId == tenantA && reopenedJob.OwnerId == ownerA,
        reopenedJob?.Status);

    var legacyRoot = Path.Combine(root, "legacy-jobs");
    var legacyRepository = new FileGCodeJobRepository(legacyRoot);
    var legacyJob = job with
    {
        Id = Guid.NewGuid().ToString("N"),
        IdempotencyKey = null,
        TenantId = "tn_local",
        OwnerId = "ow_local",
    };
    await legacyRepository.SaveAsync(legacyJob, CancellationToken.None);
    var legacyPath = Path.Combine(legacyRoot, legacyJob.Id + ".json");
    var legacyJson = JsonNode.Parse(await File.ReadAllTextAsync(legacyPath))!.AsObject();
    legacyJson.Remove("tenantId");
    legacyJson.Remove("ownerId");
    await File.WriteAllTextAsync(legacyPath, legacyJson.ToJsonString());
    var migratedLegacy = await legacyRepository.GetOwnedAsync("tn_local", "ow_local", legacyJob.Id, CancellationToken.None);
    Check("legacy-job-is-confined-to-local-scope", migratedLegacy?.Id == legacyJob.Id, migratedLegacy?.TenantId);
    var legacyFromTrustedTenant = await legacyRepository.GetOwnedAsync(tenantA, ownerA, legacyJob.Id, CancellationToken.None);
    Check("legacy-job-is-hidden-from-trusted-tenants", legacyFromTrustedTenant is null, legacyFromTrustedTenant?.Id);

    var legacyResult = new GCodeAnalysisResult(
        stored.Sha256,
        "1.1.0",
        "gcode-import",
        GCodeProfileSummary.Create(options),
        CoordinateOrigin.Corner,
        stored.Bytes,
        3,
        1,
        0.2,
        new GCodeBounds(0, 10, 0, 10),
        new GCodeStatistics(14.1421356, 0, 1, 0.002405, 0.001, 0.002982),
        new Dictionary<string, string>(),
        new Dictionary<string, long> { ["infill"] = 1 },
        [new GCodeLayerSummary(0, 0.2, 1, 14.1421356, 0, 1, 1, new Dictionary<string, long> { ["infill"] = 1 })],
        []);
    var legacyCompleted = legacyJob with
    {
        Id = Guid.NewGuid().ToString("N"),
        Status = GCodeJobStatus.Succeeded,
        Progress = 1,
        Phase = "complete",
        FinishedAtUtc = now,
        EngineVersion = legacyResult.EngineVersion,
        Result = legacyResult,
    };
    await legacyRepository.SaveAsync(legacyCompleted, CancellationToken.None);
    var legacyCompletedPath = Path.Combine(legacyRoot, legacyCompleted.Id + ".json");
    var legacyCompletedJson = JsonNode.Parse(await File.ReadAllTextAsync(legacyCompletedPath))!.AsObject();
    legacyCompletedJson["options"]!.AsObject().Remove("maxLayers");
    legacyCompletedJson["result"]!.AsObject().Remove("layers");
    await File.WriteAllTextAsync(legacyCompletedPath, legacyCompletedJson.ToJsonString());
    var migratedCompleted = await legacyRepository.GetAsync(legacyCompleted.Id, CancellationToken.None);
    Check("legacy-options-get-layer-limit", migratedCompleted?.Options.MaxLayers == 20_000, migratedCompleted?.Options.MaxLayers);
    Check(
        "legacy-result-degrades-without-invalid-response",
        migratedCompleted is
        {
            Status: GCodeJobStatus.Degraded,
            Phase: "contract-upgrade",
            Result: null,
            ErrorCode: "gcode_result_contract_outdated",
        },
        migratedCompleted?.Status);
    Check(
        "legacy-result-appends-terminal-evidence",
        migratedCompleted?.Events[^1] is
        {
            Status: GCodeJobStatus.Degraded,
            Phase: "contract-upgrade",
            ErrorCode: "gcode_result_contract_outdated",
        },
        migratedCompleted?.Events[^1]);

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
