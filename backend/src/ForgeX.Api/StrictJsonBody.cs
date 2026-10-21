using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.Features;

namespace ForgeX.Api;

/// <summary>Bounded JSON reader rejecting duplicate keys, coercion and ambiguous property casing.</summary>
internal static class StrictJsonBody
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        NumberHandling = JsonNumberHandling.Strict,
        MaxDepth = 16,
    };

    public static async Task<T> ReadAsync<T>(HttpContext context, int maxBytes)
    {
        if (context.Request.ContentLength > maxBytes) throw new BadHttpRequestException("JSON body too large", 413);
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } feature) feature.MaxRequestBodySize = maxBytes;
        using var body = new MemoryStream();
        var chunk = new byte[4096];
        int count;
        while ((count = await context.Request.Body.ReadAsync(chunk, context.RequestAborted)) != 0)
        {
            if (body.Length + count > maxBytes) throw new BadHttpRequestException("JSON body too large", 413);
            body.Write(chunk, 0, count);
        }
        using var document = JsonDocument.Parse(body.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
        CheckKeys(document.RootElement);
        return document.RootElement.Deserialize<T>(Options) ?? throw new JsonException("Missing JSON object");
    }

    private static void CheckKeys(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                if (!keys.Add(property.Name)) throw new JsonException("Duplicate JSON property");
                CheckKeys(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray()) CheckKeys(item);
    }
}
