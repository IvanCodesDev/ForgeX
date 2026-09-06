using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using ForgeX.Analytics;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace ForgeX.ResourceGate;

/// <summary>Datasource endpoints over the file leg and (when POSTGRES_URL is set) the PostgreSQL leg.</summary>
internal static class DatasourcesSection
{
    private const string Csv = "machine,material,part,status\nM1,PLA,bracket,ok\nM2,ABS,cover,fail\n";
    private const string OtherCsv = "machine,material,part,status\nM3,PETG,lid,ok\nM4,PLA,base,fail\nM5,PLA,base,ok\n";

    public static async Task RunAsync(Gate gate)
    {
        await RunLegAsync(gate, "file", (max, name) => new FileDatasourceRepository(gate.TempDir("datasources-" + name), max));
        if (gate.HasPostgres)
        {
            await RunLegAsync(gate, "postgres", (max, _) => new PostgresDatasourceRepository(gate.PostgresUrl, max));
        }
    }

    private static async Task RunLegAsync(Gate gate, string leg, Func<int, string, IDatasourceRepository> repositoryFactory)
    {
        gate.Section($"datasources-{leg}: DatasourceEndpoints");
        var ct = CancellationToken.None;
        var tenantA = RandomTenant();
        var ownerA = "ow_" + tenantA[3..];
        var tenantB = RandomTenant();
        var ownerB = "ow_" + tenantB[3..];

        var mainRepository = repositoryFactory(200, "main");
        var app = await StartAsync(gate, mainRepository, ttlMs: 60_000);
        var origin = Gate.Origin(app);
        string Path(string suffix = "") => "/api/v1/datasources" + suffix;

        // Builtin sample is code-defined and visible to everyone.
        var (sample, sampleBody) = await gate.SendAsync(origin, HttpMethod.Get, Path("/sample"), null, Gate.Trusted(tenantA, ownerA));
        var sampleJson = Gate.Parse(sampleBody);
        gate.Check($"datasources-{leg}-sample-200", sample.StatusCode == HttpStatusCode.OK, sampleBody.Length);
        gate.Check($"datasources-{leg}-sample-shape",
            sampleJson.GetProperty("builtin").GetBoolean() &&
            sampleJson.GetProperty("name").GetString() == "内置机群仿真数据" &&
            sampleJson.GetProperty("rows").GetArrayLength() == FarmDataset.Rows.Count &&
            sampleJson.GetProperty("contentSha256").GetString() == JsJson.Sha256Hex(FarmDataset.Csv) &&
            sampleJson.GetProperty("cacheKey").GetString() == JsJson.Sha256Hex(FarmDataset.Csv) &&
            JsJson.Stringify(sampleJson.GetProperty("provenance")) == JsJson.Stringify(FarmDataset.Provenance) &&
            !sampleJson.TryGetProperty("expiresAt", out _),
            sampleJson.GetProperty("name").GetString());

        // Create → 201 with Node-shaped payload and JS-derived identity.
        var (created, createdBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(),
            JsonSerializer.Serialize(new { name = "jobs.csv", csv = Csv }), Gate.Trusted(tenantA, ownerA));
        var createdJson = Gate.Parse(createdBody);
        gate.Check($"datasources-{leg}-create-201", created.StatusCode == HttpStatusCode.Created, createdBody);
        var id = createdJson.GetProperty("datasourceId").GetString()!;
        var normalized = RawDatasetCsv.Normalize(Csv);
        var contentSha = JsJson.Sha256Hex(normalized.Csv);
        var uploadProvenance = JsJson.Stringify(DatasetProvenanceSanitizer.Sanitize(null));
        var cacheKey = JsJson.Sha256Hex(contentSha + "\0" + uploadProvenance);
        var expectedId = "ds_" + JsJson.Sha256Hex(tenantA + "\0" + cacheKey)[..24];
        gate.Check($"datasources-{leg}-create-shape",
            id == expectedId &&
            createdJson.GetProperty("name").GetString() == "jobs.csv" &&
            createdJson.GetProperty("rows").GetInt32() == 2 &&
            createdJson.GetProperty("sha256").GetString() == contentSha &&
            !createdJson.GetProperty("deduplicated").GetBoolean() &&
            JsJson.Stringify(createdJson.GetProperty("provenance")) == uploadProvenance &&
            !createdJson.TryGetProperty("warnings", out _),
            createdBody);

        // Dedup keeps the ORIGINAL record (including its name) — Node semantics.
        var (dedup, dedupBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(),
            JsonSerializer.Serialize(new { name = "renamed.csv", csv = Csv }), Gate.Trusted(tenantA, ownerA));
        var dedupJson = Gate.Parse(dedupBody);
        gate.Check($"datasources-{leg}-dedup",
            dedup.StatusCode == HttpStatusCode.Created &&
            dedupJson.GetProperty("deduplicated").GetBoolean() &&
            dedupJson.GetProperty("datasourceId").GetString() == id &&
            dedupJson.GetProperty("name").GetString() == "jobs.csv",
            dedupBody);

        // A different provenance claim is a different datasource.
        var (synthetic, syntheticBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(),
            "{\"csv\":" + JsonSerializer.Serialize(Csv) + ",\"provenance\":{\"synthetic\":true,\"badge\":\"机群仿真数据集合\"}}", Gate.Trusted(tenantA, ownerA));
        var syntheticJson = Gate.Parse(syntheticBody);
        gate.Check($"datasources-{leg}-provenance-sanitized",
            synthetic.StatusCode == HttpStatusCode.Created &&
            syntheticJson.GetProperty("datasourceId").GetString() != id &&
            !syntheticJson.GetProperty("deduplicated").GetBoolean() &&
            syntheticJson.GetProperty("provenance").GetProperty("source").GetString() == "client-declared-synthetic" &&
            syntheticJson.GetProperty("provenance").GetProperty("badge").GetString() == "机群仿真数据集合",
            syntheticBody);

        // Read: owner sees rows; other tenant, unknown id and unsafe id are 404.
        var (read, readBody) = await gate.SendAsync(origin, HttpMethod.Get, Path("/" + id), null, Gate.Trusted(tenantA, ownerA));
        var readJson = Gate.Parse(readBody);
        gate.Check($"datasources-{leg}-read-200",
            read.StatusCode == HttpStatusCode.OK &&
            readJson.GetProperty("rows").GetArrayLength() == 2 &&
            readJson.GetProperty("rows")[0].GetProperty("machine_id").GetString() == "M1" &&
            readJson.GetProperty("rows")[1].GetProperty("status").GetString() == "fail" &&
            !readJson.GetProperty("builtin").GetBoolean() &&
            readJson.GetProperty("cacheKey").GetString() == cacheKey &&
            readJson.GetProperty("createdAt").ValueKind == JsonValueKind.Number &&
            readJson.GetProperty("expiresAt").GetInt64() > readJson.GetProperty("createdAt").GetInt64(),
            readBody);
        var (foreign, foreignBody) = await gate.SendAsync(origin, HttpMethod.Get, Path("/" + id), null, Gate.Trusted(tenantB, ownerB));
        gate.Check($"datasources-{leg}-read-other-tenant-404", foreign.StatusCode == HttpStatusCode.NotFound && foreignBody.Contains("datasource_not_found", StringComparison.Ordinal), foreignBody);
        gate.Check($"datasources-{leg}-read-unknown-404", (await gate.SendAsync(origin, HttpMethod.Get, Path("/ds_000000000000000000000000"), null, Gate.Trusted(tenantA, ownerA))).Response.StatusCode == HttpStatusCode.NotFound);
        gate.Check($"datasources-{leg}-read-unsafe-404", (await gate.SendAsync(origin, HttpMethod.Get, Path("/bad$id"), null, Gate.Trusted(tenantA, ownerA))).Response.StatusCode == HttpStatusCode.NotFound);

        // Validation parity with Node route/store messages.
        foreach (var (label, payload) in new[] { ("missing", "{}"), ("blank", "{\"csv\":\"  \\n \"}"), ("non-string", "{\"csv\":5}") })
        {
            var (bad, badBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(), payload, Gate.Trusted(tenantA, ownerA));
            gate.Check($"datasources-{leg}-csv-required-{label}", bad.StatusCode == HttpStatusCode.BadRequest && badBody.Contains("csv 字段不能为空", StringComparison.Ordinal), badBody);
        }
        var (invalidCsv, invalidCsvBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(), "{\"csv\":\"machine,material\\n\"}", Gate.Trusted(tenantA, ownerA));
        gate.Check($"datasources-{leg}-csv-invalid-400",
            invalidCsv.StatusCode == HttpStatusCode.BadRequest && invalidCsvBody.Contains("csv_invalid", StringComparison.Ordinal) && invalidCsvBody.Contains("CSV 解析失败：", StringComparison.Ordinal),
            invalidCsvBody);
        var (badJson, badJsonBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(), "{nope", Gate.Trusted(tenantA, ownerA));
        gate.Check($"datasources-{leg}-invalid-json-400", badJson.StatusCode == HttpStatusCode.BadRequest && badJsonBody.Contains("invalid_json", StringComparison.Ordinal), badJsonBody);
        var huge = "{\"csv\":\"" + new string('x', 4 * 1024 * 1024 + 64 * 1024 + 16) + "\"}";
        var (tooLarge, tooLargeBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(), huge, Gate.Trusted(tenantA, ownerA));
        gate.Check($"datasources-{leg}-payload-too-large-413", tooLarge.StatusCode == HttpStatusCode.RequestEntityTooLarge && tooLargeBody.Contains("请求体过大", StringComparison.Ordinal), tooLargeBody);

        // Warnings (row-level parse errors) surface when present.
        var (warned, warnedBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(),
            JsonSerializer.Serialize(new { csv = "machine,material,part,status,cost\nM1,PLA,bracket,ok,abc\nM2,ABS,cover,fail,3\n" }), Gate.Trusted(tenantA, ownerA));
        var warnedJson = Gate.Parse(warnedBody);
        gate.Check($"datasources-{leg}-warnings-surfaced",
            warned.StatusCode == HttpStatusCode.Created && warnedJson.TryGetProperty("warnings", out var warnings) && warnings.GetArrayLength() >= 1,
            warnedBody);

        // Name coercion: String(name || "print_jobs.csv").slice(0, 80).
        var (numericName, numericNameBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(),
            JsonSerializer.Serialize(new { name = 123, csv = OtherCsv }), Gate.Trusted(tenantB, ownerB));
        gate.Check($"datasources-{leg}-name-numeric", numericName.StatusCode == HttpStatusCode.Created && Gate.Parse(numericNameBody).GetProperty("name").GetString() == "123", numericNameBody);
        var (emptyName, emptyNameBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(),
            JsonSerializer.Serialize(new { name = "", csv = OtherCsv, provenance = new { synthetic = true } }), Gate.Trusted(tenantB, ownerB));
        gate.Check($"datasources-{leg}-name-default", emptyName.StatusCode == HttpStatusCode.Created && Gate.Parse(emptyNameBody).GetProperty("name").GetString() == "print_jobs.csv", emptyNameBody);
        var (longName, longNameBody) = await gate.SendAsync(origin, HttpMethod.Post, Path(),
            JsonSerializer.Serialize(new { name = new string('名', 100), csv = Csv }), Gate.Trusted(tenantB, ownerB));
        gate.Check($"datasources-{leg}-name-truncated", longName.StatusCode == HttpStatusCode.Created && Gate.Parse(longNameBody).GetProperty("name").GetString()!.Length == 80, longNameBody);

        // Count reflects live uploads across owners (sample is not stored).
        var count = await mainRepository.CountAsync(ct);
        gate.Check($"datasources-{leg}-count", count == 6, count);

        // Eviction (A5): max 3 → oldest upload disappears, newest three remain.
        var evictionRepository = repositoryFactory(3, "evict");
        var evictionApp = await StartAsync(gate, evictionRepository, ttlMs: 60_000);
        var evictionOrigin = Gate.Origin(evictionApp);
        var evictionTenant = RandomTenant();
        var evictionOwner = "ow_" + evictionTenant[3..];
        var ids = new List<string>();
        for (var i = 0; i < 4; i++)
        {
            var csv = $"machine,material,part,status\nM{i},PLA,part{i},ok\n";
            var (_, body) = await gate.SendAsync(evictionOrigin, HttpMethod.Post, Path(), JsonSerializer.Serialize(new { csv }), Gate.Trusted(evictionTenant, evictionOwner));
            ids.Add(Gate.Parse(body).GetProperty("datasourceId").GetString()!);
            await Task.Delay(5, ct);
        }
        var statuses = new List<HttpStatusCode>();
        foreach (var candidate in ids)
        {
            statuses.Add((await gate.SendAsync(evictionOrigin, HttpMethod.Get, Path("/" + candidate), null, Gate.Trusted(evictionTenant, evictionOwner))).Response.StatusCode);
        }
        gate.Check($"datasources-{leg}-evict-oldest-first",
            statuses[0] == HttpStatusCode.NotFound && statuses.Skip(1).All(static status => status == HttpStatusCode.OK),
            string.Join(",", statuses));

        // TTL: 0 → never expires; a tiny TTL → 404 after expiry, and an expired dup is replaced (not deduplicated).
        var foreverApp = await StartAsync(gate, repositoryFactory(200, "forever"), ttlMs: 0);
        var (forever, foreverBody) = await gate.SendAsync(Gate.Origin(foreverApp), HttpMethod.Post, Path(), JsonSerializer.Serialize(new { csv = Csv }), Gate.Trusted(tenantA, ownerA));
        var foreverRead = await gate.SendAsync(Gate.Origin(foreverApp), HttpMethod.Get, Path("/" + Gate.Parse(foreverBody).GetProperty("datasourceId").GetString()), null, Gate.Trusted(tenantA, ownerA));
        gate.Check($"datasources-{leg}-ttl-zero-never-expires",
            forever.StatusCode == HttpStatusCode.Created && !Gate.Parse(foreverRead.Body).TryGetProperty("expiresAt", out _),
            foreverRead.Body);
        var ttlRepository = repositoryFactory(200, "ttl");
        var ttlApp = await StartAsync(gate, ttlRepository, ttlMs: 30);
        var ttlTenant = RandomTenant();
        var ttlOwner = "ow_" + ttlTenant[3..];
        var (shortLived, shortBody) = await gate.SendAsync(Gate.Origin(ttlApp), HttpMethod.Post, Path(), JsonSerializer.Serialize(new { csv = Csv }), Gate.Trusted(ttlTenant, ttlOwner));
        var shortId = Gate.Parse(shortBody).GetProperty("datasourceId").GetString()!;
        await Task.Delay(100, ct);
        var (expired, _) = await gate.SendAsync(Gate.Origin(ttlApp), HttpMethod.Get, Path("/" + shortId), null, Gate.Trusted(ttlTenant, ttlOwner));
        gate.Check($"datasources-{leg}-ttl-expired-404", shortLived.StatusCode == HttpStatusCode.Created && expired.StatusCode == HttpStatusCode.NotFound, expired.StatusCode);
        var (replaced, replacedBody) = await gate.SendAsync(Gate.Origin(ttlApp), HttpMethod.Post, Path(), JsonSerializer.Serialize(new { csv = Csv }), Gate.Trusted(ttlTenant, ttlOwner));
        gate.Check($"datasources-{leg}-ttl-expired-dup-replaced",
            replaced.StatusCode == HttpStatusCode.Created && !Gate.Parse(replacedBody).GetProperty("deduplicated").GetBoolean() && Gate.Parse(replacedBody).GetProperty("datasourceId").GetString() == shortId,
            replacedBody);
        await Task.Delay(100, ct);
        var swept = await ttlRepository.SweepAsync(DateTimeOffset.UtcNow, ct);
        gate.Check($"datasources-{leg}-sweep", swept >= 1, swept);

        if (leg == "file")
        {
            // Restart: a fresh repository over the same directory still serves the record.
            var directory = ((FileDatasourceRepository)mainRepository).RootDirectory;
            var reopened = new FileDatasourceRepository(directory, 200);
            var persisted = await reopened.GetAsync(tenantA, ownerA, id, ct);
            gate.Check($"datasources-{leg}-survives-restart", persisted is { Name: "jobs.csv" } && persisted.Rows.GetArrayLength() == 2, persisted?.Name);
        }

        await mainRepository.ProbeAsync(ct);
        gate.Check($"datasources-{leg}-probe", true);
    }

    private static Task<WebApplication> StartAsync(Gate gate, IDatasourceRepository repository, long ttlMs) =>
        gate.StartApiAsync(
            new Dictionary<string, string?>(),
            builder =>
            {
                builder.Services.AddSingleton(new DatasourceOptions(ttlMs, 200));
                builder.Services.AddSingleton(repository);
            },
            DatasourceEndpoints.Map);

    private static string RandomTenant() => "tn_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
}
