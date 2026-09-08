using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using ForgeX.Analytics;
using ForgeX.Application;
using ForgeX.Infrastructure;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.6c-2b — the in-process host that executes analysis tasks created through
/// <c>POST /api/v1/analysis-tasks</c>. It mirrors Node's TaskStore step by step: the same progress
/// events the local rules provider and the OpenAI-compatible provider emit, one full-snapshot upsert
/// per event, the same terminal event shapes (<c>_finish</c> / <c>_fail</c>), the same cache-hit,
/// quota-degrade and queue behaviour, and a report that is the JS report — engine id, the
/// datasource's provenance attached verbatim, <c>taskId</c> / <c>cached</c> stamped on. Anything
/// Node's SSE re-framing or share page consumes therefore looks exactly like it did when Node ran the task.
/// </summary>
internal sealed record AnalysisTaskOptions(long TtlMs, int Concurrency, int QueueCapacity, long StaleRunningMs)
{
    public const long DefaultTtlMs = 60 * 60 * 1000;
    public const int DefaultConcurrency = 2;
    public const int DefaultQueueCapacity = 256;
    public const long DefaultStaleRunningMs = 60 * 1000;
}

/// <summary>
/// Everything the worker needs, captured at creation time so ownership was checked once. The AI
/// endpoint (if any) rides only here — never in the persisted record, never in a log line.
/// </summary>
internal sealed record AnalysisTaskWorkItem(
    AnalysisTaskRecord Record,
    JsonElement Rows,
    JsonElement Provenance,
    string DatasourceKey,
    AiEndpoint? Ai,
    string ProviderId,
    string CacheVariant);

internal sealed class AnalysisTaskQueue
{
    private readonly Channel<AnalysisTaskWorkItem> _channel;

    public AnalysisTaskQueue(int capacity)
    {
        if (capacity is < 1 or > 4096) throw new ArgumentOutOfRangeException(nameof(capacity));
        _channel = Channel.CreateBounded<AnalysisTaskWorkItem>(new BoundedChannelOptions(capacity)
        {
            SingleReader = false,
            SingleWriter = false,
            // Rules-engine tasks are cheap and Node never rejected one: a full queue back-pressures the
            // create request instead of answering 503. AI admission is the cost gate's job, not the queue's.
            FullMode = BoundedChannelFullMode.Wait,
        });
    }

    public ValueTask EnqueueAsync(AnalysisTaskWorkItem item, CancellationToken cancellationToken) =>
        _channel.Writer.WriteAsync(item, cancellationToken);

    public IAsyncEnumerable<AnalysisTaskWorkItem> ReadAllAsync(CancellationToken cancellationToken) =>
        _channel.Reader.ReadAllAsync(cancellationToken);
}

/// <summary>Ids this process is executing right now — never recovered as "interrupted" from under the worker.</summary>
internal sealed class AnalysisTaskRuntime
{
    private readonly ConcurrentDictionary<string, byte> _live = new(StringComparer.Ordinal);

    public IReadOnlyCollection<string> LiveIds => _live.Keys.ToArray();

    public void Register(string id) => _live.TryAdd(id, 0);

    public void Unregister(string id) => _live.TryRemove(id, out _);
}

internal sealed class AnalysisTaskWorker(
    AnalysisTaskQueue queue,
    AnalysisTaskRuntime runtime,
    AnalysisTaskOptions options,
    AnalysisTaskExecutor executor,
    AnalysisProviderSelection providers,
    OpenAiNarrativeClient openAi,
    ILogger<AnalysisTaskWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Node probes the configured AI endpoint at start-up and demotes to the rules engine when it is dead.
        await providers.ProbeAsync(openAi, stoppingToken);
        var consumers = new Task[Math.Max(1, options.Concurrency)];
        for (var index = 0; index < consumers.Length; index++)
        {
            consumers[index] = ConsumeAsync(stoppingToken);
        }
        await Task.WhenAll(consumers);
    }

    private async Task ConsumeAsync(CancellationToken stoppingToken)
    {
        await foreach (var item in queue.ReadAllAsync(stoppingToken))
        {
            runtime.Register(item.Record.Id);
            try
            {
                await executor.RunAsync(item, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Shutdown mid-task: the row stays "running" and the owner's next create recovers it
                // with Node's "服务重启时任务中断" once it is stale.
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "Analysis task {TaskId} could not even record its failure", item.Record.Id);
            }
            finally
            {
                runtime.Unregister(item.Record.Id);
            }
        }
    }
}

/// <summary>Node TaskStore._run / _runProvider / _degrade with both providers, on top of the persisted snapshot.</summary>
internal sealed class AnalysisTaskExecutor(
    PostgresAnalysisTaskRepository repository,
    AnalysisCostGate gate,
    AnalysisResultCache cache,
    AnalysisAiOptions aiOptions,
    AnalysisGateOptions gateOptions,
    OpenAiNarrativeClient openAi,
    AnalysisTaskMetrics metrics,
    IServiceProvider services,
    ILogger<AnalysisTaskExecutor> logger)
{
    public const string RulesEngine = AnalysisProviderSelection.RulesId;
    public const string OpenAiEngine = AnalysisProviderSelection.OpenAiId;

    /// <summary>Node providers.js localProvider steps — identical stage / message / progress triples.</summary>
    private static readonly (string Stage, string Message, double Progress)[] RulesSteps =
    [
        ("intent", "解析问题意图", 0.2),
        ("aggregate", "聚合与统计检验", 0.6),
        ("generate", "生成结论与建议", 0.9),
    ];

    public async Task RunAsync(AnalysisTaskWorkItem item, CancellationToken cancellationToken)
    {
        var task = new TaskState(item.Record, repository);
        var started = DateTimeOffset.UtcNow;
        try
        {
            var cacheKey = AnalysisResultCache.Key(
                item.Record.Question,
                item.DatasourceKey,
                item.CacheVariant.Length > 0 ? item.ProviderId + ":" + item.CacheVariant : item.ProviderId,
                item.Record.CredentialScope);
            var cached = cache.Get(cacheKey);
            if (cached is not null)
            {
                // A cache hit is still reported honestly — the user is entitled to know the result was not just computed.
                await task.EmitAsync("cache", "命中缓存，未重复调用分析引擎", 1, cancellationToken);
                var hit = (JsonObject)JsonNode.Parse(cached)!;
                hit["taskId"] = item.Record.Id;
                hit["cached"] = true;
                metrics.RecordCached();
                await task.FinishAsync(hit.ToJsonString(), cancellationToken);
                return;
            }

            var report = await RunProviderAsync(item, task, cancellationToken);
            report["taskId"] = item.Record.Id;
            report["cached"] = false;
            var json = report.ToJsonString();
            cache.Set(cacheKey, json);
            await task.FinishAsync(json, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            var error = string.IsNullOrWhiteSpace(exception.Message) ? "分析失败" : exception.Message;
            logger.LogError("task failed taskId={TaskId} engine={Engine} error={Error}", item.Record.Id, item.ProviderId,
                OpenAiNarrativeClient.MaskSecret(error, item.Ai?.ApiKey));
            metrics.RecordFailed();
            await task.FailAsync(OpenAiNarrativeClient.MaskSecret(error, item.Ai?.ApiKey), CancellationToken.None);
        }
        finally
        {
            metrics.RecordDuration((long)(DateTimeOffset.UtcNow - started).TotalMilliseconds);
        }
    }

    /// <summary>Node _runProvider: the AI path passes the cost gate first; exhausted budget or a full queue degrades, never errors.</summary>
    private async Task<JsonObject> RunProviderAsync(AnalysisTaskWorkItem item, TaskState task, CancellationToken cancellationToken)
    {
        if (item.Ai is null)
        {
            return await RulesAsync(item, task, cancellationToken);
        }

        var verdict = gate.Check(item.Record.OwnerId);
        if (!verdict.Ok)
        {
            logger.LogInformation("quota exhausted, degrading to rules engine taskId={TaskId} code={Code}", item.Record.Id, verdict.Code);
            await task.EmitAsync("quota", "AI 额度已用尽，降级为规则引擎", 0.1, cancellationToken);
            return await DegradeAsync(item, task, verdict.Reason ?? string.Empty, cancellationToken);
        }

        Task<Action> slot;
        try
        {
            var admission = gate.Acquire();
            slot = admission.Slot;
            if (admission.QueuedPosition is { } position)
            {
                await task.EmitAsync("queued",
                    "排队中：前面还有 " + (position - 1) + " 个任务（并发上限 " + gateOptions.AiConcurrency + "）",
                    0.03, cancellationToken);
            }
        }
        catch (AnalysisQueueFullException exception)
        {
            // The queue is full too: degrade rather than fail — the user wants a conclusion, not a 503.
            logger.LogWarning("ai queue full, degrading taskId={TaskId}", item.Record.Id);
            return await DegradeAsync(item, task, exception.Message, cancellationToken);
        }

        var release = await slot;
        try
        {
            gate.Consume(item.Record.OwnerId);
            return await OpenAiAsync(item, task, cancellationToken);
        }
        finally
        {
            release();
        }
    }

    private async Task<JsonObject> RulesAsync(AnalysisTaskWorkItem item, TaskState task, CancellationToken cancellationToken)
    {
        foreach (var (stage, message, progress) in RulesSteps)
        {
            await task.EmitAsync(stage, message, progress, cancellationToken);
        }
        return LocalReport(item, RulesEngine);
    }

    /// <summary>Node providers.js openaiProvider.analyze: local stats → brief → chat/completions → merge, numbers always local.</summary>
    private async Task<JsonObject> OpenAiAsync(AnalysisTaskWorkItem item, TaskState task, CancellationToken cancellationToken)
    {
        var endpoint = item.Ai!;
        await task.EmitAsync("stats", "本地统计核计算中（置信区间与显著性检验）", 0.2, cancellationToken);
        var local = LocalReport(item, OpenAiEngine);
        var brief = AnalyticsBriefEngine.Build(RawRows(item.Rows));
        var knowledge = await KnowledgeAsync(item, cancellationToken);

        await task.EmitAsync("submit", "请求 " + endpoint.Model, 0.4, cancellationToken);
        var completion = await openAi.CompleteAsync(endpoint, item.Record.Question, brief.Text, knowledge, aiOptions.TimeoutMs, cancellationToken);
        var text = completion?["choices"] is JsonArray choices && choices.Count > 0 && choices[0] is JsonObject first
            ? first["message"]?["content"]?.GetValue<string>()
            : null;

        await task.EmitAsync("merge", "合并 AI 叙述与本地统计产物", 0.9, cancellationToken);
        var narrative = AnalysisReportMerge.ExtractJson(text);
        if (narrative is null)
        {
            logger.LogWarning("provider narrative not parseable, falling back to local narrative provider={Provider}", OpenAiEngine);
        }
        var merged = AnalysisReportMerge.MergeWithLocal(narrative, local, OpenAiEngine, endpoint.Model);
        if (completion?["usage"] is JsonNode usage) merged["tokenUsage"] = usage.DeepClone();
        return merged;
    }

    private async Task<JsonObject> DegradeAsync(AnalysisTaskWorkItem item, TaskState task, string reason, CancellationToken cancellationToken)
    {
        // Node _degrade: the rules provider runs with its own progress events and no knowledge injection.
        metrics.RecordDegraded();
        var rules = await RulesAsync(item, task, cancellationToken);
        return AnalysisReportMerge.Degrade(rules, item.ProviderId, reason);
    }

    /// <summary>Node knowledgeFor: BM25 top-4 chunks of the owner's knowledge documents; nothing when there are none.</summary>
    private async Task<IReadOnlyList<RetrievalHit>> KnowledgeAsync(AnalysisTaskWorkItem item, CancellationToken cancellationToken)
    {
        var knowledge = services.GetService<IKnowledgeRepository>();
        if (knowledge is null) return [];
        var documents = await knowledge.ListAsync(item.Record.TenantId, item.Record.OwnerId, cancellationToken);
        if (documents.Count == 0) return [];
        var hits = Bm25Retrieval.Retrieve(
            documents.Select(static doc => new RetrievalDocument(doc.Id, doc.Name, doc.Text)).ToList(),
            item.Record.Question,
            topK: 4);
        if (hits.Count > 0)
        {
            logger.LogInformation("knowledge retrieved hits={Hits} top={Top} score={Score}", hits.Count, hits[0].Name, hits[0].Score);
        }
        return hits;
    }

    /// <summary>
    /// The JS report shape: the analytics engine's report serialized with the analytics wire options,
    /// then engine → provider id, provenance → the datasource's own object (verbatim, as the JS
    /// engine copies it), and the empty highlight slot dropped for the three intents whose JS code never writes it.
    /// </summary>
    private static JsonObject LocalReport(AnalysisTaskWorkItem item, string engine)
    {
        var report = AnalyticsReportEngine.AnalyzeMigratedIntent(item.Record.Question, AnalysisTaskRows.Map(item.Rows), provenance: null);
        var node = JsonNode.Parse(JsonSerializer.Serialize(report, AnalyticsEndpoints.ResponseJsonOptions))!.AsObject();
        if (node["highlight"] is null && node["intent"]?.GetValue<string>() is "material_cmp" or "corr_layer" or "cost_trend")
        {
            node.Remove("highlight");
        }
        node["engine"] = engine;
        node["provenance"] = item.Provenance.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null
            ? null
            : JsonNode.Parse(item.Provenance.GetRawText());
        return node;
    }

    private static IReadOnlyList<RawRow> RawRows(JsonElement rows)
    {
        if (rows.ValueKind != JsonValueKind.Array) return [];
        var mapped = new List<RawRow>(rows.GetArrayLength());
        foreach (var row in rows.EnumerateArray())
        {
            try
            {
                mapped.Add(RawRow.FromJson(row));
            }
            catch (FormatException)
            {
                // Node's brief builder ignores what it cannot read; keep the same tolerance.
            }
        }
        return mapped;
    }

    /// <summary>One task's mutable event log + the snapshot writer (Node emit / _persist / _finish / _fail).</summary>
    private sealed class TaskState(AnalysisTaskRecord initial, PostgresAnalysisTaskRepository repository)
    {
        private readonly JsonArray _events = new();
        private AnalysisTaskRecord _record = initial;

        public async Task EmitAsync(string stage, string message, double progress, CancellationToken cancellationToken)
        {
            _events.Add(new JsonObject
            {
                ["seq"] = _events.Count + 1,
                ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["stage"] = stage,
                ["message"] = message,
                ["progress"] = progress,
            });
            _record = Snapshot(_record, "running", _events, report: null, error: null);
            await repository.UpsertAsync(_record, cancellationToken);
        }

        public async Task FinishAsync(string reportJson, CancellationToken cancellationToken)
        {
            _events.Add(new JsonObject
            {
                ["seq"] = _events.Count + 1,
                ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["done"] = true,
                ["progress"] = 1,
                ["message"] = "分析完成",
            });
            _record = Snapshot(_record, "done", _events, reportJson, error: null);
            await repository.UpsertAsync(_record, CancellationToken.None);
        }

        public async Task FailAsync(string error, CancellationToken cancellationToken)
        {
            _events.Add(new JsonObject
            {
                ["seq"] = _events.Count + 1,
                ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["done"] = true,
                ["error"] = error,
                ["message"] = "分析失败：" + error,
            });
            _record = Snapshot(_record, "failed", _events, report: null, error);
            await repository.UpsertAsync(_record, cancellationToken);
        }

        /// <summary>Node PostgresAnalysisStore._snapshot: progress / phase / message are derived from the last event.</summary>
        private static AnalysisTaskRecord Snapshot(AnalysisTaskRecord record, string status, JsonArray events, string? report, string? error)
        {
            var last = events.Count > 0 ? events[events.Count - 1] as JsonObject : null;
            var progress = Number(last?["progress"]) ?? (status == "done" ? 1 : 0);
            var stage = last?["stage"]?.GetValue<string>();
            // Node quirk kept on purpose: a failed task's terminal event has no stage, and the fallback
            // only knows "done" or "running" — so failed rows carry phase "running".
            var phase = stage ?? (status == "done" ? "done" : "running");
            var message = last?["message"]?.GetValue<string>() ?? string.Empty;
            var now = DateTimeOffset.UtcNow;
            return record with
            {
                Status = status,
                Progress = Math.Clamp(progress, 0, 1),
                Phase = phase.Length > 64 ? phase[..64] : phase,
                Message = message,
                ReportJson = report,
                ErrorMessage = error,
                EventsJson = events.ToJsonString(),
                FinishedAt = status is "done" or "failed" ? now : null,
                UpdatedAt = now,
            };
        }

        /// <summary>JsonValue keeps the CLR type it was created with (1 is an Int32, 0.2 a Double); read either as a double.</summary>
        private static double? Number(JsonNode? node)
        {
            if (node is not JsonValue value) return null;
            if (value.TryGetValue<double>(out var asDouble)) return asDouble;
            if (value.TryGetValue<int>(out var asInt)) return asInt;
            if (value.TryGetValue<long>(out var asLong)) return asLong;
            return null;
        }
    }
}

/// <summary>Node providers.js authorityRow: tolerant mapping of stored datasource rows onto the analytics row model.</summary>
internal static class AnalysisTaskRows
{
    public static IReadOnlyList<AnalyticsRow> Map(JsonElement rows)
    {
        if (rows.ValueKind != JsonValueKind.Array) return [];
        var mapped = new List<AnalyticsRow>(rows.GetArrayLength());
        foreach (var row in rows.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Object) continue;
            mapped.Add(new AnalyticsRow(
                Text(row, "job_id", "jobId"),
                Text(row, "date"),
                Text(row, "machine_id", "machineId"),
                Text(row, "model_name", "modelName"),
                Text(row, "material"),
                Number(row, "layer_height_mm", "layerHeightMm"),
                Number(row, "duration_min", "durationMin"),
                Number(row, "filament_g", "filamentG"),
                Number(row, "cost_fen", "costFen"),
                Text(row, "status") == "fail" ? AnalyticsStatus.Fail : AnalyticsStatus.Success,
                Text(row, "fail_reason", "failReason"),
                Number(row, "energy_kwh", "energyKwh")));
        }
        return mapped;
    }

    private static string? Text(JsonElement row, string name, string? alias = null)
    {
        if (row.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String) return value.GetString();
        if (alias is not null && row.TryGetProperty(alias, out var aliased) && aliased.ValueKind == JsonValueKind.String) return aliased.GetString();
        return null;
    }

    private static double Number(JsonElement row, string name, string alias)
    {
        if (row.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number)) return number;
        if (row.TryGetProperty(alias, out var aliased) && aliased.ValueKind == JsonValueKind.Number && aliased.TryGetDouble(out var aliasNumber) && double.IsFinite(aliasNumber)) return aliasNumber;
        return 0;
    }
}
