using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ForgeX.Analytics;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.6c-2b-ii — the AI leg of the creation chain, ported from Node's services/providers.js,
/// lib/quota.js and the ResultCache in services/analysis.js. Everything the user can observe is kept
/// identical: provider ids, progress events, the system / user prompt, the merge rules that keep
/// charts / evidence local, the degrade section, the quota messages and the cache key derivation.
/// Decisions (user, 2026-09-08): gate and cache live in-process, the AI call is non-streaming.
/// </summary>
internal sealed record AnalysisAiOptions(string Preference, string BaseUrl, string ApiKey, string Model, int TimeoutMs, bool Probe)
{
    public const string DefaultBaseUrl = "https://api.openai.com/v1";
    public const int DefaultTimeoutMs = 120_000;

    /// <summary>Node config.js provider selection: ANALYSIS_PROVIDER=auto|openai|local (rules) + OPENAI_* readiness.</summary>
    public (bool UsesAi, string Reason) Resolve()
    {
        var ready = ApiKey.Length > 0 && Model.Length > 0;
        return Preference switch
        {
            "rules" or "local" => (false, "Analysis:Provider=rules"),
            "openai" => ready
                ? (true, "显式指定 OpenAI 兼容端点（" + Model + "）")
                : (false, "指定了 OpenAI 兼容端点但缺 OpenAi:ApiKey / OpenAi:Model，降级为规则引擎"),
            _ => ready
                ? (true, "自动选择：OpenAI 兼容端点已配置（" + Model + "）")
                : (false, "未配置 AI 端点，使用规则引擎（结论仍带置信区间与显著性检验）；也可在分析请求里自带 OpenAI 兼容端点"),
        };
    }
}

internal sealed record AnalysisGateOptions(int AiConcurrency, int AiQueueMax, int DailyPerCaller, int DailyGlobal)
{
    public const int DefaultAiConcurrency = 2;
    public const int DefaultAiQueueMax = 8;
    public const int DefaultDailyPerCaller = 20;
    public const int DefaultDailyGlobal = 200;
}

internal sealed record AnalysisCacheOptions(long TtlMs, int Max)
{
    public const long DefaultTtlMs = 30 * 60 * 1000;
    public const int DefaultMax = 200;
}

/// <summary>A caller-supplied OpenAI-compatible endpoint. Lives only inside the request / work item — never persisted or logged.</summary>
internal sealed record AiEndpoint(string BaseUrl, string ApiKey, string Model)
{
    public const int MaxBaseUrlChars = 1024;
    public const int MaxApiKeyChars = 512;
    public const int MaxModelChars = 128;

    /// <summary>Node lib/ai-endpoint.js parseAiOverride — same rules, same messages; null when all three fields are blank.</summary>
    public static (AiEndpoint? Endpoint, string? Error) Parse(string? baseUrl, string? apiKey, string? model)
    {
        var url = JsValue.Trim(baseUrl ?? string.Empty);
        var key = JsValue.Trim(apiKey ?? string.Empty);
        var name = JsValue.Trim(model ?? string.Empty);
        if (url.Length == 0 && key.Length == 0 && name.Length == 0) return (null, null);
        if (url.Length == 0 || name.Length == 0) return (null, "自带 AI 端点需要同时提供 aiBaseUrl 与 aiModel（aiApiKey 按端点要求可选）");
        if (url.Length > MaxBaseUrlChars) return (null, "aiBaseUrl 超过 " + MaxBaseUrlChars + " 字符上限");
        if (key.Length > MaxApiKeyChars) return (null, "aiApiKey 超过 " + MaxApiKeyChars + " 字符上限");
        if (name.Length > MaxModelChars) return (null, "aiModel 超过 " + MaxModelChars + " 字符上限");
        if (!Uri.TryCreate(url, UriKind.Absolute, out var target)) return (null, "aiBaseUrl 必须是合法的 http(s) URL");
        if (target.Scheme is not ("http" or "https")) return (null, "aiBaseUrl 只允许 http(s)");
        if (target.UserInfo.Length > 0) return (null, "aiBaseUrl 禁止内嵌凭据");
        if (target.Fragment.Length > 0) return (null, "aiBaseUrl 禁止携带片段");
        if (target.Query.Length > 0) return (null, "aiBaseUrl 禁止携带查询参数");
        return (new AiEndpoint(url.TrimEnd('/'), key, name), null);
    }

    /// <summary>Node analysis.js cacheVariant: endpoint + model, never the key.</summary>
    public string CacheVariant =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(BaseUrl + "\0" + Model)))[..16];
}

/// <summary>Chosen provider for the process (Node TaskStore.provider) plus the startup probe that may demote it.</summary>
internal sealed class AnalysisProviderSelection(AnalysisAiOptions options, ILogger<AnalysisProviderSelection> logger)
{
    private volatile bool _usesAi = options.Resolve().UsesAi;

    public const string RulesId = "server-rules";
    public const string OpenAiId = "openai-compatible";

    public bool UsesAi => _usesAi;
    public string Reason { get; private set; } = options.Resolve().Reason;
    public string? ProbeFailure { get; private set; }

    public AiEndpoint? ProcessEndpoint => _usesAi ? new AiEndpoint(options.BaseUrl.TrimEnd('/'), options.ApiKey, options.Model) : null;

    /// <summary>Node TaskStore.probeProvider: a dead endpoint demotes the process to the rules engine at start-up.</summary>
    public async Task ProbeAsync(OpenAiNarrativeClient client, CancellationToken cancellationToken)
    {
        if (!_usesAi || !options.Probe) return;
        var endpoint = ProcessEndpoint!;
        var (ok, detail) = await client.ProbeAsync(endpoint, cancellationToken);
        if (ok)
        {
            logger.LogInformation("provider probe ok: {Model}", detail);
            return;
        }
        logger.LogWarning("provider probe failed, falling back to rules engine: {Detail}", detail);
        ProbeFailure = detail;
        Reason = "AI 端点探活失败，降级为规则引擎：" + detail;
        _usesAi = false;
    }
}

/// <summary>Node lib/quota.js CostGate, in-process (decision A5-1): daily budgets per caller / global, AI concurrency and queue.</summary>
internal sealed class AnalysisCostGate(AnalysisGateOptions options)
{
    private readonly object _lock = new();
    private readonly Dictionary<string, int> _perCaller = new(StringComparer.Ordinal);
    private readonly Queue<TaskCompletionSource<Action>> _queue = new();
    private string _day = DayKey(DateTimeOffset.UtcNow);
    private int _global;
    private long _totalEver;
    private int _running;

    public sealed record Verdict(bool Ok, string? Code, string? Reason, long? Remaining);

    public static string DayKey(DateTimeOffset now) => now.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public Verdict Check(string caller)
    {
        lock (_lock)
        {
            Rollover();
            if (options.DailyGlobal > 0 && _global >= options.DailyGlobal)
            {
                return new Verdict(false, "global_daily_exhausted",
                    "本实例今日的 AI 分析额度已用尽（" + options.DailyGlobal + " 次/日）。" +
                    "规则引擎不受限制，仍可正常分析（结论同样带置信区间与显著性检验）；" +
                    "需要 AI 叙述请自行部署并配置自己的 API key。", null);
            }
            if (options.DailyPerCaller > 0)
            {
                var used = _perCaller.GetValueOrDefault(caller);
                if (used >= options.DailyPerCaller)
                {
                    return new Verdict(false, "caller_daily_exhausted",
                        "你今日的 AI 分析额度已用尽（" + options.DailyPerCaller + " 次/日）。" +
                        "规则引擎不受限制，仍可正常分析；需要更多 AI 额度请自行部署并配置自己的 API key。", 0);
                }
                return new Verdict(true, null, null, options.DailyPerCaller - used);
            }
            // Node: remaining = Infinity → the facade renders null.
            return new Verdict(true, null, null, null);
        }
    }

    public void Consume(string caller)
    {
        lock (_lock)
        {
            Rollover();
            _perCaller[caller] = _perCaller.GetValueOrDefault(caller) + 1;
            _global++;
            _totalEver++;
        }
    }

    /// <summary>
    /// Node CostGate.acquire: a free slot right away, otherwise queue (reporting the position so the caller
    /// can tell the user), otherwise reject. The queued-position event is emitted by the caller outside the lock.
    /// </summary>
    public (Task<Action> Slot, int? QueuedPosition) Acquire()
    {
        lock (_lock)
        {
            if (_running < options.AiConcurrency)
            {
                _running++;
                return (Task.FromResult<Action>(Release), null);
            }
            if (_queue.Count >= options.AiQueueMax)
            {
                throw new AnalysisQueueFullException(
                    "分析队列已满（正在跑 " + _running + " 个，排队 " + _queue.Count + " 个）。请稍后重试，或改用不受限的规则引擎。");
            }
            var waiter = new TaskCompletionSource<Action>(TaskCreationOptions.RunContinuationsAsynchronously);
            _queue.Enqueue(waiter);
            return (waiter.Task, _queue.Count);
        }
    }

    private void Release()
    {
        TaskCompletionSource<Action>? next = null;
        lock (_lock)
        {
            if (_queue.Count > 0) next = _queue.Dequeue();
            else _running = Math.Max(0, _running - 1);
        }
        // The slot is handed straight to the next waiter; running stays unchanged (Node _release).
        next?.TrySetResult(Release);
    }

    private void Rollover()
    {
        var today = DayKey(DateTimeOffset.UtcNow);
        if (today == _day) return;
        _day = today;
        _perCaller.Clear();
        _global = 0;
    }

    /// <summary>Node CostGate.snapshot(): what /healthz and /metrics expose.</summary>
    public sealed record GateSnapshot(
        int Running,
        int Queued,
        int ConcurrencyLimit,
        int QueueLimit,
        string Day,
        int GlobalUsed,
        int? GlobalLimit,
        int? PerCallerLimit,
        int Callers,
        long TotalEver,
        bool Persisted);

    public GateSnapshot Snapshot()
    {
        lock (_lock)
        {
            Rollover();
            return new GateSnapshot(
                _running,
                _queue.Count,
                options.AiConcurrency,
                options.AiQueueMax,
                _day,
                _global,
                options.DailyGlobal > 0 ? options.DailyGlobal : null,
                options.DailyPerCaller > 0 ? options.DailyPerCaller : null,
                _perCaller.Count,
                _totalEver,
                false);
        }
    }
}

/// <summary>Node metrics counters for analysis tasks (forgex_tasks_* on /metrics).</summary>
internal sealed class AnalysisTaskMetrics
{
    private long _tasks;
    private long _failed;
    private long _degraded;
    private long _cached;
    private long _lastDurationMs;

    public long Tasks => Interlocked.Read(ref _tasks);
    public long Failed => Interlocked.Read(ref _failed);
    public long Degraded => Interlocked.Read(ref _degraded);
    public long Cached => Interlocked.Read(ref _cached);
    public long LastDurationMs => Interlocked.Read(ref _lastDurationMs);

    public void RecordCreated() => Interlocked.Increment(ref _tasks);
    public void RecordFailed() => Interlocked.Increment(ref _failed);
    public void RecordDegraded() => Interlocked.Increment(ref _degraded);
    public void RecordCached() => Interlocked.Increment(ref _cached);
    public void RecordDuration(long milliseconds) => Interlocked.Exchange(ref _lastDurationMs, milliseconds);
}

internal sealed class AnalysisQueueFullException(string message) : Exception(message)
{
    public string Code => "queue_full";
}

/// <summary>Node analysis.js ResultCache: LRU + TTL keyed by sha256(provider, datasourceKey, question)[:32] scoped per credential.</summary>
internal sealed class AnalysisResultCache(AnalysisCacheOptions options)
{
    private readonly object _lock = new();
    private readonly Dictionary<string, LinkedListNode<(string Key, long At, string Report)>> _entries = new(StringComparer.Ordinal);
    private readonly LinkedList<(string Key, long At, string Report)> _order = new();

    public static string Key(string question, string datasourceKey, string providerKey, string scope)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        sha.AppendData(Encoding.UTF8.GetBytes(string.Join("\0", providerKey, datasourceKey, JsValue.Trim(question))));
        sha.AppendData(Encoding.UTF8.GetBytes(scope.Length > 0 ? scope : "global"));
        return Convert.ToHexStringLower(sha.GetHashAndReset())[..32];
    }

    public string? Get(string key)
    {
        lock (_lock)
        {
            if (!_entries.TryGetValue(key, out var node)) return null;
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - node.Value.At > options.TtlMs)
            {
                _order.Remove(node);
                _entries.Remove(key);
                return null;
            }
            _order.Remove(node);
            _order.AddLast(node);
            return node.Value.Report;
        }
    }

    public void Set(string key, string report)
    {
        if (options.Max <= 0) return;
        lock (_lock)
        {
            if (_entries.TryGetValue(key, out var existing))
            {
                _order.Remove(existing);
                _entries.Remove(key);
            }
            var node = _order.AddLast((key, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), report));
            _entries[key] = node;
            while (_entries.Count > options.Max && _order.First is { } oldest)
            {
                _order.RemoveFirst();
                _entries.Remove(oldest.Value.Key);
            }
        }
    }
}

/// <summary>Node providers.js openaiProvider: the chat/completions call, the probe and the secret masking.</summary>
internal sealed class OpenAiNarrativeClient(ILogger<OpenAiNarrativeClient> logger)
{
    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private static readonly Regex BareKey = new("sk-[A-Za-z0-9_-]{8,}", RegexOptions.Compiled);
    private static readonly JsonSerializerOptions PromptJsonOptions = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public const string SystemPrompt =
        "你是增材制造（3D 打印）领域的资深数据分析师。\n" +
        "下面会给你一份**已经算好的统计简报**——所有比例、置信区间、显著性检验都已由确定性统计程序计算并核验。\n" +
        "\n" +
        "你的职责是把这些事实组织成一份可读的分析报告，**不是重新计算**。硬性要求：\n" +
        "1. 只使用简报中出现的数字。**不要自己做任何算术**（不要相加、相减、求平均、估算比例）。\n" +
        "2. 简报标注「显著高于其余」的项，才可以说「显著」；未标注的必须写明「差异未达统计显著」。\n" +
        "3. 报告比例时连同 95% 置信区间一起给出，不要只给点估计。\n" +
        "4. 样本量不足的分组，只能提及其存在，不得据此下结论。\n" +
        "5. 相关性只描述共变关系，**不得表述为因果**（不要写「调大层高会更快」这类因果主张）。\n" +
        "6. 简报里没有的信息，一律回答不知道，不要推测。\n" +
        "7. 中文回答，给出可执行的排查建议，但建议必须由简报中的事实支撑。";

    public static string UserPrompt(string question, string brief, IReadOnlyList<RetrievalHit> knowledge)
    {
        var parts = new List<string>();
        if (knowledge.Count > 0)
        {
            parts.Add("# 领域知识（供理解术语，不含数据）");
            parts.Add(string.Join("\n\n", knowledge.Select(static hit => "## " + hit.Name + "\n" + hit.Text)));
            parts.Add(string.Empty);
        }
        parts.Add("# 统计简报（已核验，勿重算）");
        parts.Add(brief);
        parts.Add(string.Empty);
        parts.Add("# 用户问题");
        parts.Add(question);
        parts.Add(string.Empty);
        parts.Add("# 输出格式");
        parts.Add("严格输出如下 JSON，不要输出 JSON 以外的任何文字：");
        parts.Add("{\"title\":\"报告标题(≤16字)\",\"verdict\":\"一句话核心结论(≤120字，含关键数字与区间)\"," +
            "\"sections\":[{\"h\":\"小节标题\",\"lines\":[\"要点…\"]}]}");
        return string.Join("\n", parts);
    }

    public static string MaskSecret(string? text, string? secret)
    {
        var output = text ?? string.Empty;
        if (!string.IsNullOrEmpty(secret)) output = output.Replace(secret, "[REDACTED]", StringComparison.Ordinal);
        return BareKey.Replace(output, "sk-[REDACTED]");
    }

    public async Task<(bool Ok, string Detail)> ProbeAsync(AiEndpoint endpoint, CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, endpoint.BaseUrl + "/models");
            Authorize(request, endpoint.ApiKey);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(8));
            using var response = await Http.SendAsync(request, timeout.Token);
            return response.IsSuccessStatusCode ? (true, endpoint.Model) : (false, "HTTP " + (int)response.StatusCode);
        }
        catch (Exception exception)
        {
            return (false, MaskSecret(exception.Message, endpoint.ApiKey));
        }
    }

    /// <summary>Returns the raw completion JSON (choices / usage); throws Node's "AI 服务响应异常（HTTP n）" on non-2xx.</summary>
    public async Task<JsonObject?> CompleteAsync(AiEndpoint endpoint, string question, string brief, IReadOnlyList<RetrievalHit> knowledge, int timeoutMs, CancellationToken cancellationToken)
    {
        var payload = new JsonObject
        {
            ["model"] = endpoint.Model,
            ["temperature"] = 0.2,
            ["response_format"] = new JsonObject { ["type"] = "json_object" },
            ["messages"] = new JsonArray(
                new JsonObject { ["role"] = "system", ["content"] = SystemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = UserPrompt(question, brief, knowledge) }),
        };
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint.BaseUrl + "/chat/completions")
        {
            // Node sends the prompt as raw UTF-8; keep the wire form identical instead of \uXXXX-escaping every CJK character.
            Content = new StringContent(payload.ToJsonString(PromptJsonOptions), Encoding.UTF8, "application/json"),
        };
        Authorize(request, endpoint.ApiKey);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(Math.Max(1, timeoutMs)));
        using var response = await Http.SendAsync(request, timeout.Token);
        var body = await response.Content.ReadAsStringAsync(timeout.Token);
        if (!response.IsSuccessStatusCode)
        {
            logger.LogError("openai upstream error status={Status} body={Body}", (int)response.StatusCode,
                MaskSecret(body.Length > 500 ? body[..500] : body, endpoint.ApiKey));
            throw new InvalidOperationException("AI 服务响应异常（HTTP " + (int)response.StatusCode + "）");
        }
        try
        {
            return JsonNode.Parse(body) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static void Authorize(HttpRequestMessage request, string apiKey)
    {
        // Key-less endpoints (local Ollama and friends) must not receive an empty Authorization header.
        if (apiKey.Length > 0) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
    }
}

/// <summary>Node providers.js mergeWithLocal / extractJson and analysis.js _degrade, on the JS-shaped report JSON.</summary>
internal static class AnalysisReportMerge
{
    private static readonly Regex DetailSections = new("排行|统计|口径|读数说明|相关性", RegexOptions.Compiled);

    /// <summary>First complete JSON object inside free text (code fences and explanations tolerated); null when none parses.</summary>
    public static JsonObject? ExtractJson(string? text)
    {
        var source = text ?? string.Empty;
        var start = source.IndexOf('{');
        if (start < 0) return null;
        var depth = 0;
        var inString = false;
        var escaped = false;
        for (var index = start; index < source.Length; index++)
        {
            var character = source[index];
            if (escaped)
            {
                escaped = false;
                continue;
            }
            if (character == '\\')
            {
                escaped = true;
                continue;
            }
            if (character == '"')
            {
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (character == '{') depth++;
            else if (character == '}' && --depth == 0)
            {
                try
                {
                    return JsonNode.Parse(source[start..(index + 1)]) as JsonObject;
                }
                catch (JsonException)
                {
                    return null;
                }
            }
        }
        return null;
    }

    public static JsonObject MergeWithLocal(JsonObject? narrative, JsonObject local, string engine, string model)
    {
        var merged = (JsonObject)local.DeepClone();
        // Node: `if (narrative && narrative.title) merged.title = String(narrative.title).slice(0, 40)` — truthiness gates the override.
        if (narrative is not null && Truthy(narrative["title"])) merged["title"] = JsSlice(Str(narrative["title"]), 40);
        if (narrative is not null && Truthy(narrative["verdict"])) merged["verdict"] = JsSlice(Str(narrative["verdict"]), 400);
        if (narrative?["sections"] is JsonArray sections && sections.Count > 0)
        {
            var rebuilt = new JsonArray();
            foreach (var section in sections.Take(10))
            {
                var item = section as JsonObject;
                var heading = item is not null && Truthy(item["h"]) ? Str(item["h"]) : string.Empty;
                var lines = new JsonArray();
                if (item?["lines"] is JsonArray rawLines)
                {
                    foreach (var line in rawLines.Take(14)) lines.Add(JsSlice(Str(line), 400));
                }
                rebuilt.Add(new JsonObject { ["h"] = JsSlice(heading, 40), ["lines"] = lines });
            }
            // Statistical detail always survives at the end: the narrative may summarise, the evidence may not be summarised away.
            if (local["sections"] is JsonArray localSections)
            {
                foreach (var section in localSections)
                {
                    if (section is JsonObject detail && DetailSections.IsMatch(Str(detail["h"])))
                    {
                        rebuilt.Add(detail.DeepClone());
                    }
                }
            }
            merged["sections"] = rebuilt;
        }
        merged["engine"] = engine;
        merged["narrativeBy"] = model;
        merged["statsBy"] = "local-stats-kernel";
        merged["model"] = model;
        if (narrative is null)
        {
            var sectionsNode = merged["sections"] as JsonArray ?? new JsonArray();
            if (merged["sections"] is not JsonArray) merged["sections"] = sectionsNode;
            sectionsNode.Add(new JsonObject
            {
                ["h"] = "叙述降级说明",
                ["lines"] = new JsonArray("AI 未返回可解析的结构化结果，以上为本地统计引擎的原始产物。数字不受影响。"),
            });
        }
        return merged;
    }

    /// <summary>Node analysis.js _degrade: the rules report, annotated with why the AI narrative is missing.</summary>
    public static JsonObject Degrade(JsonObject rulesReport, string degradedFrom, string reason)
    {
        var report = (JsonObject)rulesReport.DeepClone();
        report["degradedFrom"] = degradedFrom;
        report["degradeReason"] = reason;
        var sections = report["sections"] as JsonArray ?? new JsonArray();
        if (report["sections"] is not JsonArray) report["sections"] = sections;
        sections.Add(new JsonObject
        {
            ["h"] = "为什么这份报告没有 AI 叙述",
            ["lines"] = new JsonArray(
                reason,
                "以上结论由规则引擎产出：统计口径、置信区间、显著性检验与 AI 模式完全一致——少的只是自然语言叙述，数字一个都没少。"),
        });
        return report;
    }

    /// <summary>JS String.prototype.slice(0, n) on the UTF-16 view.</summary>
    private static string JsSlice(string value, int length) => value.Length <= length ? value : value[..length];

    /// <summary>JS String(x); JSON null (the only null a parsed array can hold) stringifies as "null".</summary>
    private static string Str(JsonNode? node) =>
        node is null ? "null" : JsValue.ToJsString(JsonSerializer.SerializeToElement(node));

    private static bool Truthy(JsonNode? node) =>
        node is not null && JsValue.Truthy(JsonSerializer.SerializeToElement(node));
}
