using System.Text;
using System.Text.Json;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Domain;
using ForgeX.Infrastructure;
using ForgeX.Simulation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace ForgeX.ResourceGate;

internal static class GCodeCostSection
{
    public static async Task RunAsync(Gate gate)
    {
        gate.Section("gcode-cost: declared inputs, audit fingerprint and owned source");
        var options = new GCodeAnalysisOptions();
        var parsed = await new StreamingGCodeAnalyzer().AnalyzeAsync(new MemoryStream(Encoding.UTF8.GetBytes("G90\nM82\nG1 X0 Y0 Z0.2 F600\nG1 X10 Y0 E1 F600\n")), options, CancellationToken.None);
        var wire = JsonSerializer.SerializeToElement(GCodeEndpoints.ToResponse(parsed, options), new JsonSerializerOptions(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });
        gate.Check("cost-prerequisite-risk-temperatures-explicit-null", wire.GetProperty("risk").GetProperty("nozzleTemperatureC").ValueKind == JsonValueKind.Null && wire.GetProperty("risk").GetProperty("bedTemperatureC").ValueKind == JsonValueKind.Null);
        var findings = wire.GetProperty("risk").GetProperty("findings").EnumerateArray().ToArray();
        gate.Check("cost-prerequisite-risk-null-fields-retained", findings.Any(f => f.GetProperty("unit").ValueKind == JsonValueKind.Null) && findings.All(f => new[] { "observed", "minimum", "maximum", "unit" }.All(key => f.TryGetProperty(key, out _))));
        var source = parsed with { Statistics = parsed.Statistics with { TimeSeconds = 3600, FilamentMassG = 100 } };
        var id = new string('a', 32);
        var inputs = new GCodeCostInputs(200, 1, 5, 100, "台架平均功率与费率记录 2026-10-21");
        GCodeCostEstimate Estimate(GCodeCostInputs? values = null, GCodeAnalysisResult? basis = null) => GCodeCostEstimator.Estimate(id, basis ?? source, values ?? inputs);
        var full = Estimate();
        gate.Check("cost-one-hour-energy", full.Totals.EnergyKwh == 0.2m);
        gate.Check("cost-itemized-formulas", full.Totals is { MaterialCostCny: 10, ElectricityCostCny: 0.2m, MachineTimeCostCny: 5, TotalCostCny: 15.2m, IsComplete: true });
        gate.Check("cost-source-fingerprint-bound", full.Basis.InputSha256 == source.Sha256 && full.Basis.ProfileFingerprint == source.Profile.Fingerprint && full.Fingerprint.Length == 64);
        gate.Check("cost-version-currency", full.SchemaVersion == "1.0" && full.ModelVersion == "forgex-gcode-cost/2" && full.Currency == "CNY");
        gate.Check("cost-repeatable", Estimate().Fingerprint == full.Fingerprint);
        var clean = Estimate(inputs with { AveragePowerWatts = 200.000m, Evidence = " a\r\nb " });
        gate.Check("cost-canonical-normalization", clean.Fingerprint == Estimate(inputs with { Evidence = "a\nb" }).Fingerprint);
        gate.Check("cost-tiny-decimal-no-overflow", Estimate(inputs with { AveragePowerWatts = 0.0000000000000000000000000001m }).Totals.EnergyKwh == 0);
        var empty = Estimate(new(null, null, null, null, ""));
        gate.Check("cost-missing-is-not-zero", empty.Totals is { IsComplete: false, TotalCostCny: null, EnergyKwh: null } && empty.MissingInputs.Count == 4);
        gate.Check("cost-null-fields-serialized", JsonSerializer.Serialize(empty).Contains("\"TotalCostCny\":null"));
        var free = Estimate(new(0, 0, 0, 0, "明确不计费的试验"));
        gate.Check("cost-explicit-zero-is-known", free.Totals is { IsComplete: true, TotalCostCny: 0, EnergyKwh: 0 } && free.MissingInputs.Count == 0);
        var powerOnly = Estimate(new(200, null, null, null, "仅平均功率测量"));
        gate.Check("cost-power-without-tariff", powerOnly.Totals is { EnergyKwh: 0.2m, ElectricityCostCny: null, TotalCostCny: null });
        var rounding = new GCodeCostInputs(0, 0, 0, 100, "rounding scenario");
        var half = Estimate(rounding, source with { Statistics = source.Statistics with { FilamentMassG = 0.000005 } });
        var oneAndHalf = Estimate(rounding, source with { Statistics = source.Statistics with { FilamentMassG = 0.000015 } });
        gate.Check("cost-midpoint-to-even", half.Totals.TotalCostCny == 0 && oneAndHalf.Totals.TotalCostCny == 0.000002m);
        var maximum = Estimate(new(100000, 100, 100000, 5000, "range boundary scenario"), source with { Statistics = source.Statistics with { TimeSeconds = 31_536_000, FilamentMassG = 1_000_000 } });
        gate.Check("cost-maximum-bounded", maximum.Totals.TotalCostCny == 968_600_000m && maximum.Totals.IsComplete);
        foreach (var (changed, index) in new[] { inputs with { AveragePowerWatts = 201 }, inputs with { ElectricityCnyPerKwh = 2 }, inputs with { MachineCnyPerHour = 6 }, inputs with { MaterialCnyPerKg = 101 }, inputs with { Evidence = "其他记录" } }.Select((value, index) => (value, index)))
            gate.Check("cost-input-change-fingerprint-" + index, Estimate(changed).Fingerprint != full.Fingerprint);
        foreach (var (changed, index) in new[] { source with { Sha256 = new string('b', 64) }, source with { Profile = source.Profile with { Fingerprint = new string('b', 64) } }, source with { EngineVersion = "other" }, source with { Statistics = source.Statistics with { TimeSeconds = 3601 } }, source with { Statistics = source.Statistics with { FilamentMassG = 101 } } }.Select((value, index) => (value, index)))
            gate.Check("cost-source-change-fingerprint-" + index, Estimate(basis: changed).Fingerprint != full.Fingerprint);
        var badInputs = new[] { inputs with { AveragePowerWatts = -1 }, inputs with { AveragePowerWatts = 100001 }, inputs with { ElectricityCnyPerKwh = -1 }, inputs with { ElectricityCnyPerKwh = 101 }, inputs with { MachineCnyPerHour = -1 }, inputs with { MachineCnyPerHour = 100001 }, inputs with { MaterialCnyPerKg = -1 }, inputs with { MaterialCnyPerKg = 5001 }, inputs with { Evidence = " " }, inputs with { Evidence = new string('x', 501) }, inputs with { Evidence = "x\0" } };
        for (var i = 0; i < badInputs.Length; i++)
        {
            try { Estimate(badInputs[i]); gate.Check("cost-reject-input-" + i, false); }
            catch (GCodeCostException) { gate.Check("cost-reject-input-" + i, true); }
        }
        foreach (var duration in new[] { -1d, double.NaN, double.PositiveInfinity, 31_536_001d })
        {
            try { Estimate(basis: source with { Statistics = source.Statistics with { TimeSeconds = duration } }); gate.Check("cost-reject-duration-" + duration, false); }
            catch (GCodeCostException e) { gate.Check("cost-reject-duration-" + duration, e.Code == "cost_source_invalid"); }
        }
        gate.Check("cost-limitations-disclosed", full.Warnings.Any(w => w.Contains("预热") && w.Contains("不是电表")) && full.Warnings.Any(w => w.Contains("重复计费")));
        var repository = new FileGCodeJobRepository(gate.TempDir("cost-jobs"));
        var now = DateTimeOffset.UtcNow;
        var job = new GCodeJobRecord(id, null, source.Sha256, source.Sha256, source.BytesRead, options, GCodeJobStatus.Succeeded, 1, "succeeded", now, now, now, source.EngineVersion, source, null, null, null, [], Gate.Tenant('c'), Gate.Owner('c'));
        await repository.SaveAsync(job, CancellationToken.None);
        var app = await gate.StartApiAsync(new() { ["DirectAuth:RequireAuth"] = "true", ["DirectAuth:ApiKeys"] = "cost-key" }, b => b.Services.AddSingleton<IGCodeJobRepository>(repository), a => a.MapPost("/api/v1/gcode/analyses/{id}/cost-estimates", (RequestDelegate)(async context =>
        {
            var response = await GCodeCostEndpoints.EstimateAsync(context, context.Request.RouteValues["id"]!.ToString()!, repository);
            await response.ExecuteAsync(context);
        })));
        var origin = Gate.Origin(app);
        var json = JsonSerializer.Serialize(inputs, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var path = "/api/v1/gcode/analyses/" + id + "/cost-estimates";
        var owner = Gate.Trusted(job.TenantId, job.OwnerId);
        async Task<int> Send(string body, (string Name, string Value)[]? headers = null, string? target = null)
        {
            var sent = await gate.SendAsync(origin, HttpMethod.Post, target ?? path, body, headers ?? owner);
            using (sent.Response) return (int)sent.Response.StatusCode;
        }
        gate.Check("cost-http-owner", await Send(json) == 200);
        gate.Check("cost-http-case-insensitive-route", await Send(json, target: path.ToUpperInvariant()) == 200);
        gate.Check("cost-http-no-auth", await Send(json, []) == 401);
        gate.Check("cost-http-other-owner", await Send(json, Gate.Trusted(job.TenantId, Gate.Owner('d'))) == 404);
        gate.Check("cost-http-other-tenant", await Send(json, Gate.Trusted(Gate.Tenant('d'), job.OwnerId)) == 404);
        gate.Check("cost-http-bad-id", await Send(json, target: path.Replace(id, "bad")) == 404);
        gate.Check("cost-http-missing-id", await Send(json, target: path.Replace(id, new string('b', 32))) == 404);
        gate.Check("cost-http-forged-basis", await Send(json[..^1] + ",\"durationSeconds\":0}") == 400);
        gate.Check("cost-http-required-fields", await Send("{}") == 400);
        gate.Check("cost-http-duplicate-fields", await Send(json[..^1] + ",\"averagePowerWatts\":201}") == 400);
        gate.Check("cost-http-null-body", await Send("null") == 400);
        gate.Check("cost-http-missing-evidence", await Send("{\"averagePowerWatts\":0,\"electricityCnyPerKwh\":0,\"machineCnyPerHour\":0,\"materialCnyPerKg\":0,\"evidence\":\"\"}") == 400);
        gate.Check("cost-http-nonfinite", await Send(json.Replace("200", "NaN")) == 400);
        gate.Check("cost-http-no-numeric-string-coercion", await Send("{\"averagePowerWatts\":\"200\",\"electricityCnyPerKwh\":1,\"machineCnyPerHour\":5,\"materialCnyPerKg\":100,\"evidence\":\"record\"}") == 400);
        gate.Check("cost-http-size", await Send(json + new string(' ', 17000)) == 413);
        await repository.SaveAsync(job with { Status = GCodeJobStatus.Running }, CancellationToken.None);
        gate.Check("cost-http-job-not-ready", await Send(json) == 409);
        await repository.SaveAsync(job with { InputSha256 = new string('b', 64) }, CancellationToken.None);
        gate.Check("cost-http-corrupt-source", await Send(json) == 422);
        await repository.SaveAsync(job, CancellationToken.None);
        var check = await gate.SendAsync(origin, HttpMethod.Post, path, json, owner);
        using (check.Response)
        {
            var response = Gate.Parse(check.Body);
            gate.Check("cost-http-body-math", response.GetProperty("totals").GetProperty("totalCostCny").GetDecimal() == 15.2m);
            gate.Check("cost-http-body-fingerprint", response.GetProperty("fingerprint").GetString() == full.Fingerprint);
        }
        gate.Check("cost-metrics-canonical-route", ForgeXMetrics.RouteLabel(path.ToUpperInvariant()) == "/api/v1/gcode/analyses/{id}/cost-estimates");
    }
}
