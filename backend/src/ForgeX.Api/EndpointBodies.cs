using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;

namespace ForgeX.Api;

/// <summary>
/// 资源端点共用的请求体读取：按端点收紧 Kestrel 的最大请求体（早于全局 64 MiB 上限），
/// 并把 JSON 解析失败 / 超限统一映射为 problem+json，语义与 Node 侧 readJson() 对齐。
/// </summary>
internal static class EndpointBodies
{
    private static readonly JsonSerializerOptions WebOptions = new(JsonSerializerDefaults.Web);

    public static Stream Limited(HttpContext context, long maxBytes)
    {
        var feature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (feature is { IsReadOnly: false })
        {
            feature.MaxRequestBodySize = maxBytes;
        }

        return context.Request.Body;
    }

    public readonly record struct BodyRead<T>(T? Value, IResult? Problem);

    /// <summary>
    /// Reads and deserialises the body as <typeparamref name="T"/>. Returns a 413 problem when the declared
    /// or streamed size exceeds <paramref name="maxBytes"/>, and a 400 <c>invalid_json</c> problem on malformed JSON.
    /// </summary>
    public static async Task<BodyRead<T>> ReadJsonAsync<T>(
        HttpContext context,
        long maxBytes,
        string tooLargeTitle)
        where T : class
    {
        if (context.Request.ContentLength is > 0 && context.Request.ContentLength > maxBytes)
        {
            return new BodyRead<T>(null, ApiProblemResults.Create(context, 413, "payload_too_large", tooLargeTitle));
        }

        try
        {
            var value = await JsonSerializer.DeserializeAsync<T>(
                Limited(context, maxBytes),
                WebOptions,
                context.RequestAborted);
            return new BodyRead<T>(value, null);
        }
        catch (JsonException)
        {
            return new BodyRead<T>(null, ApiProblemResults.Create(context, 400, "invalid_json", "Request body must be valid JSON"));
        }
        catch (InvalidDataException)
        {
            return new BodyRead<T>(null, ApiProblemResults.Create(context, 413, "payload_too_large", tooLargeTitle));
        }
        catch (BadHttpRequestException exception) when (exception.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            return new BodyRead<T>(null, ApiProblemResults.Create(context, 413, "payload_too_large", tooLargeTitle));
        }
    }
}
