namespace ForgeX.Analytics;

/// <summary>
/// Date.parse 的可解析性判定与毫秒值计算。覆盖 ECMA-262 Date Time String Format 全文法
/// （含扩展年份、"2026-07" 月精度、T24:00、时区偏移）以及 V8 常见的两类遗留格式
/// （斜杠日期、英文月名）。超出此范围的 V8 私有宽松解析不做承诺——校准包契约
/// 与数据集日期都使用 ISO 形态，双跑对比语料也以此为边界。
/// </summary>
public static class JsDate
{
    private static readonly string[] MonthNames =
    [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december",
    ];

    /// <summary>Date.parse(text) 的时间值；无法解析 → NaN。仅承诺 ISO/常见遗留格式。</summary>
    public static double Parse(string text)
    {
        if (TryParseIso(text, out var iso)) return iso;
        if (TryParseLegacy(text, out var legacy)) return legacy;
        return double.NaN;
    }

    public static bool IsParsable(string text) => double.IsFinite(Parse(text));

    private static bool TryParseIso(string text, out double milliseconds)
    {
        milliseconds = double.NaN;
        var s = text;
        var i = 0;

        // 年：YYYY 或 ±YYYYYY（扩展年份）
        int year;
        if (i < s.Length && (s[i] == '+' || s[i] == '-'))
        {
            var sign = s[i] == '-' ? -1 : 1;
            i++;
            if (!TakeDigits(s, ref i, 6, out var absYear)) return false;
            year = sign * absYear;
            if (sign == -1 && absYear == 0) return false; // -000000 非法
        }
        else
        {
            if (!TakeDigits(s, ref i, 4, out year)) return false;
        }

        var month = 1;
        var day = 1;
        if (i < s.Length && s[i] == '-')
        {
            i++;
            if (!TakeDigits(s, ref i, 2, out month)) return false;
            if (month is < 1 or > 12) return false;
            if (i < s.Length && s[i] == '-')
            {
                i++;
                if (!TakeDigits(s, ref i, 2, out day)) return false;
                if (day < 1 || day > DaysInMonth(year, month)) return false;
            }
        }

        double hour = 0, minute = 0, second = 0, fraction = 0;
        var hasTime = false;
        if (i < s.Length && s[i] == 'T')
        {
            hasTime = true;
            i++;
            if (!TakeDigits(s, ref i, 2, out var h)) return false;
            if (i >= s.Length || s[i] != ':') return false;
            i++;
            if (!TakeDigits(s, ref i, 2, out var m)) return false;
            if (h > 24 || m > 59) return false;
            hour = h;
            minute = m;
            if (i < s.Length && s[i] == ':')
            {
                i++;
                if (!TakeDigits(s, ref i, 2, out var sec)) return false;
                if (sec > 59) return false;
                second = sec;
                if (i < s.Length && s[i] == '.')
                {
                    i++;
                    var start = i;
                    while (i < s.Length && char.IsAsciiDigit(s[i])) i++;
                    if (i == start) return false;
                    // 只有前三位进入毫秒（V8 截断而非四舍五入）
                    var digits = s[start..Math.Min(i, start + 3)].PadRight(3, '0');
                    fraction = int.Parse(digits, System.Globalization.CultureInfo.InvariantCulture);
                }
            }
            if (hour == 24 && (minute != 0 || second != 0 || fraction != 0)) return false;
        }

        double offsetMinutes = 0;
        var hasOffset = false;
        if (i < s.Length && hasTime is false && s[i] is 'Z' or '+' or '-')
        {
            return false; // 无时间部分不允许时区
        }
        if (i < s.Length)
        {
            if (s[i] == 'Z')
            {
                i++;
                hasOffset = true;
            }
            else if (s[i] is '+' or '-')
            {
                var sign = s[i] == '-' ? -1 : 1;
                i++;
                if (!TakeDigits(s, ref i, 2, out var oh)) return false;
                if (i >= s.Length || s[i] != ':') return false;
                i++;
                if (!TakeDigits(s, ref i, 2, out var om)) return false;
                if (oh > 23 || om > 59) return false;
                offsetMinutes = sign * (oh * 60 + om);
                hasOffset = true;
            }
        }
        if (i != s.Length) return false;

        var days = DayNumber(year, month, day);
        var timeMs = ((hour * 60 + minute) * 60 + second) * 1000 + fraction;
        var utcMs = days * 86400000d + timeMs - offsetMinutes * 60000d;
        // 无偏移的日期时间按本地时间——有效性不受影响，取值本判定不承诺（用 UTC 近似）。
        _ = hasOffset;
        if (Math.Abs(utcMs) > 8.64e15) return false; // ECMA 时间值范围
        milliseconds = utcMs;
        return true;
    }

    private static bool TryParseLegacy(string text, out double milliseconds)
    {
        milliseconds = double.NaN;
        var s = JsValue.Trim(text);
        if (s.Length == 0) return false;
        // V8 对带空白的 ISO 串会经宽松路径解析成功；trim 后重试 ISO 覆盖此形态。
        if (s.Length != text.Length && TryParseIso(s, out milliseconds)) return true;

        // 斜杠日期：M/D/YYYY 或 YYYY/M/D
        var slashParts = s.Split('/');
        if (slashParts.Length == 3 && slashParts.All(static p => p.Length > 0 && p.All(char.IsAsciiDigit)))
        {
            int year, month, day;
            if (slashParts[0].Length == 4)
            {
                year = int.Parse(slashParts[0], System.Globalization.CultureInfo.InvariantCulture);
                month = int.Parse(slashParts[1], System.Globalization.CultureInfo.InvariantCulture);
                day = int.Parse(slashParts[2], System.Globalization.CultureInfo.InvariantCulture);
            }
            else
            {
                month = int.Parse(slashParts[0], System.Globalization.CultureInfo.InvariantCulture);
                day = int.Parse(slashParts[1], System.Globalization.CultureInfo.InvariantCulture);
                year = int.Parse(slashParts[2], System.Globalization.CultureInfo.InvariantCulture);
                if (year < 50) year += 2000;
                else if (year < 100) year += 1900;
            }
            return FromComponents(year, month, day, out milliseconds);
        }

        // 英文月名："Aug 24 2026" / "August 24, 2026" / "24 August 2026"
        var tokens = s.Replace(",", " ", StringComparison.Ordinal)
            .Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length == 3)
        {
            var monthIndex = MonthIndex(tokens[0]);
            if (monthIndex > 0 && IsAllDigits(tokens[1]) && IsAllDigits(tokens[2]))
            {
                return FromComponents(
                    int.Parse(tokens[2], System.Globalization.CultureInfo.InvariantCulture),
                    monthIndex,
                    int.Parse(tokens[1], System.Globalization.CultureInfo.InvariantCulture),
                    out milliseconds);
            }
            monthIndex = MonthIndex(tokens[1]);
            if (monthIndex > 0 && IsAllDigits(tokens[0]) && IsAllDigits(tokens[2]))
            {
                return FromComponents(
                    int.Parse(tokens[2], System.Globalization.CultureInfo.InvariantCulture),
                    monthIndex,
                    int.Parse(tokens[0], System.Globalization.CultureInfo.InvariantCulture),
                    out milliseconds);
            }
        }
        return false;
    }

    private static bool FromComponents(int year, int month, int day, out double milliseconds)
    {
        milliseconds = double.NaN;
        if (month is < 1 or > 12) return false;
        if (day < 1 || day > DaysInMonth(year, month)) return false;
        milliseconds = DayNumber(year, month, day) * 86400000d;
        return Math.Abs(milliseconds) <= 8.64e15;
    }

    private static bool IsAllDigits(string token) => token.Length > 0 && token.All(char.IsAsciiDigit);

    private static int MonthIndex(string token)
    {
        var lower = token.ToLowerInvariant();
        if (lower.Length < 3) return 0;
        for (var m = 0; m < MonthNames.Length; m++)
        {
            if (MonthNames[m].StartsWith(lower, StringComparison.Ordinal) &&
                (lower.Length >= 3 || lower == MonthNames[m]))
            {
                return m + 1;
            }
        }
        return 0;
    }

    private static bool TakeDigits(string s, ref int i, int count, out int value)
    {
        value = 0;
        if (i + count > s.Length) return false;
        for (var k = 0; k < count; k++)
        {
            var c = s[i + k];
            if (!char.IsAsciiDigit(c)) return false;
            value = value * 10 + (c - '0');
        }
        i += count;
        return true;
    }

    private static int DaysInMonth(int year, int month) => month switch
    {
        1 or 3 or 5 or 7 or 8 or 10 or 12 => 31,
        4 or 6 or 9 or 11 => 30,
        _ => IsLeapYear(year) ? 29 : 28,
    };

    private static bool IsLeapYear(int year) =>
        year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);

    /// <summary>1970-01-01 起的天数（proleptic Gregorian，支持负值与扩展年份）。</summary>
    private static double DayNumber(int year, int month, int day)
    {
        // Howard Hinnant 的 days_from_civil 算法，扩展到 double 安全范围
        var y = (long)year;
        y -= month <= 2 ? 1 : 0;
        var era = (y >= 0 ? y : y - 399) / 400;
        var yoe = y - era * 400;
        var mp = (month + 9) % 12;
        var doy = (153 * mp + 2) / 5 + day - 1;
        var doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }
}
