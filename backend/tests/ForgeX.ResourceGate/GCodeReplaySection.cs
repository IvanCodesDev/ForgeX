using System.Text;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Domain;
using ForgeX.Infrastructure;
using ForgeX.Simulation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace ForgeX.ResourceGate;

internal static class GCodeReplaySection
{
    public static async Task RunAsync(Gate gate)
    {
        gate.Section("gcode-replay: source chronology, pagination and owned checkpoints");
        var options = new GCodeAnalysisOptions();
        var source = await new StreamingGCodeAnalyzer().AnalyzeAsync(new MemoryStream(Encoding.UTF8.GetBytes(
            "G90\nM82\nG1 X10 Y0 Z0.4 F600\nG1 X20 Y0 E1 F600\nG1 X30 Y0 Z0.2 E2\nG1 X40 Y0 Z0.4 E3\nG1 E2.5\n")), options, CancellationToken.None);
        var id = new string('e', 32);
        var plan = new GCodeLayerReplay(id, source);
        var page = plan.Page(0, 1);
        gate.Check("replay-analyzer-preserves-source-order", source.Layers.Select(l => l.SourceOrder).Order().SequenceEqual(new int?[] { 0, 1, 2 }) && source.Layers[0].SourceOrder == 1);
        gate.Check("replay-execution-order-before-height-sort", page.Layers[0].ZMm == 0.4 && page.Layers[0].LayerIndex != 0 && plan.Page(1, 1).Layers[0].ZMm == 0.2);
        gate.Check("replay-leading-motion", page.LeadingMotionSeconds == 1 && page.Layers[0].StartSeconds == 1);
        gate.Check("replay-page-bounds", page.NextOffset == 1 && page.Layers.Count == 1 && plan.Page(3, 1).Layers.Count == 0 && plan.Page(2, 1).NextOffset is null);
        gate.Check("replay-stable-fingerprint", new GCodeLayerReplay(id, source).Page(1).Fingerprint == page.Fingerprint && plan.Seek(0).Fingerprint == page.Fingerprint);
        gate.Check("replay-net-and-positive-filament-separated", page.TotalPositiveExtrusionMm == 3 && page.Basis.NetFilamentLengthM == 0.0025);
        var first = plan.Seek(0);
        gate.Check("replay-initial-travel", first is { Phase: "initial-travel", ActiveLayer: null, CompletedLayerCount: 0, LayerFraction: null, CompletedPositiveExtrusionMm: 0 });
        var middle = plan.Seek(1.5);
        gate.Check("replay-time-fraction-only", middle is { Phase: "layer", CompletedLayerCount: 0, CompletedPositiveExtrusionMm: 0, LayerFraction: 0.5 });
        var boundary = plan.Seek(page.Layers[0].EndSeconds);
        gate.Check("replay-exact-boundary-next-layer", boundary is { CompletedLayerCount: 1, CompletedPositiveExtrusionMm: 1, LayerFraction: 0 } && boundary.ActiveLayer?.Sequence == 1);
        var end = plan.Seek(page.TotalSeconds);
        gate.Check("replay-completed", end is { Phase: "completed", ActiveLayer: null, RemainingSeconds: 0, CompletedLayerCount: 3, CompletedPositiveExtrusionMm: 3 });
        var zero = source with { Statistics = source.Statistics with { TimeSeconds = 0 }, Layers = source.Layers.Select(l => l with { TimeSeconds = 0 }).ToArray() };
        gate.Check("replay-zero-duration-layers-no-division", new GCodeLayerReplay(id, zero).Seek(0) is { Phase: "completed", CompletedLayerCount: 3, LayerFraction: null });
        foreach (var time in new[] { -1d, double.NaN, double.PositiveInfinity, page.TotalSeconds + 1 })
        {
            try { plan.Seek(time); gate.Check("replay-reject-time-" + time, false); }
            catch (GCodeReplayException e) { gate.Check("replay-reject-time-" + time, e.Code == "replay_time_invalid"); }
        }
        foreach (var (offset, limit) in new[] { (-1, 50), (4, 50), (0, 0), (0, 201) })
        {
            try { plan.Page(offset, limit); gate.Check($"replay-reject-page-{offset}-{limit}", false); }
            catch (GCodeReplayException e) { gate.Check($"replay-reject-page-{offset}-{limit}", e.Code == "replay_page_invalid"); }
        }
        var old = source with { Layers = source.Layers.Select(l => l with { SourceOrder = null }).ToArray() };
        var corrupt = source with { Layers = source.Layers.Select(l => l with { SourceOrder = 0 }).ToArray() };
        foreach (var (changed, code) in new[] { (old, "replay_source_order_unavailable"), (corrupt, "replay_source_invalid"), (source with { Statistics = source.Statistics with { TimeSeconds = 0 } }, "replay_source_invalid") })
        {
            try { _ = new GCodeLayerReplay(id, changed); gate.Check("replay-reject-source-" + code, false); }
            catch (GCodeReplayException e) { gate.Check("replay-reject-source-" + code, e.Code == code); }
        }
        var changedSource = source with { Layers = source.Layers.Select(l => l with { FilamentLengthMm = l.FilamentLengthMm + 1 }).ToArray() };
        gate.Check("replay-fingerprint-binds-layer-values", new GCodeLayerReplay(id, changedSource).Page().Fingerprint != page.Fingerprint);
        var cancelled = new CancellationToken(true);
        try { _ = new GCodeLayerReplay(id, source, cancelled); gate.Check("replay-build-cancelled", false); }
        catch (OperationCanceledException) { gate.Check("replay-build-cancelled", true); }

        var repository = new FileGCodeJobRepository(gate.TempDir("replay-jobs"));
        var now = DateTimeOffset.UtcNow;
        var job = new GCodeJobRecord(id, null, source.Sha256, source.Sha256, source.BytesRead, options, GCodeJobStatus.Succeeded, 1, "succeeded", now, now, now, source.EngineVersion, source, null, null, null, [], Gate.Tenant('e'), Gate.Owner('e'));
        await repository.SaveAsync(job, CancellationToken.None);
        var app = await gate.StartApiAsync(new() { ["DirectAuth:RequireAuth"] = "true", ["DirectAuth:ApiKeys"] = "replay-key" }, b => b.Services.AddSingleton<IGCodeJobRepository>(repository), a =>
        {
            a.MapGet("/api/v1/gcode/analyses/{id}/layer-timeline", (RequestDelegate)(async context => await (await GCodeReplayEndpoints.TimelineAsync(context, context.Request.RouteValues["id"]!.ToString()!, repository)).ExecuteAsync(context)));
            a.MapPost("/api/v1/gcode/analyses/{id}/replay-checkpoints", (RequestDelegate)(async context => await (await GCodeReplayEndpoints.CheckpointAsync(context, context.Request.RouteValues["id"]!.ToString()!, repository)).ExecuteAsync(context)));
        });
        var origin = Gate.Origin(app);
        var owner = Gate.Trusted(job.TenantId, job.OwnerId);
        var path = "/api/v1/gcode/analyses/" + id + "/";
        async Task<int> Send(string suffix, string? body = null, (string Name, string Value)[]? headers = null)
        {
            var sent = await gate.SendAsync(origin, body is null ? HttpMethod.Get : HttpMethod.Post, path + suffix, body, headers ?? owner);
            using (sent.Response) return (int)sent.Response.StatusCode;
        }
        gate.Check("replay-http-owner-page", await Send("layer-timeline?offset=1&limit=1") == 200);
        gate.Check("replay-http-owner-seek", await Send("replay-checkpoints", "{\"elapsedSeconds\":1.5}") == 200);
        gate.Check("replay-http-no-auth", await Send("layer-timeline", headers: []) == 401);
        gate.Check("replay-http-cross-owner", await Send("layer-timeline", headers: Gate.Trusted(job.TenantId, Gate.Owner('f'))) == 404);
        gate.Check("replay-http-cross-tenant-seek", await Send("replay-checkpoints", "{\"elapsedSeconds\":0}", Gate.Trusted(Gate.Tenant('f'), job.OwnerId)) == 404);
        foreach (var query in new[] { "offset=-1", "limit=201", "offset=4", "offset=0&offset=1", "limit=abc", "extra=1", "limit=1.5" })
            gate.Check("replay-http-query-" + query, await Send("layer-timeline?" + query) == 400);
        foreach (var body in new[] { "{}", "null", "{\"elapsedSeconds\":\"1\"}", "{\"elapsedSeconds\":-1}", "{\"elapsedSeconds\":100}", "{\"elapsedSeconds\":0,\"x\":0}", "{\"elapsedSeconds\":0,\"elapsedSeconds\":1}", "{\"ElapsedSeconds\":0}" })
            gate.Check("replay-http-json-" + body, await Send("replay-checkpoints", body) == 400);
        gate.Check("replay-http-size-limit", await Send("replay-checkpoints", "{\"elapsedSeconds\":0}" + new string(' ', 4096)) == 413);
        await repository.SaveAsync(job with { Status = GCodeJobStatus.Running }, CancellationToken.None);
        gate.Check("replay-http-not-ready", await Send("layer-timeline") == 409);
        await repository.SaveAsync(job with { Result = old }, CancellationToken.None);
        gate.Check("replay-http-old-job-reanalyze", await Send("layer-timeline") == 409);
        await repository.SaveAsync(job with { Result = corrupt }, CancellationToken.None);
        gate.Check("replay-http-corrupt-order", await Send("layer-timeline") == 422);
        await repository.SaveAsync(job with { InputSha256 = new string('f', 64) }, CancellationToken.None);
        gate.Check("replay-http-corrupt-binding", await Send("replay-checkpoints", "{\"elapsedSeconds\":0}") == 422);
        gate.Check("replay-metrics-canonical", ForgeXMetrics.RouteLabel((path + "replay-checkpoints").ToUpperInvariant()) == "/api/v1/gcode/analyses/{id}/replay-checkpoints");
    }
}
