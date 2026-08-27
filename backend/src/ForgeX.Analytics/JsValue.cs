using System.Globalization;
using System.Text;
using System.Text.Json;

namespace ForgeX.Analytics;

/// <summary>
/// ECMAScript 值语义（Number() 强制转换、String() 转换、trim 字符集、真值判定、
/// 属性键枚举序）在 JSON 值域上的精确实现。Stage 8.3 把 Node 的规则计算腿迁入 C#，
/// 校准包验证器与数据行处理必须与经典 JS 逐分支一致——包括 Number(null)=0、
/// Number([5])=5、"0x10"→16、整数样键优先枚举这类边角语义，否则错误信息
/// 或分组顺序会在双跑对比中漂移。JSON 值域没有 undefined/Symbol/函数，
/// 因此这里只覆盖 object/array/string/number/boolean/null 六类。
/// </summary>
public static class JsValue
{
    /// <summary>JS String.prototype.trim 的字符集：WhiteSpace ∪ LineTerminator（含 \uFEFF 与 Zs 类）。</summary>
    public static bool IsJsWhiteSpace(char c) => c switch
    {
        '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00A0' or '\uFEFF' or '\u2028' or '\u2029' => true,
        _ => char.GetUnicodeCategory(c) == System.Globalization.UnicodeCategory.SpaceSeparator,
    };

    /// <summary>JS String.prototype.trim。与 .NET Trim 的差异：\uFEFF 会被去除，\u0085 不会。</summary>
    public static string Trim(string value)
    {
        var start = 0;
        var end = value.Length;
        while (start < end && IsJsWhiteSpace(value[start])) start++;
        while (end > start && IsJsWhiteSpace(value[end - 1])) end--;
        return value[start..end];
    }

    /// <summary>JS Number(string)。空白串→0；支持 Infinity、0x/0o/0b 前缀；其余按严格数字文法，失败→NaN。</summary>
    public static double StringToNumber(string text)
    {
        var trimmed = Trim(text);
        if (trimmed.Length == 0) return 0;

        if (trimmed is "Infinity" or "+Infinity") return double.PositiveInfinity;
        if (trimmed == "-Infinity") return double.NegativeInfinity;

        if (trimmed.Length > 2 && trimmed[0] == '0')
        {
            var radix = trimmed[1] switch
            {
                'x' or 'X' => 16,
                'o' or 'O' => 8,
                'b' or 'B' => 2,
                _ => 0,
            };
            if (radix != 0) return ParseRadix(trimmed.AsSpan(2), radix);
        }

        // StrDecimalLiteral：可选符号 + (数字[.数字] | .数字) + 可选指数
        if (!IsStrictDecimal(trimmed)) return double.NaN;
        return double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : double.NaN;
    }

    private static double ParseRadix(ReadOnlySpan<char> digits, int radix)
    {
        if (digits.Length == 0) return double.NaN;
        double value = 0;
        foreach (var c in digits)
        {
            var digit = c switch
            {
                >= '0' and <= '9' => c - '0',
                >= 'a' and <= 'f' => c - 'a' + 10,
                >= 'A' and <= 'F' => c - 'A' + 10,
                _ => -1,
            };
            if (digit < 0 || digit >= radix) return double.NaN;
            value = value * radix + digit;
        }
        return value;
    }

    private static bool IsStrictDecimal(string s)
    {
        var i = 0;
        if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
        var intDigits = 0;
        while (i < s.Length && char.IsAsciiDigit(s[i])) { i++; intDigits++; }
        var fracDigits = 0;
        if (i < s.Length && s[i] == '.')
        {
            i++;
            while (i < s.Length && char.IsAsciiDigit(s[i])) { i++; fracDigits++; }
        }
        if (intDigits == 0 && fracDigits == 0) return false;
        if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
        {
            i++;
            if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
            var expDigits = 0;
            while (i < s.Length && char.IsAsciiDigit(s[i])) { i++; expDigits++; }
            if (expDigits == 0) return false;
        }
        return i == s.Length;
    }

    /// <summary>JS Number(value) 对 JSON 值域的强制转换。absent（C# null）→ NaN（undefined 语义）。</summary>
    public static double ToNumber(JsonElement? value)
    {
        if (value is null) return double.NaN;
        var element = value.Value;
        return element.ValueKind switch
        {
            JsonValueKind.Number => element.GetDouble(),
            JsonValueKind.String => StringToNumber(element.GetString() ?? string.Empty),
            JsonValueKind.True => 1,
            JsonValueKind.False => 0,
            JsonValueKind.Null => 0,
            JsonValueKind.Array => StringToNumber(JoinArray(element)),
            _ => double.NaN, // object → ToPrimitive 得 "[object Object]" → NaN
        };
    }

    /// <summary>JS String(value) 对 JSON 值域的转换（数组按 join(",")，null 元素→空串）。</summary>
    public static string ToJsString(JsonElement? value)
    {
        if (value is null) return "undefined";
        var element = value.Value;
        return element.ValueKind switch
        {
            JsonValueKind.String => element.GetString() ?? string.Empty,
            JsonValueKind.Number => JsFormat.Number(element.GetDouble()),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Null => "null",
            JsonValueKind.Array => JoinArray(element),
            _ => "[object Object]",
        };
    }

    private static string JoinArray(JsonElement array)
    {
        var builder = new StringBuilder();
        var first = true;
        foreach (var item in array.EnumerateArray())
        {
            if (!first) builder.Append(',');
            first = false;
            if (item.ValueKind is JsonValueKind.Null) continue; // Array.prototype.join：null → ""
            builder.Append(ToJsString(item));
        }
        return builder.ToString();
    }

    /// <summary>JS 真值判定。absent/null/false/0/NaN/"" 为假；对象与数组恒真。</summary>
    public static bool Truthy(JsonElement? value)
    {
        if (value is null) return false;
        var element = value.Value;
        return element.ValueKind switch
        {
            JsonValueKind.Null or JsonValueKind.False => false,
            JsonValueKind.True or JsonValueKind.Object or JsonValueKind.Array => true,
            JsonValueKind.String => (element.GetString() ?? string.Empty).Length > 0,
            JsonValueKind.Number => element.GetDouble() is var n && !double.IsNaN(n) && n != 0,
            _ => false,
        };
    }

    /// <summary>JS Number.isInteger：只有 number 类型且为有限整数才为真。</summary>
    public static bool IsInteger(JsonElement? value)
    {
        if (value is null || value.Value.ValueKind != JsonValueKind.Number) return false;
        var n = value.Value.GetDouble();
        return double.IsFinite(n) && Math.Floor(n) == n;
    }

    /// <summary>
    /// JS 对象属性枚举序：整数样键（canonical array index）按数值升序在前，其余按插入序。
    /// JSON.parse 与对象字面量都遵循此序——分组、未知字段报错的顺序都由它决定。
    /// </summary>
    public static List<string> OrderKeys(IEnumerable<string> insertionOrdered)
    {
        var integerKeys = new List<(string Key, uint Value)>();
        var stringKeys = new List<string>();
        foreach (var key in insertionOrdered)
        {
            if (IsArrayIndex(key, out var numeric)) integerKeys.Add((key, numeric));
            else stringKeys.Add(key);
        }
        integerKeys.Sort(static (a, b) => a.Value.CompareTo(b.Value));
        var ordered = new List<string>(integerKeys.Count + stringKeys.Count);
        ordered.AddRange(integerKeys.Select(static item => item.Key));
        ordered.AddRange(stringKeys);
        return ordered;
    }

    private static bool IsArrayIndex(string key, out uint value)
    {
        value = 0;
        if (key.Length == 0 || key.Length > 10) return false;
        if (key[0] == '0' && key.Length > 1) return false;
        foreach (var c in key)
        {
            if (!char.IsAsciiDigit(c)) return false;
        }
        return ulong.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) &&
            parsed < 4294967295 && (value = (uint)parsed) == parsed;
    }

    /// <summary>JS parseFloat：取前缀里最长合法十进制（含 Infinity），无则 NaN。</summary>
    public static double ParseFloat(string text)
    {
        var trimmed = Trim(text);
        var length = 0;
        var i = 0;
        if (i < trimmed.Length && (trimmed[i] == '+' || trimmed[i] == '-')) i++;
        if (trimmed.AsSpan(i).StartsWith("Infinity", StringComparison.Ordinal))
        {
            return trimmed[0] == '-' ? double.NegativeInfinity : double.PositiveInfinity;
        }
        var digits = 0;
        while (i < trimmed.Length && char.IsAsciiDigit(trimmed[i])) { i++; digits++; }
        if (i < trimmed.Length && trimmed[i] == '.')
        {
            i++;
            while (i < trimmed.Length && char.IsAsciiDigit(trimmed[i])) { i++; digits++; }
        }
        if (digits == 0) return double.NaN;
        length = i;
        if (i < trimmed.Length && (trimmed[i] == 'e' || trimmed[i] == 'E'))
        {
            var j = i + 1;
            if (j < trimmed.Length && (trimmed[j] == '+' || trimmed[j] == '-')) j++;
            var expDigits = 0;
            while (j < trimmed.Length && char.IsAsciiDigit(trimmed[j])) { j++; expDigits++; }
            if (expDigits > 0) length = j;
        }
        return double.Parse(trimmed[..length], NumberStyles.Float, CultureInfo.InvariantCulture);
    }
}
