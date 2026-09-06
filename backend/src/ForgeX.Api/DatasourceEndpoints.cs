using System.Text.Json;
using System.Text.Json.Nodes;
using ForgeX.Analytics;
using ForgeX.Application;
using ForgeX.Contracts;

namespace ForgeX.Api;

/// <summary>Datasources:TtlMs（0 = 永不过期）与 Datasources:MaxPerOwner。</summary>
internal sealed record DatasourceOptions(long TtlMs, int MaxPerOwner)
{
    public const long DefaultTtlMs = 60L * 60 * 1000;
    public const int DefaultMaxPerOwner = 200;
}

/// <summary>
/// Stage 8.6a：数据源端点，server/routes/datasource.js + services/postgres-datasource.js 的 C# 权威腿。
/// 身份来自 CallerContextBoundary；CSV 规范化 / provenance 消毒 / 摘要与 id 派生全部走 JS 语义原语
/// （RawDatasetCsv / DatasetProvenanceSanitizer / JsJson），Node 夹具在 ResourceGate 中逐条锁定。
/// 内置 <c>sample</c> 由代码决定（FarmDataset），不落库。
/// </summary>
internal static class DatasourceEndpoints
{
    /// <summary>Node 路由：CSV 4MB + JSON 包装余量。</summary>
    private const long MaxCreateBodyBytes = 4L * 1024 * 1024 + 64 * 1024;
    private const string SampleId = "sample";
    private const string SampleName = "内置机群仿真数据";

    private static readonly long SampleCreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static readonly Lazy<(JsonElement Rows, string Digest, JsonElement Provenance)> Sample = new(() =>
    {
        var rows = ToRowsElement(FarmDataset.Rows);
        var digest = JsJson.Sha256Hex(FarmDataset.Csv);
        var provenance = ParseElement(JsJson.Stringify(FarmDataset.Provenance));
        return (rows, digest, provenance);
    });

    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/datasources", CreateAsync)
            .WithName("CreateDatasource")
            .ExcludeFromDescription();

        app.MapGet("/api/v1/datasources/{id}", GetAsync)
            .WithName("GetDatasource")
            .ExcludeFromDescription();
    }

    public static async Task<IResult> CreateAsync(HttpContext context, IDatasourceRepository datasources, DatasourceOptions options)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        var body = await EndpointBodies.ReadJsonAsync<DatasourceCreateRequestDto>(context, MaxCreateBodyBytes, "请求体过大");
        if (body.Problem is not null)
        {
            return body.Problem;
        }

        var request = body.Value;
        if (request?.Csv is not { ValueKind: JsonValueKind.String } csvElement ||
            JsValue.Trim(csvElement.GetString() ?? string.Empty).Length == 0)
        {
            return ApiProblemResults.Create(context, 400, "csv_required", "csv 字段不能为空");
        }

        var normalized = RawDatasetCsv.Normalize(csvElement.GetString()!);
        if (normalized.Rows.Count == 0)
        {
            var reason = normalized.Errors.Count > 0 ? normalized.Errors[0] : "无有效数据";
            return ApiProblemResults.Create(context, 400, "csv_invalid", "CSV 解析失败：" + reason);
        }

        var contentSha256 = JsJson.Sha256Hex(normalized.Csv);
        var provenanceJson = JsJson.Stringify(DatasetProvenanceSanitizer.Sanitize(request.Provenance));
        var cacheKey = JsJson.Sha256Hex(contentSha256 + "\0" + provenanceJson);
        var id = "ds_" + JsJson.Sha256Hex(caller.TenantId + "\0" + cacheKey)[..24];
        var name = JsSlice(JsValue.Truthy(request.Name) ? JsValue.ToJsString(request.Name) : "print_jobs.csv", 80);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var candidate = new DatasourceRecord(
            id,
            caller.TenantId,
            caller.OwnerId,
            name,
            normalized.Csv,
            ToRowsElement(normalized.Rows),
            contentSha256,
            cacheKey,
            normalized.Errors,
            ParseElement(provenanceJson),
            now,
            options.TtlMs > 0 ? now + options.TtlMs : null);

        var result = await datasources.CreateOrGetAsync(candidate, context.RequestAborted);
        var record = result.Record;
        var response = new DatasourceCreateResponseDto(
            record.Id,
            record.Name,
            record.Rows.GetArrayLength(),
            record.ContentSha256,
            result.Deduplicated,
            record.Provenance,
            record.Warnings.Count > 0 ? record.Warnings : null);
        return Results.Json(response, statusCode: StatusCodes.Status201Created);
    }

    public static async Task<IResult> GetAsync(HttpContext context, string id, IDatasourceRepository datasources)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        if (id == SampleId)
        {
            var sample = Sample.Value;
            return Results.Json(new DatasourceReadResponseDto(
                SampleId,
                SampleName,
                sample.Rows,
                sample.Digest,
                sample.Digest,
                sample.Provenance,
                Builtin: true,
                Array.Empty<string>(),
                SampleCreatedAt,
                null));
        }

        var record = ResourceIds.IsSafe(id)
            ? await datasources.GetAsync(caller.TenantId, caller.OwnerId, id, context.RequestAborted)
            : null;
        if (record is null)
        {
            return ApiProblemResults.Create(context, 404, "datasource_not_found", "数据源不存在或已过期，请重新上传");
        }

        return Results.Json(new DatasourceReadResponseDto(
            record.Id,
            record.Name,
            record.Rows,
            record.ContentSha256,
            record.CacheKey,
            record.Provenance,
            Builtin: false,
            record.Warnings,
            record.CreatedAt,
            record.ExpiresAt));
    }

    /// <summary>JS String.prototype.slice(0, n)：按 UTF-16 单元截断。</summary>
    internal static string JsSlice(string value, int length) =>
        value.Length <= length ? value : value[..length];

    internal static JsonElement ToRowsElement(IReadOnlyList<RawRow> rows)
    {
        var array = new JsonArray();
        foreach (var row in rows)
        {
            array.Add(row.ToJsonObject());
        }

        return ParseElement(array.ToJsonString());
    }

    internal static JsonElement ParseElement(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
