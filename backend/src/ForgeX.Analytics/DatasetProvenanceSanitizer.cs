using System.Text.Json;

namespace ForgeX.Analytics;

/// <summary>
/// server/services/datasource.js <c>DatasourceStore.sanitizeProvenance(claim, catalog)</c> 的移植：
/// 客户端只能把数据来源标得更谨慎，不能更宽松。已知的合成来源原样采用；未知来源但
/// 严格声明 <c>synthetic === true</c> 时标为 client-declared-synthetic；其余一律按用户上传处理。
/// </summary>
public static class DatasetProvenanceSanitizer
{
    public const string ClientDeclaredSource = "client-declared-synthetic";
    public const string ClientDeclaredNote = "客户端声明为合成/仿真数据，非真实产线数据。";
    private const int MaxBadgeLength = 8;

    public static DatasetProvenance Sanitize(JsonElement? claim)
    {
        var fallback = DatasetCatalog.Upload;
        if (claim is not { ValueKind: JsonValueKind.Object } element) return fallback;

        if (element.TryGetProperty("source", out var source) &&
            source.ValueKind == JsonValueKind.String &&
            DatasetCatalog.All.TryGetValue(source.GetString()!, out var known) &&
            known.Synthetic)
        {
            return known;
        }

        if (element.TryGetProperty("synthetic", out var synthetic) && synthetic.ValueKind == JsonValueKind.True)
        {
            // String(claim.badge || "合成").slice(0, 8)：真值判定 + String() 转换 + UTF-16 截断
            var badge = element.TryGetProperty("badge", out var claimedBadge) && JsValue.Truthy(claimedBadge)
                ? JsValue.ToJsString(claimedBadge)
                : "合成";
            if (badge.Length > MaxBadgeLength) badge = badge[..MaxBadgeLength];
            return new DatasetProvenance(ClientDeclaredSource, true, badge, ClientDeclaredNote, null);
        }

        return fallback;
    }
}
