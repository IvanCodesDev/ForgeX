using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using ForgeX.Api;
using ForgeX.Application;
using ForgeX.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace ForgeX.ResourceGate;

/// <summary>Knowledge endpoints over the file leg and (when POSTGRES_URL is set) the PostgreSQL leg.</summary>
internal static class KnowledgeSection
{
    public static async Task RunAsync(Gate gate)
    {
        await RunLegAsync(gate, "file", (max, name) => new FileKnowledgeRepository(gate.TempDir("knowledge-" + name), max));
        if (gate.HasPostgres)
        {
            await RunLegAsync(gate, "postgres", (max, _) => new PostgresKnowledgeRepository(gate.PostgresUrl, max));
        }
    }

    private static async Task RunLegAsync(Gate gate, string leg, Func<int, string, IKnowledgeRepository> repositoryFactory)
    {
        gate.Section($"knowledge-{leg}: KnowledgeEndpoints");
        var ct = CancellationToken.None;
        var tenantA = RandomTenant();
        var ownerA = "ow_" + tenantA[3..];
        var tenantB = RandomTenant();
        var ownerB = "ow_" + tenantB[3..];

        var mainRepository = repositoryFactory(50, "main");
        var app = await StartAsync(gate, mainRepository, ttlMs: 60_000);
        var origin = Gate.Origin(app);

        // Create → 201 (chunks = UTF-16 length, id kb_ + 16 hex).
        var text = "PLA 打印失败率与喷嘴温度相关。\n\n喷嘴温度过高会导致拉丝，过低则层间结合差。";
        var (created, createdBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge",
            JsonSerializer.Serialize(new { name = "工艺手册.md", text }), Gate.Trusted(tenantA, ownerA));
        var createdJson = Gate.Parse(createdBody);
        gate.Check($"knowledge-{leg}-create-201", created.StatusCode == HttpStatusCode.Created, createdBody);
        var id = createdJson.GetProperty("knowledgeId").GetString()!;
        gate.Check($"knowledge-{leg}-create-shape",
            id.Length == 19 && id.StartsWith("kb_", StringComparison.Ordinal) &&
            createdJson.GetProperty("name").GetString() == "工艺手册.md" &&
            createdJson.GetProperty("chunks").GetInt32() == text.Length &&
            createdJson.GetProperty("expiresAt").GetInt64() > createdJson.GetProperty("createdAt").GetInt64(),
            createdBody);

        var (second, secondBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge",
            JsonSerializer.Serialize(new { text = "ABS 材料需要封闭机箱，环境温度波动会造成翘曲。" }), Gate.Trusted(tenantA, ownerA));
        gate.Check($"knowledge-{leg}-create-default-name", second.StatusCode == HttpStatusCode.Created && Gate.Parse(secondBody).GetProperty("name").GetString() == "knowledge.md", secondBody);
        await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge",
            JsonSerializer.Serialize(new { name = "other-tenant.md", text = "喷嘴温度 其他租户的文档" }), Gate.Trusted(tenantB, ownerB));

        // List: owner-scoped, oldest first.
        var (list, listBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/knowledge", null, Gate.Trusted(tenantA, ownerA));
        var docs = Gate.Parse(listBody).GetProperty("docs");
        gate.Check($"knowledge-{leg}-list-owner-scoped",
            list.StatusCode == HttpStatusCode.OK && docs.GetArrayLength() == 2 &&
            docs[0].GetProperty("knowledgeId").GetString() == id && docs[0].GetProperty("text").GetString() == text &&
            docs[1].GetProperty("name").GetString() == "knowledge.md",
            listBody);
        var (foreignList, foreignListBody) = await gate.SendAsync(origin, HttpMethod.Get, "/api/v1/knowledge", null, Gate.Trusted(tenantB, ownerB));
        gate.Check($"knowledge-{leg}-list-other-tenant", foreignList.StatusCode == HttpStatusCode.OK && Gate.Parse(foreignListBody).GetProperty("docs").GetArrayLength() == 1, foreignListBody);

        // Search: BM25 hits with the Node response shape; no-hit note; question coercion; topK semantics.
        var (search, searchBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge/search",
            JsonSerializer.Serialize(new { question = " 喷嘴温度 " }), Gate.Trusted(tenantA, ownerA));
        var searchJson = Gate.Parse(searchBody);
        gate.Check($"knowledge-{leg}-search-hit",
            search.StatusCode == HttpStatusCode.OK &&
            searchJson.GetProperty("question").GetString() == "喷嘴温度" &&
            searchJson.GetProperty("docCount").GetInt32() == 2 &&
            searchJson.GetProperty("hits").GetArrayLength() >= 1 &&
            searchJson.GetProperty("hits")[0].GetProperty("name").GetString() == "工艺手册.md" &&
            searchJson.GetProperty("hits")[0].GetProperty("score").GetDouble() > 0 &&
            !searchJson.TryGetProperty("note", out _),
            searchBody);
        var (noHit, noHitBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge/search",
            JsonSerializer.Serialize(new { question = "zzzz-unrelated" }), Gate.Trusted(tenantA, ownerA));
        var noHitJson = Gate.Parse(noHitBody);
        gate.Check($"knowledge-{leg}-search-no-hit-note",
            noHit.StatusCode == HttpStatusCode.OK && noHitJson.GetProperty("hits").GetArrayLength() == 0 &&
            noHitJson.GetProperty("note").GetString() == "没有检索到相关片段——分析时不会注入任何知识内容。",
            noHitBody);
        var (topK1, topK1Body) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge/search",
            JsonSerializer.Serialize(new { question = "温度", topK = "1" }), Gate.Trusted(tenantA, ownerA));
        gate.Check($"knowledge-{leg}-search-topk-string-coerced", topK1.StatusCode == HttpStatusCode.OK && Gate.Parse(topK1Body).GetProperty("hits").GetArrayLength() == 1, topK1Body);
        var (topKNegative, topKNegativeBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge/search",
            JsonSerializer.Serialize(new { question = "温度", topK = -1 }), Gate.Trusted(tenantA, ownerA));
        var allHits = Gate.Parse((await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge/search", JsonSerializer.Serialize(new { question = "温度" }), Gate.Trusted(tenantA, ownerA))).Body).GetProperty("hits").GetArrayLength();
        gate.Check($"knowledge-{leg}-search-topk-negative-slice", topKNegative.StatusCode == HttpStatusCode.OK && Gate.Parse(topKNegativeBody).GetProperty("hits").GetArrayLength() == Math.Max(allHits - 1, 0), $"{allHits}/{topKNegativeBody}");
        var (numericQuestion, numericQuestionBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge/search",
            JsonSerializer.Serialize(new { question = 42 }), Gate.Trusted(tenantA, ownerA));
        gate.Check($"knowledge-{leg}-search-question-coerced", numericQuestion.StatusCode == HttpStatusCode.OK && Gate.Parse(numericQuestionBody).GetProperty("question").GetString() == "42", numericQuestionBody);
        foreach (var (label, payload) in new[] { ("missing", "{}"), ("blank", "{\"question\":\"  \"}"), ("false", "{\"question\":false}") })
        {
            var (bad, badBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge/search", payload, Gate.Trusted(tenantA, ownerA));
            gate.Check($"knowledge-{leg}-search-question-required-{label}", bad.StatusCode == HttpStatusCode.BadRequest && badBody.Contains("question 不能为空", StringComparison.Ordinal), badBody);
        }

        // Validation parity with Node route/store messages.
        var (noText, noTextBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge", "{\"name\":\"x\"}", Gate.Trusted(tenantA, ownerA));
        gate.Check($"knowledge-{leg}-text-required-400", noText.StatusCode == HttpStatusCode.BadRequest && noTextBody.Contains("text 字段不能为空", StringComparison.Ordinal), noTextBody);
        var (numericText, numericTextBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge", "{\"text\":12}", Gate.Trusted(tenantA, ownerA));
        gate.Check($"knowledge-{leg}-text-non-string-400", numericText.StatusCode == HttpStatusCode.BadRequest && numericTextBody.Contains("text_required", StringComparison.Ordinal), numericTextBody);
        var (empty, emptyBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge", "{\"text\":\" \\n\\t \"}", Gate.Trusted(tenantA, ownerA));
        gate.Check($"knowledge-{leg}-empty-400", empty.StatusCode == HttpStatusCode.BadRequest && emptyBody.Contains("知识文档内容为空", StringComparison.Ordinal), emptyBody);
        var oversized = JsonSerializer.Serialize(new { text = new string('a', 512 * 1024 + 1) });
        var (tooLong, tooLongBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge", oversized, Gate.Trusted(tenantA, ownerA));
        gate.Check($"knowledge-{leg}-too-large-413", tooLong.StatusCode == HttpStatusCode.RequestEntityTooLarge && tooLongBody.Contains("知识文档超过 512KB", StringComparison.Ordinal), tooLongBody);
        var bodyTooBig = "{\"text\":\"" + new string('a', 600 * 1024 + 16) + "\"}";
        var (bodyLimit, bodyLimitBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge", bodyTooBig, Gate.Trusted(tenantA, ownerA));
        gate.Check($"knowledge-{leg}-body-limit-413", bodyLimit.StatusCode == HttpStatusCode.RequestEntityTooLarge && bodyLimitBody.Contains("请求体过大", StringComparison.Ordinal), bodyLimitBody);
        var exact = JsonSerializer.Serialize(new { text = new string('b', 512 * 1024) });
        var (exactSize, exactSizeBody) = await gate.SendAsync(origin, HttpMethod.Post, "/api/v1/knowledge", exact, Gate.Trusted(tenantB, ownerB));
        gate.Check($"knowledge-{leg}-exact-limit-accepted", exactSize.StatusCode == HttpStatusCode.Created && Gate.Parse(exactSizeBody).GetProperty("chunks").GetInt32() == 512 * 1024, exactSizeBody);

        var count = await mainRepository.CountAsync(ct);
        gate.Check($"knowledge-{leg}-count", count == 4, count);

        // Eviction (A5): max 2 → oldest doc disappears from the list, newest two remain.
        var evictionRepository = repositoryFactory(2, "evict");
        var evictionApp = await StartAsync(gate, evictionRepository, ttlMs: 60_000);
        var evictionOrigin = Gate.Origin(evictionApp);
        var evictionTenant = RandomTenant();
        var evictionOwner = "ow_" + evictionTenant[3..];
        for (var i = 0; i < 3; i++)
        {
            await gate.SendAsync(evictionOrigin, HttpMethod.Post, "/api/v1/knowledge", JsonSerializer.Serialize(new { name = $"doc{i}", text = $"document {i}" }), Gate.Trusted(evictionTenant, evictionOwner));
            await Task.Delay(5, ct);
        }
        var evictedList = Gate.Parse((await gate.SendAsync(evictionOrigin, HttpMethod.Get, "/api/v1/knowledge", null, Gate.Trusted(evictionTenant, evictionOwner))).Body).GetProperty("docs");
        var names = string.Join(",", evictedList.EnumerateArray().Select(static doc => doc.GetProperty("name").GetString()));
        gate.Check($"knowledge-{leg}-evict-oldest-first", names == "doc1,doc2", names);

        // TTL: 0 → never expires; tiny TTL → gone from list and search after expiry; sweep removes it.
        var foreverApp = await StartAsync(gate, repositoryFactory(50, "forever"), ttlMs: 0);
        var (forever, foreverBody) = await gate.SendAsync(Gate.Origin(foreverApp), HttpMethod.Post, "/api/v1/knowledge", JsonSerializer.Serialize(new { text = "forever" }), Gate.Trusted(tenantA, ownerA));
        gate.Check($"knowledge-{leg}-ttl-zero-never-expires", forever.StatusCode == HttpStatusCode.Created && !Gate.Parse(foreverBody).TryGetProperty("expiresAt", out _), foreverBody);
        var ttlRepository = repositoryFactory(50, "ttl");
        var ttlApp = await StartAsync(gate, ttlRepository, ttlMs: 30);
        var ttlTenant = RandomTenant();
        var ttlOwner = "ow_" + ttlTenant[3..];
        await gate.SendAsync(Gate.Origin(ttlApp), HttpMethod.Post, "/api/v1/knowledge", JsonSerializer.Serialize(new { text = "short lived 喷嘴" }), Gate.Trusted(ttlTenant, ttlOwner));
        await Task.Delay(100, ct);
        var expiredList = Gate.Parse((await gate.SendAsync(Gate.Origin(ttlApp), HttpMethod.Get, "/api/v1/knowledge", null, Gate.Trusted(ttlTenant, ttlOwner))).Body).GetProperty("docs");
        var expiredSearch = Gate.Parse((await gate.SendAsync(Gate.Origin(ttlApp), HttpMethod.Post, "/api/v1/knowledge/search", JsonSerializer.Serialize(new { question = "喷嘴" }), Gate.Trusted(ttlTenant, ttlOwner))).Body);
        gate.Check($"knowledge-{leg}-ttl-expired-invisible", expiredList.GetArrayLength() == 0 && expiredSearch.GetProperty("docCount").GetInt32() == 0, expiredList.GetArrayLength());
        await gate.SendAsync(Gate.Origin(ttlApp), HttpMethod.Post, "/api/v1/knowledge", JsonSerializer.Serialize(new { text = "sweep me" }), Gate.Trusted(ttlTenant, ttlOwner));
        await Task.Delay(100, ct);
        var swept = await ttlRepository.SweepAsync(DateTimeOffset.UtcNow, ct);
        gate.Check($"knowledge-{leg}-sweep", swept >= 1, swept);

        if (leg == "file")
        {
            var directory = ((FileKnowledgeRepository)mainRepository).RootDirectory;
            var reopened = new FileKnowledgeRepository(directory, 50);
            var persisted = await reopened.ListAsync(tenantA, ownerA, ct);
            gate.Check($"knowledge-{leg}-survives-restart", persisted.Count == 2 && persisted[0].Id == id, persisted.Count);
        }

        await mainRepository.ProbeAsync(ct);
        gate.Check($"knowledge-{leg}-probe", true);
    }

    private static Task<WebApplication> StartAsync(Gate gate, IKnowledgeRepository repository, long ttlMs) =>
        gate.StartApiAsync(
            new Dictionary<string, string?>(),
            builder =>
            {
                builder.Services.AddSingleton(new KnowledgeOptions(ttlMs, 50));
                builder.Services.AddSingleton(repository);
            },
            KnowledgeEndpoints.Map);

    private static string RandomTenant() => "tn_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
}
