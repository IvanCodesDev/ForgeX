using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using ForgeX.Analytics;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace ForgeX.ResourceGate;

/// <summary>
/// Stage 8.6c-2b (rules-engine leg): POST /api/v1/analysis-tasks creates a task that the in-process host
/// executes and persists into forgex.node_analysis_tasks exactly the way Node did. PostgreSQL only —
/// there is no file provider for analysis tasks — so the whole section is skipped without POSTGRES_URL.
/// </summary>
internal static class AnalysisTasksSection
{
    private const string Csv = "machine_id,model_name,material,status,duration_min,cost_fen,fail_reason\nM1,Bracket,PLA,success,42,1250,\nM2,Bracket,ABS,fail,55,1800,warping\nM1,Gear,PLA,success,30,900,\n";

    public static async Task RunAsync(Gate gate)
    {
        if (!gate.HasPostgres)
        {
            return;
        }

        gate.Section("analysis-tasks-postgres: AnalysisTaskEndpoints (create → execute → snapshot)");
        var ct = CancellationToken.None;
        var tenantA = RandomTenant();
        var ownerA = "ow_" + tenantA[3..];
        var tenantB = RandomTenant();
        var ownerB = "ow_" + tenantB[3..];

        var tasks = new PostgresAnalysisTaskRepository(gate.PostgresUrl);
        var datasources = new PostgresDatasourceRepository(gate.PostgresUrl, 200);
        var options = new AnalysisTaskOptions(TtlMs: 60_000, Concurrency: 2, QueueCapacity: 16, StaleRunningMs: 60_000);
        var app = await gate.StartApiAsync(
            new Dictionary<string, string?>(),
            builder =>
            {
                builder.Services.AddSingleton(new DatasourceOptions(60_000, 200));
                builder.Services.AddSingleton<IDatasourceRepository>(datasources);
                builder.Services.AddSingleton(tasks);
                builder.Services.AddSingleton(options);
                builder.Services.AddSingleton(new AnalysisTaskQueue(options.QueueCapacity));
                builder.Services.AddSingleton<AnalysisTaskRuntime>();
                builder.Services.AddHostedService<AnalysisTaskWorker>();
            },
            api =>
            {
                DatasourceEndpoints.Map(api);
                AnalysisTaskEndpoints.Map(api);
            });
        var origin = Gate.Origin(app);
        var trustedA = Gate.Trusted(tenantA, ownerA);

        // Validation mirrors Node's POST /api/analyze messages.
        var (emptyQuestion, emptyBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = "  ", datasourceId = "sample" }), trustedA);
        gate.Check("analysis-create-empty-question-400",
            emptyQuestion.StatusCode == HttpStatusCode.BadRequest && Gate.Parse(emptyBody).GetProperty("title").GetString() == "question 不能为空",
            emptyBody);
        var (longQuestion, longBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = new string('问', 501), datasourceId = "sample" }), trustedA);
        gate.Check("analysis-create-long-question-400",
            longQuestion.StatusCode == HttpStatusCode.BadRequest && Gate.Parse(longBody).GetProperty("title").GetString() == "question 超过 500 字",
            longBody);
        var (missing, missingBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = "x", datasourceId = "ds_" + new string('0', 24) }), trustedA);
        gate.Check("analysis-create-missing-datasource-404",
            missing.StatusCode == HttpStatusCode.NotFound && Gate.Parse(missingBody).GetProperty("title").GetString() == "数据源不存在或已过期，请重新上传",
            missingBody);
        var (unsafeId, unsafeBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = "x", datasourceId = "../etc/passwd" }), trustedA);
        gate.Check("analysis-create-unsafe-datasource-404", unsafeId.StatusCode == HttpStatusCode.NotFound, unsafeBody);

        // Built-in sample → 202 in Node's shape, executed by the host, snapshot equals the JS report shape.
        var (accepted, acceptedBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = "材料与失败率有什么关系" }), trustedA);
        var acceptedJson = Gate.Parse(acceptedBody);
        gate.Check("analysis-create-202", accepted.StatusCode == HttpStatusCode.Accepted, acceptedBody);
        var id = acceptedJson.GetProperty("id").GetString() ?? string.Empty;
        gate.Check("analysis-create-shape",
            id.Length == 18 && id.StartsWith("t_", StringComparison.Ordinal) &&
            acceptedJson.GetProperty("engine").GetString() == "server-rules" &&
            !acceptedJson.GetProperty("willUseAi").GetBoolean() &&
            IsNullOrAbsent(acceptedJson, "quota") &&
            acceptedJson.GetProperty("links").GetProperty("events").GetString() == $"/api/v1/analysis-tasks/{id}/events",
            acceptedBody);

        var snapshot = await WaitTerminalAsync(gate, origin, id, trustedA);
        gate.Check("analysis-sample-done",
            snapshot.GetProperty("status").GetString() == "done" &&
            snapshot.GetProperty("progress").GetDouble() == 1 &&
            snapshot.GetProperty("phase").GetString() == "done" &&
            snapshot.GetProperty("message").GetString() == "分析完成" &&
            snapshot.GetProperty("lastEventSeq").GetInt64() == 4 &&
            IsNullOrAbsent(snapshot, "error") &&
            snapshot.GetProperty("finishedAtUtc").ValueKind == JsonValueKind.String,
            snapshot.ToString());
        var report = snapshot.GetProperty("report");
        gate.Check("analysis-sample-report-stamps",
            report.GetProperty("engine").GetString() == "server-rules" &&
            report.GetProperty("taskId").GetString() == id &&
            !report.GetProperty("cached").GetBoolean(),
            new { engine = report.GetProperty("engine").GetString(), taskId = report.GetProperty("taskId").GetString() });
        gate.Check("analysis-sample-report-intent",
            report.GetProperty("intent").GetString() == "material_cmp" &&
            report.GetProperty("rowCount").GetInt32() == FarmDataset.Rows.Count &&
            !report.TryGetProperty("highlight", out _),
            new { intent = report.GetProperty("intent").GetString(), rowCount = report.GetProperty("rowCount").GetInt32(), highlight = report.TryGetProperty("highlight", out _) });
        // jsonb re-orders object keys on storage, so compare the provenance semantically, not byte for byte.
        gate.Check("analysis-sample-report-provenance",
            JsonNode.DeepEquals(
                JsonNode.Parse(report.GetProperty("provenance").GetRawText()),
                JsonNode.Parse(JsJson.Stringify(FarmDataset.Provenance))),
            JsJson.Stringify(report.GetProperty("provenance")));

        // Event replay: three progress frames, the Node-shaped terminal message frame, then C#'s own done frame.
        var (events, eventsBody) = await gate.SendAsync(origin, HttpMethod.Get, $"/api/v1/analysis-tasks/{id}/events", null, trustedA);
        var frames = eventsBody.Split("\n\n", StringSplitOptions.RemoveEmptyEntries)
            .Where(static frame => frame.Contains("event:", StringComparison.Ordinal))
            .Select(static frame => (
                Event: frame.Split('\n').First(static line => line.StartsWith("event:", StringComparison.Ordinal))[6..].Trim(),
                Data: Gate.Parse(frame.Split('\n').First(static line => line.StartsWith("data:", StringComparison.Ordinal))[5..].Trim())))
            .ToArray();
        gate.Check("analysis-sample-events",
            events.StatusCode == HttpStatusCode.OK &&
            frames.Select(static frame => frame.Event).SequenceEqual(["progress", "progress", "progress", "message", "done"]) &&
            frames[0].Data.GetProperty("stage").GetString() == "intent" &&
            frames[0].Data.GetProperty("seq").GetInt64() == 1 &&
            frames[3].Data.GetProperty("done").GetBoolean() &&
            frames[3].Data.GetProperty("message").GetString() == "分析完成" &&
            frames[4].Data.GetProperty("status").GetString() == "done",
            string.Join(",", frames.Select(static frame => frame.Event)));

        // Uploaded datasource: same tenant runs, foreign tenant sees 404 (C# isolation, decision A7).
        var (uploaded, uploadedBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/datasources",
            JsonSerializer.Serialize(new { name = "jobs.csv", csv = Csv }), trustedA);
        var datasourceId = Gate.Parse(uploadedBody).GetProperty("datasourceId").GetString()!;
        gate.Check("analysis-upload-201", uploaded.StatusCode == HttpStatusCode.Created, uploadedBody);
        var (ownTask, ownTaskBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = "哪台机器的失败率最高？", datasourceId }), trustedA);
        gate.Check("analysis-upload-create-202", ownTask.StatusCode == HttpStatusCode.Accepted, ownTaskBody);
        var ownSnapshot = await WaitTerminalAsync(gate, origin, Gate.Parse(ownTaskBody).GetProperty("id").GetString()!, trustedA);
        var ownReport = ownSnapshot.GetProperty("report");
        gate.Check("analysis-upload-report",
            ownSnapshot.GetProperty("status").GetString() == "done" &&
            ownReport.GetProperty("intent").GetString() == "machine_fault" &&
            ownReport.GetProperty("rowCount").GetInt32() == 3 &&
            ownReport.TryGetProperty("highlight", out _) &&
            ownReport.GetProperty("provenance").GetProperty("source").GetString() == "user-upload",
            ownSnapshot.ToString().Length > 400 ? ownSnapshot.ToString()[..400] : ownSnapshot.ToString());
        var (foreign, foreignBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = "x", datasourceId }), Gate.Trusted(tenantB, ownerB));
        gate.Check("analysis-foreign-datasource-404", foreign.StatusCode == HttpStatusCode.NotFound, foreignBody);
        var (foreignRead, foreignReadBody) = await gate.SendAsync(origin, HttpMethod.Get, $"/api/v1/analysis-tasks/{id}", null, Gate.Trusted(tenantB, ownerB));
        gate.Check("analysis-foreign-task-404", foreignRead.StatusCode == HttpStatusCode.NotFound, foreignReadBody);

        // Recovery (Node ready()): a running row nobody updated for longer than StaleRunningMs is failed on the owner's next create.
        var staleId = "t_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
        var staleAt = DateTimeOffset.UtcNow.AddMinutes(-10);
        await tasks.UpsertAsync(new AnalysisTaskRecord(
            staleId, tenantA, ownerA, "stale", "sample", "server-rules", "server-rules", tenantA,
            "running", 0.2, "intent", "解析问题意图", null, null, null,
            "[{\"seq\":1,\"ts\":1,\"stage\":\"intent\",\"message\":\"解析问题意图\",\"progress\":0.2}]",
            staleAt, null, staleAt.AddHours(1), staleAt), ct);
        var (afterStale, afterStaleBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = "x" }), trustedA);
        gate.Check("analysis-create-after-stale-202", afterStale.StatusCode == HttpStatusCode.Accepted, afterStaleBody);
        await WaitTerminalAsync(gate, origin, Gate.Parse(afterStaleBody).GetProperty("id").GetString()!, trustedA);
        var (recovered, recoveredBody) = await gate.SendAsync(origin, HttpMethod.Get, $"/api/v1/analysis-tasks/{staleId}", null, trustedA);
        var recoveredJson = Gate.Parse(recoveredBody);
        gate.Check("analysis-stale-running-recovered",
            recovered.StatusCode == HttpStatusCode.OK &&
            recoveredJson.GetProperty("status").GetString() == "failed" &&
            recoveredJson.GetProperty("error").GetString() == PostgresAnalysisTaskRepository.InterruptedMessage &&
            recoveredJson.GetProperty("phase").GetString() == "recovered" &&
            recoveredJson.GetProperty("progress").GetDouble() == 1,
            recoveredBody);

        // A fresh running row (updated just now) must survive the same create.
        var freshId = "t_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
        var freshAt = DateTimeOffset.UtcNow;
        await tasks.UpsertAsync(new AnalysisTaskRecord(
            freshId, tenantA, ownerA, "fresh", "sample", "server-rules", "server-rules", tenantA,
            "running", 0.2, "intent", "解析问题意图", null, null, null, "[]",
            freshAt, null, freshAt.AddHours(1), freshAt), ct);
        var (afterFresh, afterFreshBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = "x" }), trustedA);
        await WaitTerminalAsync(gate, origin, Gate.Parse(afterFreshBody).GetProperty("id").GetString()!, trustedA);
        var fresh = await tasks.GetAsync(tenantA, ownerA, freshId, ct);
        gate.Check("analysis-fresh-running-kept", afterFresh.StatusCode == HttpStatusCode.Accepted && fresh is { Status: "running" }, fresh?.Status);

        await app.StopAsync();
        await tasks.DisposeAsync();
        await datasources.DisposeAsync();
    }

    private static async Task<JsonElement> WaitTerminalAsync(Gate gate, string origin, string id, (string Name, string Value)[] headers)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(15);
        JsonElement last = default;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var (response, body) = await gate.SendAsync(origin, HttpMethod.Get, $"/api/v1/analysis-tasks/{id}", null, headers);
            if (response.StatusCode != HttpStatusCode.OK)
            {
                throw new InvalidOperationException($"snapshot {id} → {(int)response.StatusCode}: {body}");
            }
            last = Gate.Parse(body);
            if (last.GetProperty("status").GetString() is "done" or "failed") return last;
            await Task.Delay(50);
        }
        throw new TimeoutException($"analysis task {id} did not reach a terminal state: {last}");
    }

    /// <summary>The gate host serializes with WhenWritingNull, so a null field may be absent rather than null.</summary>
    private static bool IsNullOrAbsent(JsonElement element, string property) =>
        !element.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null;

    private static string RandomTenant() => "tn_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
}
