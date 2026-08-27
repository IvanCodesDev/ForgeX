using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ForgeX.Analytics;

/// <summary>
/// 数据源规范化用的原始 CSV 解析/序列化——经典 `insight-data.js` parseCsv/toCsv 的逐分支移植。
/// 与既有 <see cref="AnalyticsCsvParser"/>（喂报告引擎的定型行）不同，这里必须保留
/// 「字段缺席 vs 数值 0」的区别：缺席字段在 toCsv 输出空串、数值 0 输出 "0"，
/// 两者混淆会让规范化 CSV 的 SHA-256 漂移，直接破坏数据源去重与黄金对比。
/// </summary>
public static class RawDatasetCsv
{
    public const int MaxRows = 5000;

    /// <summary>标准字段序（经典 D.FIELDS，单一真源）。</summary>
    public static readonly IReadOnlyList<string> Fields =
    [
        "job_id", "date", "machine_id", "model_name", "material",
        "layer_height_mm", "duration_min", "filament_g", "cost_fen",
        "status", "fail_reason", "energy_kwh",
    ];

    // 表头别名按字段声明序匹配（第一个命中的字段生效），与经典 HEADER_ALIAS 一致。
    private static readonly (string Field, string[] Aliases)[] HeaderAliases =
    [
        ("job_id", ["job_id", "任务id", "任务编号", "job"]),
        ("date", ["date", "日期", "打印日期"]),
        ("machine_id", ["machine_id", "机台", "机台编号", "设备", "machine"]),
        ("model_name", ["model_name", "模型", "模型名称", "model"]),
        ("material", ["material", "材料", "耗材类型"]),
        ("layer_height_mm", ["layer_height_mm", "层高", "layer_height"]),
        ("duration_min", ["duration_min", "耗时", "时长", "duration", "耗时分钟"]),
        ("filament_g", ["filament_g", "耗材克重", "耗材", "克重"]),
        ("cost_fen", ["cost_fen", "成本分", "cost"]),
        ("cost_cny", ["cost_cny", "成本", "成本元", "单件成本"]),
        ("status", ["status", "状态", "结果"]),
        ("fail_reason", ["fail_reason", "故障类型", "失败原因", "故障"]),
        ("energy_kwh", ["energy_kwh", "能耗", "电量"]),
    ];

    private static readonly HashSet<string> NumericFields =
        ["layer_height_mm", "duration_min", "filament_g", "cost_fen", "energy_kwh"];

    private static readonly HashSet<string> SuccessStatuses =
        ["success", "succeeded", "ok", "complete", "completed", "成功", "完成"];

    private static readonly HashSet<string> FailStatuses =
        ["fail", "failed", "failure", "error", "失败", "故障"];

    public static RawCsvParseResult Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var errors = new List<string>();
        if (text.StartsWith('\uFEFF')) text = text[1..]; // 经典实现只吃一个前导 BOM
        var lines = SplitLines(text);
        if (lines.Count < 2)
        {
            return new RawCsvParseResult([], ["CSV 至少需要表头 + 1 行数据"]);
        }

        var heads = SplitCsvLine(lines[0]);
        var columns = new Dictionary<int, string>();
        for (var c = 0; c < heads.Count; c++)
        {
            var head = JsValue.Trim(heads[c]).ToLowerInvariant();
            foreach (var (field, aliases) in HeaderAliases)
            {
                if (!aliases.Contains(head, StringComparer.Ordinal)) continue;
                columns[c] = field;
                break;
            }
        }

        var mapped = columns.Values.ToHashSet(StringComparer.Ordinal);
        if (!mapped.Contains("status")) errors.Add("缺少必需列：status（状态）");
        if (!mapped.Contains("machine_id") && !mapped.Contains("material"))
        {
            errors.Add("machine_id（机台）与 material（材料）至少需其一");
        }
        if (errors.Count > 0) return new RawCsvParseResult([], errors);

        var rows = new List<RawRow>();
        for (var i = 1; i < lines.Count; i++)
        {
            var cells = SplitCsvLine(lines[i]);
            var row = new RawRow();
            var rowErrors = new List<string>();
            for (var ci = 0; ci < cells.Count; ci++)
            {
                if (!columns.TryGetValue(ci, out var field)) continue;
                var value = JsValue.Trim(cells[ci]);
                if (field == "cost_cny" || NumericFields.Contains(field))
                {
                    if (value.Length == 0)
                    {
                        row.Set(field == "cost_cny" ? "cost_fen" : field, 0d);
                        continue;
                    }
                    if (!AnalyticsCsvParser.IsStrictNumber(value))
                    {
                        rowErrors.Add($"{field} 不是有效数值（{value}）");
                        continue;
                    }
                    var numeric = JsValue.StringToNumber(value);
                    if (!double.IsFinite(numeric))
                    {
                        rowErrors.Add($"{field} 超出有限数值范围（{value}）");
                        continue;
                    }
                    if (field == "cost_cny") row.Set("cost_fen", JsFormat.Round(numeric * 100));
                    else row.Set(field, numeric);
                    continue;
                }
                row.Set(field, value);
            }

            // 状态归一化（经典：String(row.status || "").toLowerCase()）
            var status = (row.TryGet("status", out var rawStatus) && rawStatus is string s && s.Length > 0
                ? s
                : string.Empty).ToLowerInvariant();
            if (FailStatuses.Contains(status)) row.Set("status", "fail");
            else if (SuccessStatuses.Contains(status)) row.Set("status", "success");
            else rowErrors.Add($"status 取值无效（{(status.Length > 0 ? status : "空")}）");
            if (rowErrors.Count > 0)
            {
                errors.Add($"第 {i + 1} 行：{string.Join('；', rowErrors)}");
                continue;
            }
            if (row.TryGet("status", out var normalized) && !Equals(normalized, "fail"))
            {
                row.Set("fail_reason", string.Empty);
            }
            rows.Add(row);
        }

        if (rows.Count > MaxRows)
        {
            rows.RemoveRange(MaxRows, rows.Count - MaxRows);
            errors.Add("数据超过 5000 行，已截取前 5000 行");
        }
        return new RawCsvParseResult(rows, errors);
    }

    /// <summary>经典 toCsv：标准字段序，esc 只对含引号/逗号/\n 的值加引号，缺席字段输出空串。</summary>
    public static string ToCsv(IReadOnlyList<RawRow> rows)
    {
        var builder = new StringBuilder();
        builder.AppendJoin(',', Fields);
        foreach (var row in rows)
        {
            builder.Append('\n');
            for (var f = 0; f < Fields.Count; f++)
            {
                if (f > 0) builder.Append(',');
                builder.Append(Escape(row.TryGet(Fields[f], out var value) ? value : null));
            }
        }
        return builder.ToString();
    }

    public static RawCsvNormalizeResult Normalize(string text)
    {
        var parsed = Parse(text);
        var csv = parsed.Rows.Count > 0 ? ToCsv(parsed.Rows) : string.Empty;
        return new RawCsvNormalizeResult(parsed.Rows, parsed.Errors, csv);
    }

    private static string Escape(object? value)
    {
        var text = JsFormat.Cell(value);
        if (text.AsSpan().IndexOfAny('"', ',', '\n') < 0) return text;
        return "\"" + text.Replace("\"", "\"\"") + "\"";
    }

    // String.prototype.split(/\r\n|\n|\r/) + filter(trim !== "")
    private static List<string> SplitLines(string text)
    {
        var lines = new List<string>();
        var start = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c is not ('\n' or '\r')) continue;
            AddLine(lines, text[start..i]);
            if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
            start = i + 1;
        }
        AddLine(lines, text[start..]);
        return lines;

        static void AddLine(List<string> lines, string line)
        {
            if (JsValue.Trim(line).Length > 0) lines.Add(line);
        }
    }

    /// <summary>单行 CSV 切分（与经典 splitCsvLine 一致：支持双引号包裹与 "" 转义）。</summary>
    private static List<string> SplitCsvLine(string line)
    {
        if (!line.Contains('"')) return [.. line.Split(',')];
        var cells = new List<string>();
        var current = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (quoted)
            {
                if (c == '"')
                {
                    if (i + 1 < line.Length && line[i + 1] == '"')
                    {
                        current.Append('"');
                        i++;
                    }
                    else quoted = false;
                }
                else current.Append(c);
            }
            else if (c == '"') quoted = true;
            else if (c == ',')
            {
                cells.Add(current.ToString());
                current.Clear();
            }
            else current.Append(c);
        }
        cells.Add(current.ToString());
        return cells;
    }
}

/// <summary>
/// 插入序的原始数据行。值只能是 string 或 double——这正是经典 parseCsv 产出的值域；
/// 字段缺席与空串/零是三种不同状态，序列化为 JSON 时缺席字段不输出键。
/// </summary>
public sealed class RawRow
{
    private readonly Dictionary<string, int> _index = new(StringComparer.Ordinal);
    private readonly List<KeyValuePair<string, object?>> _entries = [];

    public int Count => _entries.Count;

    public IReadOnlyList<KeyValuePair<string, object?>> Entries => _entries;

    public void Set(string field, object? value)
    {
        if (_index.TryGetValue(field, out var at)) _entries[at] = new(field, value);
        else
        {
            _index.Add(field, _entries.Count);
            _entries.Add(new(field, value));
        }
    }

    public bool TryGet(string field, out object? value)
    {
        if (_index.TryGetValue(field, out var at))
        {
            value = _entries[at].Value;
            return true;
        }
        value = null;
        return false;
    }

    /// <summary>数值字段读取：缺席或非数值 → null。</summary>
    public double? Number(string field) =>
        TryGet(field, out var value) && value is double number ? number : null;

    /// <summary>字符串字段读取：缺席或非字符串 → null。</summary>
    public string? Text(string field) =>
        TryGet(field, out var value) && value is string text ? text : null;

    /// <summary>groupBy 的键语义：缺席/空串 → "未知"，其余 String(v)。</summary>
    public string GroupKey(string field)
    {
        if (!TryGet(field, out var value) || value is null) return "未知";
        var text = JsFormat.Cell(value);
        return text.Length == 0 ? "未知" : text;
    }

    public JsonObject ToJsonObject()
    {
        var json = new JsonObject();
        foreach (var (field, value) in _entries)
        {
            json[field] = value switch
            {
                double number => JsonValue.Create(number),
                string text => JsonValue.Create(text),
                _ => null,
            };
        }
        return json;
    }

    /// <summary>从 JSON 对象还原（按文档序；只接受 string/number/null 值，其余抛 FormatException）。</summary>
    public static RawRow FromJson(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new FormatException("row must be a JSON object");
        }
        var row = new RawRow();
        foreach (var property in element.EnumerateObject())
        {
            object? value = property.Value.ValueKind switch
            {
                JsonValueKind.String => property.Value.GetString(),
                JsonValueKind.Number => property.Value.GetDouble(),
                JsonValueKind.Null => null,
                _ => throw new FormatException($"row.{property.Name} must be a string, number, or null"),
            };
            row.Set(property.Name, value);
        }
        return row;
    }
}

public sealed record RawCsvParseResult(
    IReadOnlyList<RawRow> Rows,
    IReadOnlyList<string> Errors);

public sealed record RawCsvNormalizeResult(
    IReadOnlyList<RawRow> Rows,
    IReadOnlyList<string> Errors,
    string Csv);
