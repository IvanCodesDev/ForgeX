using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ForgeX.Application;
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

    var retryOptions = new GCodeJobRetryOptions(3, 100, 1000).Validate();
    Check("retry-delay-attempt-1", retryOptions.DelayAfterFailure(1) == TimeSpan.FromMilliseconds(100));
    Check("retry-delay-attempt-2", retryOptions.DelayAfterFailure(2) == TimeSpan.FromMilliseconds(200));
    Check("retry-delay-is-capped", retryOptions.DelayAfterFailure(5) == TimeSpan.FromMilliseconds(1000));
    var deterministicFailure = GCodeJobResilience.Classify(new GCodeAnalysisException("GCODE_INVALID_UTF8", "invalid"));
    Check("deterministic-analysis-failure-is-terminal", !deterministicFailure.Retryable, deterministicFailure);
    var streamFailure = GCodeJobResilience.Classify(new GCodeAnalysisException("GCODE_STREAM_READ_FAILED", "read"));
    Check("stream-read-failure-is-retryable", streamFailure.Retryable && streamFailure.Code == "GCODE_STREAM_READ_FAILED", streamFailure);
    var storageFailure = GCodeJobResilience.Classify(new IOException("fixture unavailable"));
    Check("storage-failure-is-retryable", storageFailure.Retryable && storageFailure.Code == "gcode_storage_unavailable", storageFailure);
    var retrying = job with
    {
        Id = Guid.NewGuid().ToString("N"),
        IdempotencyKey = null,
        AttemptCount = 2,
        MaxAttempts = 4,
        NextAttemptAtUtc = now.AddSeconds(5),
        ErrorCode = "gcode_storage_unavailable",
    };
    await repository.SaveAsync(retrying, CancellationToken.None);
    var reopenedRetry = await repository.GetAsync(retrying.Id, CancellationToken.None);
    Check(
        "retry-metadata-persists",
        reopenedRetry is { AttemptCount: 2, MaxAttempts: 4, NextAttemptAtUtc: not null } &&
        reopenedRetry.NextAttemptAtUtc == retrying.NextAttemptAtUtc,
        reopenedRetry);

    var quotaRepository = new FileGCodeJobRepository(Path.Combine(root, "quota-jobs"));
    var quota = new GCodeJobAdmissionOptions(1, 2).Validate();
    var quotaOwnerA = job with { Id = Guid.NewGuid().ToString("N"), IdempotencyKey = "quota-owner-a" };
    var quotaFirst = await quotaRepository.CreateOrGetAsync(quotaOwnerA, CancellationToken.None, quota);
    Check("owner-quota-first-admitted", quotaFirst.Created && quotaFirst.RejectionCode is null, quotaFirst);
    var quotaReplay = await quotaRepository.CreateOrGetAsync(
        quotaOwnerA with { Id = Guid.NewGuid().ToString("N") }, CancellationToken.None, quota);
    Check("quota-idempotent-replay-bypasses-limit", !quotaReplay.Created && quotaReplay.Job.Id == quotaOwnerA.Id, quotaReplay);
    var ownerRejected = await quotaRepository.CreateOrGetAsync(
        quotaOwnerA with { Id = Guid.NewGuid().ToString("N"), IdempotencyKey = "quota-owner-a-2" }, CancellationToken.None, quota);
    Check("owner-active-quota-rejected", ownerRejected.RejectionCode == "gcode_owner_active_quota_exceeded", ownerRejected);
    var quotaOwnerB = quotaOwnerA with
    {
        Id = Guid.NewGuid().ToString("N"),
        IdempotencyKey = "quota-owner-b",
        OwnerId = ownerB,
    };
    var tenantSecond = await quotaRepository.CreateOrGetAsync(quotaOwnerB, CancellationToken.None, quota);
    Check("tenant-second-owner-admitted", tenantSecond.Created && tenantSecond.RejectionCode is null, tenantSecond);
    var tenantRejected = await quotaRepository.CreateOrGetAsync(quotaOwnerB with
    {
        Id = Guid.NewGuid().ToString("N"),
        IdempotencyKey = "quota-owner-c",
        OwnerId = "ow_33333333333333333333333333333333",
    }, CancellationToken.None, quota);
    Check("tenant-active-quota-rejected", tenantRejected.RejectionCode == "gcode_tenant_active_quota_exceeded", tenantRejected);
    await quotaRepository.SaveAsync(quotaOwnerA with
    {
        Status = GCodeJobStatus.Cancelled,
        Phase = "cancelled",
        FinishedAtUtc = now,
    }, CancellationToken.None);
    var quotaAfterTerminal = await quotaRepository.CreateOrGetAsync(
        quotaOwnerA with { Id = Guid.NewGuid().ToString("N"), IdempotencyKey = "quota-owner-a-3" }, CancellationToken.None, quota);
    Check("terminal-job-releases-owner-quota", quotaAfterTerminal.Created && quotaAfterTerminal.RejectionCode is null, quotaAfterTerminal);

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
    legacyJson.Remove("attemptCount");
    legacyJson.Remove("maxAttempts");
    await File.WriteAllTextAsync(legacyPath, legacyJson.ToJsonString());
    var migratedLegacy = await legacyRepository.GetOwnedAsync("tn_local", "ow_local", legacyJob.Id, CancellationToken.None);
    Check("legacy-job-is-confined-to-local-scope", migratedLegacy?.Id == legacyJob.Id, migratedLegacy?.TenantId);
    Check("legacy-job-retry-budget-migrates", migratedLegacy is { AttemptCount: 0, MaxAttempts: 3 }, migratedLegacy?.MaxAttempts);
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
        [],
        new GCodeToolpathVisualization(
            "forgex-toolpath-f32le-v1",
            20,
            1,
            1,
            false,
            1,
            ["infill"],
            [new GCodeToolpathLayer(0, 1, 0, 1)],
            new byte[20]));
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
    legacyCompletedJson["options"]!.AsObject().Remove("maxVisualizationSegments");
    legacyCompletedJson["options"]!.AsObject().Remove("materialPriceCnyPerKg");
    legacyCompletedJson["options"]!.AsObject().Remove("nozzleTemperatureMinC");
    legacyCompletedJson["options"]!.AsObject().Remove("nozzleTemperatureMaxC");
    legacyCompletedJson["options"]!.AsObject().Remove("bedTemperatureMinC");
    legacyCompletedJson["options"]!.AsObject().Remove("materialMaxSpeedMmPerSecond");
    legacyCompletedJson["options"]!.AsObject().Remove("materialMaxFlowMm3PerSecond");
    await File.WriteAllTextAsync(legacyCompletedPath, legacyCompletedJson.ToJsonString());
    var migratedCompleted = await legacyRepository.GetAsync(legacyCompleted.Id, CancellationToken.None);
    Check("legacy-options-get-layer-limit", migratedCompleted?.Options.MaxLayers == 20_000, migratedCompleted?.Options.MaxLayers);
    Check(
        "stage5b-options-get-visualization-limit",
        migratedCompleted?.Options.MaxVisualizationSegments == 100_000,
        migratedCompleted?.Options.MaxVisualizationSegments);
    Check(
        "stage5d-options-get-material-defaults",
        migratedCompleted?.Options is
        {
            MaterialPriceCnyPerKg: 0,
            NozzleTemperatureMinC: 0,
            NozzleTemperatureMaxC: 500,
            BedTemperatureMinC: 0,
            MaterialMaxSpeedMmPerSecond: 1000,
            MaterialMaxFlowMm3PerSecond: 100,
        },
        migratedCompleted?.Options);
    Check(
        "stage5d-result-degrades-without-material-risk",
        migratedCompleted is
        {
            Status: GCodeJobStatus.Degraded,
            Phase: "contract-upgrade",
            Result: null,
            ErrorCode: "gcode_result_contract_outdated",
        },
        migratedCompleted?.Status);
    Check(
        "stage5d-result-appends-terminal-evidence",
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
    Check("bounded-queue-capacity", queue.Capacity == 2, queue.Capacity);
    Check("bounded-queue-depth-before-read", queue.Depth == 2, queue.Depth);
    var dequeued = new List<string>();
    await foreach (var id in queue.ReadAllAsync(CancellationToken.None))
    {
        dequeued.Add(id);
        if (dequeued.Count == 2) break;
    }
    Check("bounded-queue-fifo", dequeued.SequenceEqual(["first", "second"]), string.Join(",", dequeued));
    Check("bounded-queue-depth-after-read", queue.Depth == 0, queue.Depth);

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
