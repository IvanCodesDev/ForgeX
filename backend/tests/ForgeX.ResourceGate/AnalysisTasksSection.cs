using System.Net;
using System.Security.Cryptography;
using System.Text;
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
        using var fakeAi = new FakeOpenAi();
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
                // 8.6c-2b-ii: process provider = rules, AI only through the caller's endpoint; 2 AI tasks per caller per day.
                builder.Services.AddSingleton(new AnalysisAiOptions("rules", AnalysisAiOptions.DefaultBaseUrl, string.Empty, string.Empty, 10_000, Probe: false));
                builder.Services.AddSingleton(new AnalysisGateOptions(AiConcurrency: 2, AiQueueMax: 8, DailyPerCaller: 2, DailyGlobal: 0));
                builder.Services.AddSingleton(new AnalysisCacheOptions(TtlMs: 60_000, Max: 50));
                builder.Services.AddSingleton<AnalysisProviderSelection>();
                builder.Services.AddSingleton<AnalysisCostGate>();
                builder.Services.AddSingleton<AnalysisResultCache>();
                builder.Services.AddSingleton<OpenAiNarrativeClient>();
                builder.Services.AddSingleton<AnalysisTaskExecutor>();
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

        // ── AI leg (8.6c-2b-ii): caller-supplied endpoint → C# provider, cost gate, cache ──
        // Deliberately not sk-prefixed: the repo's secret-pattern-scan treats any sk-… as a live key.
        const string aiKey = "gate-fake-key-0123456789";
        var aiTenant = RandomTenant();
        var aiOwner = "ow_" + aiTenant[3..];
        var trustedAi = Gate.Trusted(aiTenant, aiOwner);
        object AiBody(string question) => new { question, datasourceId = "sample", ai = new { baseUrl = fakeAi.BaseUrl, apiKey = aiKey, model = "gate-fake-model" } };

        var (badScheme, badSchemeBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = "x", ai = new { baseUrl = "ftp://ai.example", model = "m" } }), trustedAi);
        gate.Check("analysis-ai-override-scheme-400",
            badScheme.StatusCode == HttpStatusCode.BadRequest && Gate.Parse(badSchemeBody).GetProperty("title").GetString() == "aiBaseUrl 只允许 http(s)",
            badSchemeBody);
        var (noModel, noModelBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(new { question = "x", ai = new { baseUrl = fakeAi.BaseUrl } }), trustedAi);
        gate.Check("analysis-ai-override-incomplete-400",
            noModel.StatusCode == HttpStatusCode.BadRequest &&
            Gate.Parse(noModelBody).GetProperty("title").GetString() == "自带 AI 端点需要同时提供 aiBaseUrl 与 aiModel（aiApiKey 按端点要求可选）",
            noModelBody);

        var (aiAccepted, aiAcceptedBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(AiBody("哪台机器的失败率最高？")), trustedAi);
        var aiAcceptedJson = Gate.Parse(aiAcceptedBody);
        gate.Check("analysis-ai-create-202",
            aiAccepted.StatusCode == HttpStatusCode.Accepted &&
            aiAcceptedJson.GetProperty("engine").GetString() == "openai-compatible" &&
            aiAcceptedJson.GetProperty("willUseAi").GetBoolean() &&
            aiAcceptedJson.GetProperty("quota").GetProperty("ok").GetBoolean() &&
            aiAcceptedJson.GetProperty("quota").GetProperty("remaining").GetInt64() == 2,
            aiAcceptedBody);
        var aiId = aiAcceptedJson.GetProperty("id").GetString()!;
        var aiSnapshot = await WaitTerminalAsync(gate, origin, aiId, trustedAi);
        var aiReport = aiSnapshot.GetProperty("report");
        gate.Check("analysis-ai-report-merged",
            aiSnapshot.GetProperty("status").GetString() == "done" &&
            aiReport.GetProperty("engine").GetString() == "openai-compatible" &&
            aiReport.GetProperty("narrativeBy").GetString() == "gate-fake-model" &&
            aiReport.GetProperty("model").GetString() == "gate-fake-model" &&
            aiReport.GetProperty("statsBy").GetString() == "local-stats-kernel" &&
            aiReport.GetProperty("title").GetString() == FakeOpenAi.Title &&
            aiReport.GetProperty("tokenUsage").GetProperty("total_tokens").GetInt32() == 366 &&
            !aiReport.GetProperty("cached").GetBoolean(),
            aiSnapshot.ToString().Length > 400 ? aiSnapshot.ToString()[..400] : aiSnapshot.ToString());
        var (aiEvents, aiEventsBody) = await gate.SendAsync(origin, HttpMethod.Get, $"/api/v1/analysis-tasks/{aiId}/events", null, trustedAi);
        var aiStages = aiEventsBody.Split("\n\n", StringSplitOptions.RemoveEmptyEntries)
            .Where(static frame => frame.Contains("event: progress", StringComparison.Ordinal))
            .Select(static frame => Gate.Parse(frame.Split('\n').First(static line => line.StartsWith("data:", StringComparison.Ordinal))[5..].Trim()).GetProperty("stage").GetString())
            .ToArray();
        gate.Check("analysis-ai-events", aiEvents.StatusCode == HttpStatusCode.OK && aiStages.SequenceEqual(["stats", "submit", "merge"]), string.Join(",", aiStages));
        gate.Check("analysis-ai-endpoint-called-with-bearer",
            fakeAi.Requests.Count == 1 && fakeAi.Requests[0].Authorization == "Bearer " + aiKey &&
            fakeAi.Requests[0].Body.Contains("\"response_format\":{\"type\":\"json_object\"}", StringComparison.Ordinal) &&
            fakeAi.Requests[0].Body.Contains("# 统计简报（已核验，勿重算）", StringComparison.Ordinal),
            fakeAi.Requests.Count);
        gate.Check("analysis-ai-key-never-persisted",
            !aiSnapshot.ToString().Contains(aiKey, StringComparison.Ordinal) &&
            !(await tasks.GetAsync(aiTenant, aiOwner, aiId, ct))!.EventsJson.Contains(aiKey, StringComparison.Ordinal),
            aiId);

        // Same question again: cache hit, no second upstream call, quota untouched.
        var (cachedAccepted, cachedAcceptedBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(AiBody("哪台机器的失败率最高？")), trustedAi);
        var cachedSnapshot = await WaitTerminalAsync(gate, origin, Gate.Parse(cachedAcceptedBody).GetProperty("id").GetString()!, trustedAi);
        gate.Check("analysis-ai-cache-hit",
            cachedAccepted.StatusCode == HttpStatusCode.Accepted &&
            Gate.Parse(cachedAcceptedBody).GetProperty("quota").GetProperty("remaining").GetInt64() == 1 &&
            cachedSnapshot.GetProperty("report").GetProperty("cached").GetBoolean() &&
            cachedSnapshot.GetProperty("report").GetProperty("title").GetString() == FakeOpenAi.Title &&
            cachedSnapshot.GetProperty("lastEventSeq").GetInt64() == 2 &&
            fakeAi.Requests.Count == 1,
            cachedAcceptedBody);

        // Second distinct question consumes the last unit; the third degrades to the rules engine with the reason on record.
        var (secondAccepted, secondBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(AiBody("材料与失败率有什么关系")), trustedAi);
        await WaitTerminalAsync(gate, origin, Gate.Parse(secondBody).GetProperty("id").GetString()!, trustedAi);
        var (degradedAccepted, degradedBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/analysis-tasks",
            JsonSerializer.Serialize(AiBody("成本随时间怎么变化")), trustedAi);
        var degradedJson = Gate.Parse(degradedBody);
        var degradedSnapshot = await WaitTerminalAsync(gate, origin, degradedJson.GetProperty("id").GetString()!, trustedAi);
        var degradedReport = degradedSnapshot.GetProperty("report");
        gate.Check("analysis-ai-quota-degraded",
            secondAccepted.StatusCode == HttpStatusCode.Accepted && degradedAccepted.StatusCode == HttpStatusCode.Accepted &&
            !degradedJson.GetProperty("willUseAi").GetBoolean() &&
            !degradedJson.GetProperty("quota").GetProperty("ok").GetBoolean() &&
            degradedJson.GetProperty("quota").GetProperty("reason").GetString()!.StartsWith("你今日的 AI 分析额度已用尽（2 次/日）", StringComparison.Ordinal) &&
            degradedReport.GetProperty("engine").GetString() == "server-rules" &&
            degradedReport.GetProperty("degradedFrom").GetString() == "openai-compatible" &&
            degradedReport.GetProperty("sections").EnumerateArray().Any(static section => section.GetProperty("h").GetString() == "为什么这份报告没有 AI 叙述") &&
            fakeAi.Requests.Count == 2,
            degradedBody);

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

    /// <summary>
    /// Minimal OpenAI-compatible endpoint: /v1/models for the probe, /v1/chat/completions with a fixed
    /// fenced JSON narrative (the same shape the dual-run's fake returns) and a fixed usage block.
    /// </summary>
    private sealed class FakeOpenAi : IDisposable
    {
        public const string Title = "AI 叙述：失败率结论";

        private readonly HttpListener _listener = new();
        private readonly CancellationTokenSource _stop = new();

        public FakeOpenAi()
        {
            var port = FreePort();
            BaseUrl = $"http://127.0.0.1:{port}/v1";
            _listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            _listener.Start();
            _ = Task.Run(ServeAsync);
        }

        public string BaseUrl { get; }

        public List<(string Path, string? Authorization, string Body)> Requests { get; } = [];

        private async Task ServeAsync()
        {
            while (!_stop.IsCancellationRequested)
            {
                HttpListenerContext context;
                try
                {
                    context = await _listener.GetContextAsync();
                }
                catch (Exception) when (_stop.IsCancellationRequested)
                {
                    return;
                }
                using var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8);
                var body = await reader.ReadToEndAsync();
                var path = context.Request.Url?.AbsolutePath ?? string.Empty;
                string response;
                if (path == "/v1/models")
                {
                    response = "{\"object\":\"list\",\"data\":[{\"id\":\"gate-fake-model\"}]}";
                }
                else if (path == "/v1/chat/completions")
                {
                    lock (Requests) Requests.Add((path, context.Request.Headers["Authorization"], body));
                    var narrative = JsonSerializer.Serialize(new
                    {
                        title = Title,
                        verdict = "AI 叙述：按简报，失败率差异及其 95% 置信区间见下文；数字均来自本地统计核。",
                        sections = new[] { new { h = "AI 小节", lines = new[] { "第一条要点（来自简报）", "第二条要点（来自简报）" } } },
                    });
                    response = JsonSerializer.Serialize(new
                    {
                        id = "chatcmpl-gate",
                        choices = new[] { new { index = 0, message = new { role = "assistant", content = "```json\n" + narrative + "\n```" }, finish_reason = "stop" } },
                        usage = new { prompt_tokens = 321, completion_tokens = 45, total_tokens = 366 },
                    });
                }
                else
                {
                    context.Response.StatusCode = 404;
                    response = "{\"error\":\"unexpected\"}";
                }
                var bytes = Encoding.UTF8.GetBytes(response);
                context.Response.ContentType = "application/json";
                context.Response.ContentLength64 = bytes.Length;
                await context.Response.OutputStream.WriteAsync(bytes);
                context.Response.Close();
            }
        }

        private static int FreePort()
        {
            using var socket = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            socket.Start();
            return ((IPEndPoint)socket.LocalEndpoint).Port;
        }

        public void Dispose()
        {
            _stop.Cancel();
            _listener.Stop();
            _listener.Close();
        }
    }
}
