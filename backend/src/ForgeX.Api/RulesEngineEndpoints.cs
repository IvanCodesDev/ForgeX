using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using ForgeX.Analytics;
using ForgeX.Analytics.Calibration;
using ForgeX.Contracts;
using Microsoft.AspNetCore.Http.Features;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.3：Node 本地规则计算腿的 C# 接管端点——数据集规范化、内置 farm 数据集、
/// 数据契约元信息、统计简报、校准包验证。全部为无状态纯计算（与 analytics/reports、
/// calibration/train 同类），不进 CallerContext 边界，也不进公开 OpenAPI 文档
/// （Node 迁移期内部调用，先例见 Stage 8.1 的 shares / analysis-tasks）。
/// </summary>
internal static class RulesEngineEndpoints
{
    internal const long MaxDatasetRequestBytes = 5L * 1024 * 1024;
    internal const long MaxCalibrationRequestBytes = 2L * 1024 * 1024 + 64 * 1024;
    internal const int MaxBriefRows = 5000;

    // 数值必须以 null 形态输出（generator:null / seed:null / trend:null…），
    // Node 侧对 provenance 做 JSON.stringify 卷进 cacheKey，键的存在性是契约的一部分。
    private static readonly JsonSerializerOptions ResponseJsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private static AnalyticsAuthorityEngineDto Engine { get; } =
        new("forgex-analytics-csharp", AnalyticsEndpoints.EngineVersion);

    public static IResult Meta(HttpContext context)
    {
        _ = context;
        return Results.Json(
            new DatasetMetaResponseDto(
                "1.0",
                Engine,
                RawDatasetCsv.Fields,
                DatasetCatalog.MinSample,
                DatasetCatalog.All),
            ResponseJsonOptions);
    }

    public static IResult Farm(HttpContext context)
    {
        _ = context;
        return Results.Json(
            new DatasetFarmResponseDto(
                "1.0",
                Engine,
                FarmDataset.Csv,
                ToJsonRows(FarmDataset.Rows),
                DatasetCatalog.Farm),
            ResponseJsonOptions);
    }

    public static async Task<IResult> NormalizeAsync(HttpContext context)
    {
        var (request, problem) = await ReadJsonBodyAsync<DatasetNormalizeRequestDto>(
            context, MaxDatasetRequestBytes, "dataset");
        if (problem is not null) return problem;

        if (!string.Equals(request?.SchemaVersion, "1.0", StringComparison.Ordinal))
        {
            return InvalidRequest(context, "dataset", "schemaVersion must be '1.0'.");
        }
        if (request?.CsvText is not { } csvText)
        {
            return InvalidRequest(context, "dataset", "csvText must be a string.");
        }

        var normalized = RawDatasetCsv.Normalize(csvText);
        return Results.Json(
            new DatasetNormalizeResponseDto(
                "1.0",
                Engine,
                ToJsonRows(normalized.Rows),
                normalized.Errors,
                normalized.Csv),
            ResponseJsonOptions);
    }

    public static async Task<IResult> BriefAsync(HttpContext context)
    {
        var (request, problem) = await ReadJsonBodyAsync<AnalyticsBriefRequestDto>(
            context, MaxDatasetRequestBytes, "brief");
        if (problem is not null) return problem;

        if (!string.Equals(request?.SchemaVersion, "1.0", StringComparison.Ordinal))
        {
            return InvalidRequest(context, "brief", "schemaVersion must be '1.0'.");
        }
        if (request?.Rows is not { ValueKind: JsonValueKind.Array } rowsElement)
        {
            return InvalidRequest(context, "brief", "rows must be an array.");
        }
        var count = rowsElement.GetArrayLength();
        if (count is < 1 or > MaxBriefRows)
        {
            return InvalidRequest(context, "brief", $"rows must contain 1 to {MaxBriefRows} items.");
        }

        var rows = new List<RawRow>(count);
        var index = 0;
        foreach (var element in rowsElement.EnumerateArray())
        {
            try
            {
                rows.Add(RawRow.FromJson(element));
            }
            catch (FormatException exception)
            {
                return InvalidRequest(context, "brief", $"rows[{index}]: {exception.Message}");
            }
            index++;
        }

        var brief = AnalyticsBriefEngine.Build(rows);
        return Results.Json(
            new AnalyticsBriefResponseDto("1.0", Engine, brief.Text, brief.Facts),
            ResponseJsonOptions);
    }

    public static async Task<IResult> ValidateCalibrationAsync(HttpContext context)
    {
        var (request, problem) = await ReadJsonBodyAsync<CalibrationValidateRequestDto>(
            context, MaxCalibrationRequestBytes, "calibration");
        if (problem is not null) return problem;

        if (!string.Equals(request?.SchemaVersion, "1.0", StringComparison.Ordinal))
        {
            return InvalidRequest(context, "calibration", "schemaVersion must be '1.0'.");
        }

        var validation = CalibrationBundleValidator.Validate(request?.Bundle);
        return Results.Json(
            new CalibrationValidateResponseDto("1.0", Engine, validation.Ok, validation.Errors),
            ResponseJsonOptions);
    }

    private static List<JsonObject> ToJsonRows(IReadOnlyList<RawRow> rows) =>
        [.. rows.Select(static row => row.ToJsonObject())];

    private static async Task<(T? Request, IResult? Problem)> ReadJsonBodyAsync<T>(
        HttpContext context,
        long maxBytes,
        string scope)
        where T : class
    {
        var mediaType = context.Request.ContentType?.Split(';', 2)[0].Trim();
        if (!string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase))
        {
            return (null, ApiProblemResults.Create(
                context,
                StatusCodes.Status415UnsupportedMediaType,
                "unsupported_media_type",
                "Unsupported media type",
                "Use Content-Type: application/json."));
        }
        if (context.Request.ContentLength is { } length && length > maxBytes)
        {
            return (null, PayloadTooLarge(context, scope, maxBytes));
        }
        var maxBodySizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (maxBodySizeFeature is { IsReadOnly: false })
        {
            maxBodySizeFeature.MaxRequestBodySize = maxBytes;
        }

        try
        {
            var request = await context.Request.ReadFromJsonAsync<T>(cancellationToken: context.RequestAborted);
            return (request, null);
        }
        catch (JsonException exception)
        {
            return (null, ApiProblemResults.Create(
                context,
                StatusCodes.Status400BadRequest,
                $"invalid_{scope}_json",
                "Request JSON is invalid",
                exception.Message));
        }
        catch (BadHttpRequestException exception)
        {
            return (null, exception.StatusCode == StatusCodes.Status413PayloadTooLarge
                ? PayloadTooLarge(context, scope, maxBytes)
                : ApiProblemResults.Create(
                    context,
                    exception.StatusCode,
                    $"invalid_{scope}_request",
                    "Request is invalid",
                    exception.Message));
        }
    }

    private static IResult PayloadTooLarge(HttpContext context, string scope, long maxBytes) =>
        ApiProblemResults.Create(
            context,
            StatusCodes.Status413PayloadTooLarge,
            $"{scope}_payload_too_large",
            "Request payload is too large",
            $"The request body limit is {maxBytes} bytes.");

    private static IResult InvalidRequest(HttpContext context, string scope, string detail) =>
        ApiProblemResults.Create(
            context,
            StatusCodes.Status400BadRequest,
            $"invalid_{scope}_request",
            "Request is invalid",
            detail);
}
