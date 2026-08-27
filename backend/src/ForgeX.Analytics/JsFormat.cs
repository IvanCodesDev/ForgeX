using System.Globalization;
using System.Numerics;

namespace ForgeX.Analytics;

/// <summary>
/// ECMA-262 数字→字符串语义的精确实现。Stage 8.3 把 Node 的规则计算腿迁入 C#，
/// 其中数据源规范化 CSV 会被调用方做 SHA-256 去重、统计简报文本会被金样对比——
/// 两者都要求与经典 JS 的 String(number) / Number.prototype.toFixed 逐字节一致，
/// 而 .NET 默认格式化在科学计数阈值（1e-7 vs 1e21）、指数写法（E+07 vs e-7）
/// 与 toFixed 平局取舍（banker's vs 取较大 n）上均有差异，因此单独实现。
/// </summary>
public static class JsFormat
{
    /// <summary>ECMA-262 Number::toString(10)。</summary>
    public static string Number(double value)
    {
        if (double.IsNaN(value)) return "NaN";
        if (value == 0) return "0"; // 含 -0：JS String(-0) === "0"
        if (double.IsPositiveInfinity(value)) return "Infinity";
        if (double.IsNegativeInfinity(value)) return "-Infinity";
        if (value < 0) return "-" + Number(-value);

        var (digits, n) = ShortestDigits(value);
        var k = digits.Length;

        if (k <= n && n <= 21)
        {
            return digits + new string('0', n - k);
        }
        if (n is > 0 and <= 21)
        {
            return digits[..n] + "." + digits[n..];
        }
        if (n is > -6 and <= 0)
        {
            return "0." + new string('0', -n) + digits;
        }
        var exponent = n - 1;
        var mantissa = k == 1 ? digits : digits[..1] + "." + digits[1..];
        return mantissa + "e" + (exponent >= 0 ? "+" : "-") +
            Math.Abs(exponent).ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// ECMA-262 Number.prototype.toFixed(fractionDigits)。
    /// 与 .NET "F" 格式的差别在平局：规范先把负号剥离（x&lt;0 → x=-x 再选 n），
    /// 对 |x| 平局取较大 n——因此正负数的平局都**远离零**进位：
    /// (0.125).toFixed(2)="0.13"，(-0.125).toFixed(2)="-0.13"（V8 实测一致）。
    /// </summary>
    public static string ToFixed(double value, int fractionDigits)
    {
        if (fractionDigits is < 0 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(fractionDigits));
        }
        if (double.IsNaN(value)) return "NaN";
        if (Math.Abs(value) >= 1e21 || double.IsInfinity(value)) return Number(value);

        var negative = value < 0; // -0 不算负，输出无符号
        var sign = negative ? "-" : string.Empty;
        var scaled = ScaleToInteger(Math.Abs(value), fractionDigits, roundTieUp: true);

        var text = scaled.ToString(CultureInfo.InvariantCulture);
        if (fractionDigits == 0) return sign + text;
        if (text.Length <= fractionDigits)
        {
            text = new string('0', fractionDigits - text.Length + 1) + text;
        }
        return sign + text[..^fractionDigits] + "." + text[^fractionDigits..];
    }

    /// <summary>round(|x| × 10^f)，平局按 roundTieUp 决定进位或舍去。基于精确二进制值。</summary>
    private static BigInteger ScaleToInteger(double magnitude, int fractionDigits, bool roundTieUp)
    {
        var bits = BitConverter.DoubleToInt64Bits(magnitude);
        var biasedExponent = (int)((bits >> 52) & 0x7FF);
        var mantissaBits = bits & 0xF_FFFF_FFFF_FFFF;
        BigInteger mantissa;
        int exponent;
        if (biasedExponent == 0)
        {
            mantissa = mantissaBits;
            exponent = -1074;
        }
        else
        {
            mantissa = mantissaBits | (1L << 52);
            exponent = biasedExponent - 1075;
        }

        var pow10 = BigInteger.Pow(10, fractionDigits);
        if (exponent >= 0)
        {
            return mantissa * BigInteger.Pow(2, exponent) * pow10; // 精确整数，无平局
        }

        var numerator = mantissa * pow10;
        var denominator = BigInteger.Pow(2, -exponent);
        var quotient = BigInteger.DivRem(numerator, denominator, out var remainder);
        var doubled = remainder * 2;
        var compare = doubled.CompareTo(denominator);
        if (compare > 0 || (compare == 0 && roundTieUp)) quotient += 1;
        return quotient;
    }

    /// <summary>
    /// 最短往返十进制表示 → (数字串, n)。值 = digits × 10^(n-k)，k 为位数。
    /// 复用 .NET 的最短往返格式化（"R"，.NET Core 3.0+ 与 V8 同为最短表示），只重排记法。
    /// </summary>
    private static (string Digits, int N) ShortestDigits(double value)
    {
        var repr = value.ToString("R", CultureInfo.InvariantCulture);
        var exponent = 0;
        var indexOfE = repr.IndexOf('E');
        if (indexOfE >= 0)
        {
            exponent = int.Parse(repr[(indexOfE + 1)..], CultureInfo.InvariantCulture);
            repr = repr[..indexOfE];
        }

        var pointIndex = repr.IndexOf('.');
        string digits;
        int integerLength;
        if (pointIndex >= 0)
        {
            digits = repr[..pointIndex] + repr[(pointIndex + 1)..];
            integerLength = pointIndex;
        }
        else
        {
            digits = repr;
            integerLength = repr.Length;
        }

        var leadingZeros = 0;
        while (leadingZeros < digits.Length - 1 && digits[leadingZeros] == '0') leadingZeros++;
        digits = digits[leadingZeros..];
        integerLength -= leadingZeros;

        var n = integerLength + exponent;
        var trimmed = digits.TrimEnd('0');
        if (trimmed.Length == 0) trimmed = "0";
        return (trimmed, n);
    }

    /// <summary>JS Math.round：floor(x + 0.5)，负数平局向 +∞。</summary>
    public static double Round(double value) => Math.Floor(value + 0.5);

    /// <summary>拼接 CSV 单元格文本：JS String(v)，null → 空串。</summary>
    public static string Cell(object? value) => value switch
    {
        null => string.Empty,
        double number => Number(number),
        string text => text,
        bool boolean => boolean ? "true" : "false",
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty,
    };
}
