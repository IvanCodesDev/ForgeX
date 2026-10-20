using System.Text.Json.Nodes;
using ForgeX.Analytics;
using ForgeX.Api;

namespace ForgeX.ResourceGate;

/// <summary>Node server.test.js §10–14/18 的 C# 替身；不加载 Node 服务或经典脚本。</summary>
internal static class ServerProviderSection
{
    public static async Task RunAsync(Gate gate)
    {
        gate.Section("server-provider-contracts");
        Providers(gate);
        Merge(gate);
        Brief(gate);
        await CacheAsync(gate);
        Retrieval(gate);
        await CostGateAsync(gate);
    }

    private static void Providers(Gate gate)
    {
        AnalysisAiOptions Options(string preference, string key = "", string model = "") =>
            new(preference, "http://127.0.0.1:1/v1", key, model, 1000, false);
        gate.Check("server-10-auto-without-key-is-rules", !Options("auto").Resolve().UsesAi);
        gate.Check("server-10-explicit-openai-missing-config-degrades", !Options("openai").Resolve().UsesAi);
        gate.Check("server-10-auto-with-model-and-key-is-ai", Options("auto", "fake-key", "fake-model").Resolve().UsesAi);
        gate.Check("server-10-local-overrides-ai-config", !Options("local", "fake-key", "fake-model").Resolve().UsesAi);
        gate.Check("server-10-rules-overrides-ai-config", !Options("rules", "fake-key", "fake-model").Resolve().UsesAi);
        gate.Check("server-10-missing-model-is-rules", !Options("auto", "fake-key").Resolve().UsesAi);
        gate.Check("server-10-reason-explains-fallback", Options("openai").Resolve().Reason.Contains("降级", StringComparison.Ordinal));
        gate.Check("server-10-override-keyless-local-endpoint", AiEndpoint.Parse("http://localhost:11434/v1", null, "local-model") is { Endpoint: not null, Error: null });
        gate.Check("server-10-override-rejects-incomplete", AiEndpoint.Parse("http://localhost/v1", null, null).Error is not null);
        gate.Check("server-10-override-rejects-query", AiEndpoint.Parse("https://ai.example/v1?token=x", null, "m").Error is not null);
        gate.Check("server-10-override-rejects-fragment", AiEndpoint.Parse("https://ai.example/v1#x", null, "m").Error is not null);
    }

    private static void Merge(Gate gate)
    {
        var local = JsonNode.Parse("""
            {"title":"本地标题","verdict":"本地结论","chart":{"items":[{"v":12.5}]},
             "evidence":[{"method":"wilson","n":20}],"provenance":{"synthetic":true},
             "sections":[{"h":"统计口径","lines":["n=20"]}]}
            """)!.AsObject();
        var before = local.ToJsonString();
        var narrative = JsonNode.Parse("""
            {"title":"模型叙述","verdict":"模型结论","chart":{"items":[{"v":999}]},
             "evidence":[],"provenance":{"synthetic":false},
             "sections":[{"h":"建议","lines":["检查首层"]}]}
            """)!.AsObject();
        var merged = AnalysisReportMerge.MergeWithLocal(narrative, local, "openai-compatible", "fake-model");
        gate.Check("server-11-narrative-title-used", merged["title"]!.GetValue<string>() == "模型叙述");
        foreach (var name in new[] { "chart", "evidence", "provenance" })
            gate.Check("server-11-authoritative-" + name, JsonNode.DeepEquals(merged[name], local[name]));
        gate.Check("server-11-statistical-details-survive", merged["sections"]!.AsArray().Any(section => section?["h"]?.GetValue<string>() == "统计口径"));
        gate.Check("server-11-input-not-mutated", before == local.ToJsonString());
        var fallback = AnalysisReportMerge.MergeWithLocal(null, local, "openai-compatible", "fake-model");
        gate.Check("server-11-invalid-narrative-keeps-local-verdict", fallback["verdict"]!.GetValue<string>() == "本地结论");
        gate.Check("server-11-invalid-narrative-discloses-fallback", fallback["sections"]!.AsArray().Any(section => section?["h"]?.GetValue<string>() == "叙述降级说明"));
        gate.Check("server-11-json-fences", AnalysisReportMerge.ExtractJson("```json\n{\"a\":1}\n```")?["a"]?.GetValue<int>() == 1);
        gate.Check("server-11-json-invalid", AnalysisReportMerge.ExtractJson("完全不是 JSON") is null);
        gate.Check("server-11-prompt-forbids-arithmetic", OpenAiNarrativeClient.SystemPrompt.Contains("不要自己做任何算术", StringComparison.Ordinal));
        gate.Check("server-11-prompt-preserves-significance", OpenAiNarrativeClient.SystemPrompt.Contains("未达统计显著", StringComparison.Ordinal));
        gate.Check("server-11-prompt-forbids-causation", OpenAiNarrativeClient.SystemPrompt.Contains("不得表述为因果", StringComparison.Ordinal));
        gate.Check("server-11-secret-masked", !OpenAiNarrativeClient.MaskSecret("error fake-secret-value", "fake-secret-value").Contains("fake-secret-value", StringComparison.Ordinal));
    }

    private static void Brief(Gate gate)
    {
        var rows = FarmDataset.Rows;
        var brief = AnalyticsBriefEngine.Build(rows);
        var doubled = AnalyticsBriefEngine.Build(rows.Concat(rows).ToList());
        gate.Check("server-12-brief-smaller-than-raw-data", brief.Text.Length < FarmDataset.Csv.Length / 5);
        gate.Check("server-12-size-decoupled-from-row-count", Math.Abs(doubled.Text.Length - brief.Text.Length) < brief.Text.Length * 0.25);
        gate.Check("server-12-confidence-intervals", brief.Text.Contains("95%CI", StringComparison.Ordinal));
        gate.Check("server-12-sample-guard", brief.Text.Contains("不参与排名", StringComparison.Ordinal));
        gate.Check("server-12-correlation-not-causation", brief.Text.Contains("相关不等于因果", StringComparison.Ordinal));
        gate.Check("server-12-no-raw-row-identifiers", !brief.Text.Contains("FARM-0001", StringComparison.Ordinal));
    }

    private static async Task CacheAsync(Gate gate)
    {
        var key = AnalysisResultCache.Key(" 哪台机 ", "sample", "openai-compatible", "owner-a");
        gate.Check("server-13-cache-trims-question", key == AnalysisResultCache.Key("哪台机", "sample", "openai-compatible", "owner-a"));
        gate.Check("server-13-cache-provider-isolated", key != AnalysisResultCache.Key("哪台机", "sample", "server-rules", "owner-a"));
        gate.Check("server-13-cache-owner-isolated", key != AnalysisResultCache.Key("哪台机", "sample", "openai-compatible", "owner-b"));
        gate.Check("server-13-cache-question-isolated", key != AnalysisResultCache.Key("材料", "sample", "openai-compatible", "owner-a"));
        gate.Check("server-13-cache-dataset-isolated", key != AnalysisResultCache.Key("哪台机", "another-dataset", "openai-compatible", "owner-a"));
        var cache = new AnalysisResultCache(new(60000, 2));
        cache.Set("a", "A"); cache.Set("b", "B");
        gate.Check("server-13-cache-hit", cache.Get("a") == "A");
        cache.Set("c", "C");
        gate.Check("server-13-cache-lru", cache.Get("b") is null && cache.Get("a") == "A" && cache.Get("c") == "C");
        cache.Set("a", "updated");
        gate.Check("server-13-cache-replace", cache.Get("a") == "updated");
        var disabled = new AnalysisResultCache(new(60000, 0));
        disabled.Set("a", "A");
        gate.Check("server-13-cache-disable", disabled.Get("a") is null);
        var expired = new AnalysisResultCache(new(1, 1));
        expired.Set("x", "X");
        await Task.Delay(10);
        gate.Check("server-13-cache-ttl", expired.Get("x") is null);
    }

    private static void Retrieval(Gate gate)
    {
        RetrievalDocument[] documents = [new("k1", "术语", "翘边：首层附着失效。\n\n回抽：喷头空驶前回抽耗材。"), new("k2", "材料", "ABS 推荐喷嘴 255 度，需要封闭腔体。")];
        gate.Check("server-14-chinese-bigram", Bm25Retrieval.Tokenize("翘边").Contains("翘边"));
        gate.Check("server-14-latin-tokens", Bm25Retrieval.Tokenize("ABS 255C").Contains("abs"));
        var hits = Bm25Retrieval.Retrieve(documents, "翘边是什么原因");
        gate.Check("server-14-relevant-hits", hits.Count > 0 && hits[0].Text.Contains("翘边", StringComparison.Ordinal));
        gate.Check("server-14-no-unrelated-hits", Bm25Retrieval.Retrieve(documents, "zzz quantum foobar").Count == 0);
        gate.Check("server-14-empty-documents", Bm25Retrieval.Retrieve([], "翘边").Count == 0);
        gate.Check("server-14-score-positive", hits[0].Score > 0);
    }

    private static async Task CostGateAsync(Gate gate)
    {
        var quota = new AnalysisCostGate(new(1, 1, 2, 3));
        gate.Check("server-18-initial-budget", quota.Check("a") is { Ok: true, Remaining: 2 });
        quota.Consume("a"); quota.Consume("a");
        gate.Check("server-18-caller-budget", quota.Check("a") is { Ok: false, Code: "caller_daily_exhausted" });
        gate.Check("server-18-other-caller-budget", quota.Check("b").Ok);
        quota.Consume("b");
        gate.Check("server-18-global-budget", quota.Check("c") is { Ok: false, Code: "global_daily_exhausted" });
        gate.Check("server-18-unlimited-budget", new AnalysisCostGate(new(1, 0, 0, 0)).Check("a").Ok);
        // 已批准的迁移差异：C# 额度在进程内，不将旧 Node usage.json 的持久化宣称为已迁移。
        gate.Check("server-18-budget-not-persisted-disclosure", !quota.Snapshot().Persisted);
        gate.Check("server-18-day-boundary-is-utc", AnalysisCostGate.DayKey(DateTimeOffset.Parse("2026-10-20T01:00:00+08:00")) == "2026-10-19");
        var first = quota.Acquire();
        var releaseFirst = await first.Slot;
        gate.Check("server-18-first-slot", first.QueuedPosition is null && quota.Snapshot().Running == 1);
        var second = quota.Acquire();
        gate.Check("server-18-queued-slot", second.QueuedPosition == 1 && !second.Slot.IsCompleted);
        var rejected = false;
        try { _ = quota.Acquire(); }
        catch (AnalysisQueueFullException exception) { rejected = exception.Code == "queue_full"; }
        gate.Check("server-18-queue-bound", rejected);
        releaseFirst();
        var releaseSecond = await second.Slot.WaitAsync(TimeSpan.FromSeconds(2));
        gate.Check("server-18-slot-handoff", quota.Snapshot() is { Running: 1, Queued: 0 });
        releaseSecond();
        gate.Check("server-18-slots-drained", quota.Snapshot() is { Running: 0, Queued: 0 });
    }
}
