using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ForgeX.Analytics;

/// <summary>
/// ECMAScript <c>JSON.stringify</c> 与 Node <c>calibration.js</c> 里 <c>stable()</c> 的逐字节等价实现。
/// 数据源 cacheKey、校准包 digest 都是对这两种文本做 sha256——序列化输出差一个字符，
/// Node 与 C# 就会对同一份数据算出不同身份。System.Text.Json 默认转义非 ASCII 与
/// <c>&lt;&gt;&amp;'+</c>、控制字符十六进制大小写亦不同，因此这里不用它输出，而是手写。
/// 规则：字符串按 ES2019 well-formed JSON.stringify 转义（短转义 + 小写 \uXXXX，孤立代理项也转义）；
/// 数字走 <see cref="JsFormat.Number"/>（Number::toString）；对象键按 JS 属性枚举序
/// （整数样键升序在前，其余插入序），重复键取最后一个值、保留首次出现的位置。
/// </summary>
public static class JsJson
{
    /// <summary>JSON.stringify(value)：紧凑输出，键按 JS 属性枚举序。</summary>
    public static string Stringify(JsonElement value)
    {
        var builder = new StringBuilder();
        Write(builder, value, sorted: false);
        return builder.ToString();
    }

    /// <summary>calibration.js stable(value)：对象键按 UTF-16 序数排序（JS 默认 sort()）后递归。</summary>
    public static string Stable(JsonElement value)
    {
        var builder = new StringBuilder();
        Write(builder, value, sorted: true);
        return builder.ToString();
    }

    /// <summary>
    /// 数据来源标记的 JSON.stringify：键序 source, synthetic, badge, note, generator 与经典对象字面量一致，
    /// generator 为 null 时输出 null，否则 {name, version, seed}（seed 为 null 也输出键）。
    /// </summary>
    public static string Stringify(DatasetProvenance value)
    {
        var builder = new StringBuilder(160);
        builder.Append("{\"source\":");
        AppendEscaped(builder, value.Source);
        builder.Append(",\"synthetic\":").Append(value.Synthetic ? "true" : "false");
        builder.Append(",\"badge\":");
        AppendEscaped(builder, value.Badge);
        builder.Append(",\"note\":");
        AppendEscaped(builder, value.Note);
        builder.Append(",\"generator\":");
        if (value.Generator is null)
        {
            builder.Append("null");
        }
        else
        {
            builder.Append("{\"name\":");
            AppendEscaped(builder, value.Generator.Name);
            builder.Append(",\"version\":").Append(value.Generator.Version.ToString(CultureInfo.InvariantCulture));
            builder.Append(",\"seed\":");
            builder.Append(value.Generator.Seed is { } seed ? JsFormat.Number(seed) : "null");
            builder.Append('}');
        }
        builder.Append('}');
        return builder.ToString();
    }

    /// <summary>JSON.stringify(string)：含首尾双引号。</summary>
    public static string EscapeString(string value)
    {
        var builder = new StringBuilder(value.Length + 2);
        AppendEscaped(builder, value);
        return builder.ToString();
    }

    /// <summary>sha256(utf8(text)) 小写 hex。孤立代理项与 Node 一致编码为 U+FFFD。</summary>
    public static string Sha256Hex(string text) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    private static void Write(StringBuilder builder, JsonElement value, bool sorted)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Null:
                builder.Append("null");
                break;
            case JsonValueKind.True:
                builder.Append("true");
                break;
            case JsonValueKind.False:
                builder.Append("false");
                break;
            case JsonValueKind.Number:
                // JSON.parse 已把数字读成 double；JSON.stringify 再按 Number::toString 输出。
                var number = value.GetDouble();
                builder.Append(double.IsFinite(number) ? JsFormat.Number(number) : "null");
                break;
            case JsonValueKind.String:
                AppendEscaped(builder, value.GetString() ?? string.Empty);
                break;
            case JsonValueKind.Array:
                builder.Append('[');
                var firstItem = true;
                foreach (var item in value.EnumerateArray())
                {
                    if (!firstItem) builder.Append(',');
                    firstItem = false;
                    Write(builder, item, sorted);
                }
                builder.Append(']');
                break;
            case JsonValueKind.Object:
                WriteObject(builder, value, sorted);
                break;
            default:
                throw new ArgumentException("JSON.stringify(undefined) has no serialized form.", nameof(value));
        }
    }

    private static void WriteObject(StringBuilder builder, JsonElement value, bool sorted)
    {
        // JSON.parse 的重复键：值取最后一个，位置保留首次出现。
        var firstSeen = new List<string>();
        var last = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
        {
            if (!last.ContainsKey(property.Name)) firstSeen.Add(property.Name);
            last[property.Name] = property.Value;
        }

        IEnumerable<string> keys = sorted
            ? firstSeen.OrderBy(static key => key, StringComparer.Ordinal)
            : JsValue.OrderKeys(firstSeen);

        builder.Append('{');
        var first = true;
        foreach (var key in keys)
        {
            if (!first) builder.Append(',');
            first = false;
            AppendEscaped(builder, key);
            builder.Append(':');
            Write(builder, last[key], sorted);
        }
        builder.Append('}');
    }

    private static void AppendEscaped(StringBuilder builder, string value)
    {
        builder.Append('"');
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            switch (character)
            {
                case '"':
                    builder.Append("\\\"");
                    continue;
                case '\\':
                    builder.Append("\\\\");
                    continue;
                case '\b':
                    builder.Append("\\b");
                    continue;
                case '\f':
                    builder.Append("\\f");
                    continue;
                case '\n':
                    builder.Append("\\n");
                    continue;
                case '\r':
                    builder.Append("\\r");
                    continue;
                case '\t':
                    builder.Append("\\t");
                    continue;
            }

            if (character < 0x20)
            {
                AppendUnicodeEscape(builder, character);
                continue;
            }

            if (char.IsHighSurrogate(character))
            {
                if (index + 1 < value.Length && char.IsLowSurrogate(value[index + 1]))
                {
                    builder.Append(character).Append(value[index + 1]);
                    index++;
                }
                else
                {
                    AppendUnicodeEscape(builder, character);
                }
                continue;
            }

            if (char.IsLowSurrogate(character))
            {
                AppendUnicodeEscape(builder, character);
                continue;
            }

            builder.Append(character);
        }
        builder.Append('"');
    }

    private static void AppendUnicodeEscape(StringBuilder builder, char character) =>
        builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
}
