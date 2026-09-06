using System.Text.Json;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;

namespace ForgeX.ResourceGate;

/// <summary>ResourceSweeper removes expired records across repositories; gauges carry Node's metric names.</summary>
internal static class SweeperSection
{
    public static async Task RunAsync(Gate gate)
    {
        gate.Section("sweeper: ResourceSweeper + resource gauges");
        var ct = CancellationToken.None;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var tenant = Gate.Tenant('c');
        var owner = Gate.Owner('c');

        var datasources = new FileDatasourceRepository(gate.TempDir("sweeper-datasources"), 10);
        var knowledge = new FileKnowledgeRepository(gate.TempDir("sweeper-knowledge"), 10);
        var shares = new FileShareRepository(gate.TempDir("sweeper-shares"), TimeSpan.FromMilliseconds(1), 10);
        var calibrations = new FileCalibrationGovernanceStore(Path.Combine(gate.TempDir("sweeper-calibrations"), "calibrations.json"));

        var rows = JsonDocument.Parse("[{\"machine_id\":\"M1\",\"status\":\"success\"}]").RootElement.Clone();
        var provenance = JsonDocument.Parse("{\"source\":\"upload\"}").RootElement.Clone();
        await datasources.CreateOrGetAsync(new DatasourceRecord("ds_" + new string('1', 24), tenant, owner, "expired.csv", "a,b\n1,2\n", rows, new string('a', 64), new string('b', 64), [], provenance, now - 5_000, now - 1_000), ct);
        await datasources.CreateOrGetAsync(new DatasourceRecord("ds_" + new string('2', 24), tenant, owner, "live.csv", "a,b\n1,3\n", rows, new string('c', 64), new string('d', 64), [], provenance, now, now + 600_000), ct);
        await knowledge.CreateAsync(new KnowledgeDocument("kb_" + new string('1', 16), tenant, owner, "expired.md", "gone", now - 5_000, now - 1_000), ct);
        await knowledge.CreateAsync(new KnowledgeDocument("kb_" + new string('2', 16), tenant, owner, "live.md", "stays", now, null), ct);
        await shares.CreateAsync(tenant, owner, "{\"ok\":true}", "q", "rules", null, 1, ct);
        await Task.Delay(20, ct);

        var sweeper = new ResourceSweeper([datasources, knowledge, shares], NullLogger<ResourceSweeper>.Instance, TimeSpan.FromMilliseconds(25));
        await sweeper.StartAsync(ct);
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (sweeper.Sweeps < 2 && DateTime.UtcNow < deadline)
        {
            await Task.Delay(10, ct);
        }
        await sweeper.StopAsync(ct);
        gate.Check("sweeper-rounds-completed", sweeper.Sweeps >= 2, sweeper.Sweeps);

        var liveNow = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var expiredDatasource = await datasources.GetAsync(tenant, owner, "ds_" + new string('1', 24), ct);
        var liveDatasource = await datasources.GetAsync(tenant, owner, "ds_" + new string('2', 24), ct);
        gate.Check("sweeper-datasource-expired-removed",
            expiredDatasource is null && liveDatasource is { Name: "live.csv" } &&
            !File.Exists(Path.Combine(datasources.RootDirectory, "ds_" + new string('1', 24) + ".json")),
            liveNow);
        var docs = await knowledge.ListAsync(tenant, owner, ct);
        gate.Check("sweeper-knowledge-expired-removed",
            docs.Count == 1 && docs[0].Name == "live.md" &&
            !File.Exists(Path.Combine(knowledge.RootDirectory, "kb_" + new string('1', 16) + ".json")),
            docs.Count);
        gate.Check("sweeper-shares-expired-removed", await shares.CountAsync(ct) == 0, await shares.CountAsync(ct));
        gate.Check("sweeper-counts-after", await datasources.CountAsync(ct) == 1 && await knowledge.CountAsync(ct) == 1);

        // A failing repository must not break the round for the others.
        var faulty = new FaultyResource();
        var resilient = new ResourceSweeper([faulty, knowledge], NullLogger<ResourceSweeper>.Instance, TimeSpan.FromSeconds(60));
        await resilient.SweepOnceAsync(DateTimeOffset.UtcNow, ct);
        gate.Check("sweeper-isolates-failures", resilient.Sweeps == 1 && faulty.Calls == 1, faulty.Calls);

        // Gauges: Node metric names + HELP texts; a failing sampler falls back to the last value.
        var sampler = new ResourceGaugeSampler([datasources, knowledge, shares, faulty], calibrations, NullLogger<ResourceGaugeSampler>.Instance);
        var gauges = await sampler.SampleAsync(ct);
        var rendered = new ForgeXMetrics().Render("gate", new GCodeJobQueue(1), [], gauges);
        gate.Check("metrics-resource-gauges",
            rendered.Contains("# HELP forgex_datasources 已存数据源数\n# TYPE forgex_datasources gauge\nforgex_datasources 1\n".Replace("\n", Environment.NewLine), StringComparison.Ordinal) &&
            rendered.Contains("forgex_knowledge_docs 1" + Environment.NewLine, StringComparison.Ordinal) &&
            rendered.Contains("# HELP forgex_shares 有效分享页数", StringComparison.Ordinal) &&
            rendered.Contains("forgex_shares 0" + Environment.NewLine, StringComparison.Ordinal) &&
            rendered.Contains("# HELP forgex_calibrations_approved 已发布校准 bundle 数", StringComparison.Ordinal) &&
            rendered.Contains("forgex_calibrations_approved 0" + Environment.NewLine, StringComparison.Ordinal) &&
            rendered.Contains("# HELP forgex_calibrations_pending 待审核校准 bundle 数", StringComparison.Ordinal) &&
            rendered.Contains("forgex_calibrations_pending 0" + Environment.NewLine, StringComparison.Ordinal) &&
            rendered.Contains("forgex_faulty 0" + Environment.NewLine, StringComparison.Ordinal),
            rendered);
        var withoutCalibrations = await new ResourceGaugeSampler([datasources], null, NullLogger<ResourceGaugeSampler>.Instance).SampleAsync(ct);
        gate.Check("metrics-gauges-only-enabled", withoutCalibrations.Count == 1 && withoutCalibrations[0].Metric == "forgex_datasources", withoutCalibrations.Count);
    }

    private sealed class FaultyResource : IResourceSweepable
    {
        public int Calls { get; private set; }

        public string ResourceName => "faulty";

        public Task<int> SweepAsync(DateTimeOffset now, CancellationToken cancellationToken)
        {
            Calls++;
            throw new IOException("disk on fire");
        }

        public Task<long> CountAsync(CancellationToken cancellationToken) => throw new IOException("disk on fire");
    }
}
