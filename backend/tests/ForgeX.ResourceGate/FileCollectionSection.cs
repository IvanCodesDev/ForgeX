using ForgeX.Infrastructure;

namespace ForgeX.ResourceGate;

/// <summary>JsonFileCollection / JsonFileDocument semantics the file legs of every resource repository rely on.</summary>
internal static class FileCollectionSection
{
    private sealed record Payload(string Note);

    private sealed record Document(string Format, int Version, Dictionary<string, int> Items);

    public static async Task RunAsync(Gate gate)
    {
        gate.Section("file-collection: JsonFileCollection / JsonFileDocument");
        var ct = CancellationToken.None;
        var tenantA = Gate.Tenant('a');
        var ownerA = Gate.Owner('a');
        var ownerB = Gate.Owner('b');
        var tenantB = Gate.Tenant('b');

        var collection = new JsonFileCollection<Payload>(gate.TempDir("collection"));
        const long now = 1_000_000;

        gate.Check("file-safe-id-accepts", JsonFileCollection<Payload>.IsSafeId("ds_abc.DEF-123_") && JsonFileCollection<Payload>.IsSafeId("kb_" + new string('f', 16)));
        gate.Check("file-safe-id-rejects",
            !JsonFileCollection<Payload>.IsSafeId("../etc") &&
            !JsonFileCollection<Payload>.IsSafeId("a/b") &&
            !JsonFileCollection<Payload>.IsSafeId("a..b") &&
            !JsonFileCollection<Payload>.IsSafeId(string.Empty) &&
            !JsonFileCollection<Payload>.IsSafeId(new string('x', 97)));

        // Put / Get: owner scoping, tenant scoping and builtin visibility.
        await collection.PutAsync(new FileEnvelope<Payload>("r1", tenantA, ownerA, now - 30, null, false, new Payload("one")), ct);
        await collection.PutAsync(new FileEnvelope<Payload>("r2", tenantA, ownerA, now - 20, now + 100, false, new Payload("two")), ct);
        await collection.PutAsync(new FileEnvelope<Payload>("r3", tenantA, ownerA, now - 10, now - 1, false, new Payload("expired")), ct);
        await collection.PutAsync(new FileEnvelope<Payload>("r4", tenantA, ownerB, now - 5, null, false, new Payload("other-owner")), ct);
        await collection.PutAsync(new FileEnvelope<Payload>("builtin", "tn_local", "ow_local", 0, null, true, new Payload("builtin")), ct);

        var r1 = await collection.GetAsync("r1", tenantA, ownerA, now, ct);
        gate.Check("file-get-own-record", r1 is { Payload.Note: "one" }, r1?.Payload.Note);
        gate.Check("file-get-expired-invisible", await collection.GetAsync("r3", tenantA, ownerA, now, ct) is null);
        gate.Check("file-get-other-owner-invisible", await collection.GetAsync("r4", tenantA, ownerA, now, ct) is null);
        gate.Check("file-get-other-tenant-invisible", await collection.GetAsync("r1", tenantB, ownerA, now, ct) is null);
        gate.Check("file-get-builtin-visible-to-everyone", await collection.GetAsync("builtin", tenantB, ownerB, now, ct) is { Builtin: true });
        gate.Check("file-get-unsafe-id-null", await collection.GetAsync("../r1", tenantA, ownerA, now, ct) is null);
        gate.Check("file-get-missing-null", await collection.GetAsync("nope", tenantA, ownerA, now, ct) is null);

        // List: oldest first, builtin included, expired and foreign excluded.
        var listed = await collection.ListAsync(tenantA, ownerA, now, ct);
        gate.Check("file-list-order-and-scope",
            string.Join(",", listed.Select(static item => item.Id)) == "builtin,r1,r2",
            string.Join(",", listed.Select(static item => item.Id)));

        // Count: every live record regardless of owner (r1, r2, r4, builtin).
        gate.Check("file-count-live", await collection.CountAsync(now, ct) == 4, await collection.CountAsync(now, ct));

        // Sweep: expired non-builtin removed; builtin never swept even with a past ExpiresAt.
        await collection.PutAsync(new FileEnvelope<Payload>("builtin-expired", "tn_local", "ow_local", 0, now - 1, true, new Payload("keep")), ct);
        var swept = await collection.SweepExpiredAsync(now, ct);
        gate.Check("file-sweep-removes-expired-only", swept == 1 && !File.Exists(Path.Combine(collection.RootDirectory, "r3.json")), swept);
        gate.Check("file-sweep-keeps-builtin", File.Exists(Path.Combine(collection.RootDirectory, "builtin-expired.json")));

        // Evict: keep newest `max` per (tenant, owner), oldest removed first (A5); other owners untouched.
        await collection.PutAsync(new FileEnvelope<Payload>("r5", tenantA, ownerA, now - 1, null, false, new Payload("five")), ct);
        var evicted = await collection.EvictBeyondAsync(tenantA, ownerA, 2, now, ct);
        var remaining = await collection.ListAsync(tenantA, ownerA, now, ct);
        gate.Check("file-evict-oldest-first",
            evicted == 1 && string.Join(",", remaining.Where(static item => !item.Builtin).Select(static item => item.Id)) == "r2,r5",
            string.Join(",", remaining.Select(static item => item.Id)));
        gate.Check("file-evict-other-owner-untouched", await collection.GetAsync("r4", tenantA, ownerB, now, ct) is not null);
        gate.Check("file-evict-noop-under-cap", await collection.EvictBeyondAsync(tenantA, ownerA, 2, now, ct) == 0);

        // Torn / foreign files are invisible instead of fatal.
        await File.WriteAllTextAsync(Path.Combine(collection.RootDirectory, "torn.json"), "{ not json", ct);
        gate.Check("file-torn-record-invisible", await collection.GetAsync("torn", tenantA, ownerA, now, ct) is null && (await collection.ListAsync(tenantA, ownerA, now, ct)).All(static item => item.Id != "torn"));

        // Delete + atomic write leaves no partial files behind.
        gate.Check("file-delete", await collection.DeleteAsync("r2", ct) && !await collection.DeleteAsync("r2", ct));
        gate.Check("file-no-partial-leftovers", !Directory.EnumerateFiles(collection.RootDirectory, "*.partial").Any());

        // JsonFileDocument: load-missing → null, save → load round trip, atomic replace.
        var document = new JsonFileDocument<Document>(Path.Combine(gate.TempDir("document"), "state.json"));
        gate.Check("file-document-missing-null", await document.LoadAsync(ct) is null);
        await document.SaveAsync(new Document("fmt", 1, new Dictionary<string, int> { ["a"] = 1 }), ct);
        await document.SaveAsync(new Document("fmt", 2, new Dictionary<string, int> { ["a"] = 1, ["b"] = 2 }), ct);
        var loaded = await document.LoadAsync(ct);
        gate.Check("file-document-round-trip", loaded is { Format: "fmt", Version: 2 } && loaded.Items.Count == 2, loaded?.Version);
        gate.Check("file-document-no-partial-leftovers", !Directory.EnumerateFiles(Path.GetDirectoryName(document.FilePath)!, "*.partial").Any());
    }
}
