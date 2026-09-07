using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using ForgeX.Analytics;
using ForgeX.Infrastructure;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.6c-2b (rules-engine leg) — the in-process host that executes analysis tasks created
/// through <c>POST /api/v1/analysis-tasks</c>. It mirrors Node's TaskStore step by step: the same
/// three progress events the local rules provider emits, one full-snapshot upsert per event, the
/// same terminal event shapes (<c>_finish</c> / <c>_fail</c>), and a report that is the JS report —
/// engine <c>server-rules</c>, the datasource's provenance attached verbatim, <c>taskId</c> /
/// <c>cached</c> stamped on. Anything Node's SSE re-framing or share page consumes therefore looks
/// exactly like it did when Node executed the task.
/// </summary>
internal sealed record AnalysisTaskOptions(long TtlMs, int Concurrency, int QueueCapacity, long StaleRunningMs)
{
    public const long DefaultTtlMs = 60 * 60 * 1000;
    public const int DefaultConcurrency = 2;
    public const int DefaultQueueCapacity = 256;
    public const long DefaultStaleRunningMs = 60 * 1000;
}

internal sealed record AnalysisTaskWorkItem(AnalysisTaskRecord Record, JsonElement Rows, JsonElement Provenance);

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
            // create request instead of answering 503.
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
    PostgresAnalysisTaskRepository repository,
    AnalysisTaskRuntime runtime,
    AnalysisTaskOptions options,
    ILogger<AnalysisTaskWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
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
                await AnalysisTaskExecutor.RunAsync(item, repository, stoppingToken);
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

internal static class AnalysisTaskExecutor
{
    public const string Engine = "server-rules";

    /// <summary>Node providers.js localProvider steps — identical stage / message / progress triples.</summary>
    private static readonly (string Stage, string Message, double Progress)[] Steps =
    [
        ("intent", "解析问题意图", 0.2),
        ("aggregate", "聚合与统计检验", 0.6),
        ("generate", "生成结论与建议", 0.9),
    ];

    public static async Task RunAsync(AnalysisTaskWorkItem item, PostgresAnalysisTaskRepository repository, CancellationToken cancellationToken)
    {
        var record = item.Record;
        var events = new JsonArray();
        try
        {
            foreach (var (stage, message, progress) in Steps)
            {
                events.Add(Event(events.Count + 1, stage, message, progress));
                record = Snapshot(record, "running", events, report: null, error: null);
                await repository.UpsertAsync(record, cancellationToken);
            }

            var rows = AnalysisTaskRows.Map(item.Rows);
            var report = AnalyticsReportEngine.AnalyzeMigratedIntent(record.Question, rows, provenance: null);
            var reportJson = ReportJson(report, item.Provenance, record.Id);

            var done = new JsonObject
            {
                ["seq"] = events.Count + 1,
                ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["done"] = true,
                ["progress"] = 1,
                ["message"] = "分析完成",
            };
            events.Add(done);
            record = Snapshot(record, "done", events, reportJson, error: null);
            await repository.UpsertAsync(record, CancellationToken.None);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            var error = string.IsNullOrWhiteSpace(exception.Message) ? "分析失败" : exception.Message;
            var failed = new JsonObject
            {
                ["seq"] = events.Count + 1,
                ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["done"] = true,
                ["error"] = error,
                ["message"] = "分析失败：" + error,
            };
            events.Add(failed);
            record = Snapshot(record, "failed", events, report: null, error);
            await repository.UpsertAsync(record, CancellationToken.None);
        }
    }

    private static JsonObject Event(int seq, string stage, string message, double progress) => new()
    {
        ["seq"] = seq,
        ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        ["stage"] = stage,
        ["message"] = message,
        ["progress"] = progress,
    };

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

    /// <summary>
    /// The JS report shape: the analytics engine's report serialized with the analytics wire options,
    /// then engine → server-rules, provenance → the datasource's own object (verbatim, as the JS
    /// engine copies it), taskId / cached stamped the way Node's TaskStore._run does.
    /// </summary>
    private static string ReportJson(AnalyticsReport report, JsonElement provenance, string taskId)
    {
        var node = JsonNode.Parse(JsonSerializer.Serialize(report, AnalyticsEndpoints.ResponseJsonOptions))!.AsObject();
        // JS shape: machine_fault / fail_root / overview always carry `highlight` (object or null); the three
        // intents below never set the key. The C# record always has the slot, so drop it for those intents.
        if (node["highlight"] is null && node["intent"]?.GetValue<string>() is "material_cmp" or "corr_layer" or "cost_trend")
        {
            node.Remove("highlight");
        }
        node["engine"] = Engine;
        node["provenance"] = provenance.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null
            ? null
            : JsonNode.Parse(provenance.GetRawText());
        node["taskId"] = taskId;
        node["cached"] = false;
        return node.ToJsonString();
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
