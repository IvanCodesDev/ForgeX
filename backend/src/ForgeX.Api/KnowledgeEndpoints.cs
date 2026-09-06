using System.Security.Cryptography;
using System.Text.Json;
using ForgeX.Analytics;
using ForgeX.Application;
using ForgeX.Contracts;

namespace ForgeX.Api;

/// <summary>Knowledge:TtlMs（0 = 永不过期）与 Knowledge:MaxPerOwner。</summary>
internal sealed record KnowledgeOptions(long TtlMs, int MaxPerOwner)
{
    public const long DefaultTtlMs = 60L * 60 * 1000;
    public const int DefaultMaxPerOwner = 50;
}

/// <summary>
/// Stage 8.6a：知识库端点，server/routes/knowledge.js + services/knowledge.js 的 C# 权威腿。
/// 检索走 Bm25Retrieval（与 services/retrieval.js 逐分对齐，ResourceGate 用 Node 夹具锁定）。
/// </summary>
internal static class KnowledgeEndpoints
{
    private const long MaxCreateBodyBytes = 600L * 1024;
    private const long MaxSearchBodyBytes = 8L * 1024;
    /// <summary>Node MAX_TEXT：按 UTF-16 单元计。</summary>
    private const int MaxTextLength = 512 * 1024;
    private const string NoHitNote = "没有检索到相关片段——分析时不会注入任何知识内容。";

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/knowledge", CreateAsync)
            .WithName("CreateKnowledgeDocument")
            .ExcludeFromDescription();

        app.MapGet("/api/v1/knowledge", ListAsync)
            .WithName("ListKnowledgeDocuments")
            .ExcludeFromDescription();

        app.MapPost("/api/v1/knowledge/search", SearchAsync)
            .WithName("SearchKnowledge")
            .ExcludeFromDescription();
    }

    public static async Task<IResult> CreateAsync(HttpContext context, IKnowledgeRepository knowledge, KnowledgeOptions options)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var body = await EndpointBodies.ReadJsonAsync<KnowledgeCreateRequestDto>(context, MaxCreateBodyBytes, "请求体过大");
        if (body.Problem is not null)
        {
            return body.Problem;
        }

        var request = body.Value;
        if (request?.Text is not { ValueKind: JsonValueKind.String } textElement)
        {
            return ApiProblemResults.Create(context, 400, "text_required", "text 字段不能为空");
        }

        var text = textElement.GetString() ?? string.Empty;
        if (JsValue.Trim(text).Length == 0)
        {
            return ApiProblemResults.Create(context, 400, "knowledge_empty", "知识文档内容为空");
        }

        if (text.Length > MaxTextLength)
        {
            return ApiProblemResults.Create(context, 413, "knowledge_too_large", "知识文档超过 512KB");
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var document = new KnowledgeDocument(
            "kb_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)),
            caller.TenantId,
            caller.OwnerId,
            DatasourceEndpoints.JsSlice(JsValue.Truthy(request.Name) ? JsValue.ToJsString(request.Name) : "knowledge.md", 80),
            text,
            now,
            options.TtlMs > 0 ? now + options.TtlMs : null);

        var created = await knowledge.CreateAsync(document, context.RequestAborted);
        return Results.Json(
            new KnowledgeCreateResponseDto(created.Id, created.Name, created.Text.Length, created.CreatedAt, created.ExpiresAt),
            statusCode: StatusCodes.Status201Created);
    }

    public static async Task<IResult> ListAsync(HttpContext context, IKnowledgeRepository knowledge)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var documents = await knowledge.ListAsync(caller.TenantId, caller.OwnerId, context.RequestAborted);
        return Results.Json(new KnowledgeListResponseDto(
            documents.Select(static doc => new KnowledgeDocumentDto(doc.Id, doc.Name, doc.Text, doc.CreatedAt, doc.ExpiresAt)).ToList()));
    }

    public static async Task<IResult> SearchAsync(HttpContext context, IKnowledgeRepository knowledge)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var body = await EndpointBodies.ReadJsonAsync<KnowledgeSearchRequestDto>(context, MaxSearchBodyBytes, "请求体过大");
        if (body.Problem is not null)
        {
            return body.Problem;
        }

        var request = body.Value;
        // Node: String(body.question || "").trim()
        var question = JsValue.Trim(JsValue.Truthy(request?.Question) ? JsValue.ToJsString(request!.Question) : string.Empty);
        if (question.Length == 0)
        {
            return ApiProblemResults.Create(context, 400, "question_required", "question 不能为空");
        }

        var documents = await knowledge.ListAsync(caller.TenantId, caller.OwnerId, context.RequestAborted);
        var hits = Bm25Retrieval.Retrieve(
            documents.Select(static doc => new RetrievalDocument(doc.Id, doc.Name, doc.Text)).ToList(),
            question,
            ResolveTopK(request?.TopK));
        return Results.Json(new KnowledgeSearchResponseDto(
            question,
            documents.Count,
            hits.Select(static hit => new KnowledgeSearchHitDto(hit.Name, hit.Text, hit.Score)).ToList(),
            hits.Count > 0 ? null : NoHitNote));
    }

    /// <summary>Node：<c>Number(body.topK) || 4</c>，随后交给 Array.prototype.slice（ToIntegerOrInfinity）。</summary>
    internal static int ResolveTopK(JsonElement? topK)
    {
        var number = JsValue.ToNumber(topK);
        if (double.IsNaN(number) || number == 0)
        {
            return Bm25Retrieval.DefaultTopK;
        }

        if (double.IsPositiveInfinity(number) || number >= int.MaxValue)
        {
            return int.MaxValue;
        }

        if (double.IsNegativeInfinity(number) || number <= int.MinValue)
        {
            return int.MinValue;
        }

        return (int)Math.Truncate(number);
    }
}
