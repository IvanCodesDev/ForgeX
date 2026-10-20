using System.Net;
using System.Text.Json;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Infrastructure;
using ForgeX.Simulation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace ForgeX.ResourceGate;

/// <summary>Drive the deployment health endpoint through real storage failures and recovery.</summary>
internal static class HealthSection
{
    public static async Task RunAsync(Gate gate)
    {
        gate.Section("public-health: startup, failed storage and recovery");
        var root = gate.TempDir("public-health");
        var objectsRoot = Path.Combine(root, "objects");
        var sharesRoot = Path.Combine(root, "shares");
        var jobsRoot = Path.Combine(root, "jobs");
        var objects = new ContentAddressedObjectStore(objectsRoot);
        var jobs = new FileGCodeJobRepository(jobsRoot);
        var queue = new GCodeJobQueue(2);
        var metrics = new ForgeXMetrics();
        using var worker = new GCodeJobWorker(queue, jobs, objects, new StreamingGCodeAnalyzer(),
            new GCodeJobRuntime(), new GCodeJobRetryOptions(), metrics, NullLogger<GCodeJobWorker>.Instance);
        var aiOptions = new AnalysisAiOptions("rules", AnalysisAiOptions.DefaultBaseUrl, "", "", 1000, false);
        var app = await gate.StartApiAsync([], builder =>
        {
            builder.Services.AddSingleton(aiOptions);
            builder.Services.AddSingleton(new AnalysisProviderSelection(aiOptions, NullLogger<AnalysisProviderSelection>.Instance));
            builder.Services.AddSingleton(new AnalysisCostGate(new AnalysisGateOptions(1, 1, 10, 10)));
            builder.Services.AddSingleton<IContentObjectStore>(objects);
            builder.Services.AddSingleton<IGCodeJobRepositoryMaintenance>(jobs);
            builder.Services.AddSingleton<IGCodeJobQueue>(queue);
            builder.Services.AddSingleton<IShareRepository>(new FileShareRepository(sharesRoot));
            builder.Services.AddSingleton(metrics);
            builder.Services.AddSingleton(worker);
        }, app => app.MapGet("/healthz", (Func<HttpContext, Task<IResult>>)PublicFacade.HealthzAsync));
        var origin = Gate.Origin(app);

        async Task CheckHealthAsync(string name, HttpStatusCode expected, string? error = null)
        {
            var (response, body) = await gate.SendAsync(origin, HttpMethod.Get, "/healthz");
            var json = Gate.Parse(body);
            gate.Check(name, response.StatusCode == expected &&
                json.GetProperty("ok").GetBoolean() == (expected == HttpStatusCode.OK) &&
                (error is null || json.GetProperty("error").GetString() == error), body);
            gate.Check(name + "-no-storage-path-disclosure",
                !json.EnumerateObject().Any(property => property.Value.ValueKind == JsonValueKind.String &&
                    property.Value.GetString()!.Contains(root, StringComparison.OrdinalIgnoreCase)), body);
        }

        // A file occupying an owned temporary directory reliably fails on Windows and Linux,
        // unlike read-only mode bits when tests run with elevated filesystem privileges.
        async Task BlockDirectoryAsync(string directory, string error)
        {
            var full = Path.GetFullPath(directory);
            var backup = full + "-fixture-backup";
            if (!string.Equals(Path.GetDirectoryName(full), Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Path.GetDirectoryName(backup), Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Fault fixture must stay inside its owned test root.");
            }
            Directory.Move(full, backup);
            try
            {
                await File.WriteAllTextAsync(full, "fault fixture");
                await CheckHealthAsync(Path.GetFileName(full) + "-unavailable", HttpStatusCode.ServiceUnavailable, error);
            }
            finally
            {
                File.Delete(full);
                Directory.Move(backup, full);
            }
            await CheckHealthAsync(Path.GetFileName(full) + "-recovered", HttpStatusCode.OK);
        }

        try
        {
            await CheckHealthAsync("worker-starting-not-ready", HttpStatusCode.ServiceUnavailable, "gcode_unavailable");
            await worker.StartAsync(CancellationToken.None);
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (!worker.Started && DateTime.UtcNow < deadline) await Task.Delay(10);
            await CheckHealthAsync("all-storage-ready", HttpStatusCode.OK);
            await BlockDirectoryAsync(sharesRoot, "persistence_unavailable");
            await BlockDirectoryAsync(objectsRoot, "gcode_unavailable");
            await BlockDirectoryAsync(jobsRoot, "gcode_unavailable");
        }
        finally
        {
            await worker.StopAsync(CancellationToken.None);
        }
    }
}
