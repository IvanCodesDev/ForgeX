using System.Globalization;
using System.Text.RegularExpressions;

namespace ForgeX.Analytics;

public static partial class AnalyticsCsvParser
{
    public const int MaxRows = 5000;

    private static readonly IReadOnlyDictionary<string, string[]> HeaderAliases =
        new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["job_id"] = ["job_id", "任务id", "任务编号", "job"],
            ["date"] = ["date", "日期", "打印日期"],
            ["machine_id"] = ["machine_id", "机台", "机台编号", "设备", "machine"],
            ["model_name"] = ["model_name", "模型", "模型名称", "model"],
            ["material"] = ["material", "材料", "耗材类型"],
            ["layer_height_mm"] = ["layer_height_mm", "层高", "layer_height"],
            ["duration_min"] = ["duration_min", "耗时", "时长", "duration", "耗时分钟"],
            ["filament_g"] = ["filament_g", "耗材克重", "耗材", "克重"],
            ["cost_fen"] = ["cost_fen", "成本分", "cost"],
            ["cost_cny"] = ["cost_cny", "成本", "成本元", "单件成本"],
            ["status"] = ["status", "状态", "结果"],
            ["fail_reason"] = ["fail_reason", "故障类型", "失败原因", "故障"],
            ["energy_kwh"] = ["energy_kwh", "能耗", "电量"],
        };

    private static readonly HashSet<string> NumericFields =
        ["layer_height_mm", "duration_min", "filament_g", "cost_fen", "energy_kwh"];

    private static readonly HashSet<string> SuccessStatuses =
        ["success", "succeeded", "ok", "complete", "completed", "成功", "完成"];

    private static readonly HashSet<string> FailStatuses =
        ["fail", "failed", "failure", "error", "失败", "故障"];

    /// <summary>经典 STRICT_NUMBER 文法（供原始解析器复用同一判定）。</summary>
    public static bool IsStrictNumber(string value) => StrictNumber().IsMatch(value);

    public static AnalyticsCsvResult Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var errors = new List<string>();
        var lines = LineSeparator().Split(text.TrimStart('\uFEFF'))
            .Where(static line => !string.IsNullOrWhiteSpace(line))
            .ToArray();
        if (lines.Length < 2)
        {
            return new AnalyticsCsvResult([], ["CSV 至少需要表头 + 1 行数据"]);
        }

        var headers = SplitLine(lines[0])
            .Select(static header => header.Trim().ToLowerInvariant())
            .ToArray();
        var columns = new Dictionary<int, string>();
        for (var column = 0; column < headers.Length; column++)
        {
            foreach (var field in HeaderAliases)
            {
                if (!field.Value.Contains(headers[column], StringComparer.Ordinal)) continue;
                columns[column] = field.Key;
                break;
            }
        }

        var mapped = columns.Values.ToHashSet(StringComparer.Ordinal);
        if (!mapped.Contains("status")) errors.Add("缺少必需列：status（状态）");
        if (!mapped.Contains("machine_id") && !mapped.Contains("material"))
        {
            errors.Add("machine_id（机台）与 material（材料）至少需其一");
        }
        if (errors.Count > 0) return new AnalyticsCsvResult([], errors);

        var rows = new List<AnalyticsRow>();
        for (var lineIndex = 1; lineIndex < lines.Length; lineIndex++)
        {
            var cells = SplitLine(lines[lineIndex]);
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            var numbers = new Dictionary<string, double>(StringComparer.Ordinal);
            var rowErrors = new List<string>();
            for (var column = 0; column < cells.Count; column++)
            {
                if (!columns.TryGetValue(column, out var field)) continue;
                var value = cells[column].Trim();
                if (field == "cost_cny" || NumericFields.Contains(field))
                {
                    if (value.Length == 0)
                    {
                        numbers[field == "cost_cny" ? "cost_fen" : field] = 0;
                        continue;
                    }
                    if (!StrictNumber().IsMatch(value))
                    {
                        rowErrors.Add($"{field} 不是有效数值（{value}）");
                        continue;
                    }
                    if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) ||
                        !double.IsFinite(number))
                    {
                        rowErrors.Add($"{field} 超出有限数值范围（{value}）");
                        continue;
                    }
                    numbers[field == "cost_cny" ? "cost_fen" : field] = field == "cost_cny"
                        ? JsRound(number * 100)
                        : number;
                    continue;
                }
                values[field] = value;
            }

            values.TryGetValue("status", out var rawStatus);
            var normalizedStatus = (rawStatus ?? string.Empty).ToLowerInvariant();
            AnalyticsStatus status;
            if (FailStatuses.Contains(normalizedStatus)) status = AnalyticsStatus.Fail;
            else if (SuccessStatuses.Contains(normalizedStatus)) status = AnalyticsStatus.Success;
            else
            {
                rowErrors.Add($"status 取值无效（{(normalizedStatus.Length > 0 ? normalizedStatus : "空")}）");
                status = AnalyticsStatus.Success;
            }
            if (rowErrors.Count > 0)
            {
                errors.Add($"第 {lineIndex + 1} 行：{string.Join('；', rowErrors)}");
                continue;
            }

            rows.Add(new AnalyticsRow(
                Get(values, "job_id"),
                Get(values, "date"),
                Get(values, "machine_id"),
                Get(values, "model_name"),
                Get(values, "material"),
                Get(numbers, "layer_height_mm"),
                Get(numbers, "duration_min"),
                Get(numbers, "filament_g"),
                Get(numbers, "cost_fen"),
                status,
                status == AnalyticsStatus.Fail ? Get(values, "fail_reason") : string.Empty,
                Get(numbers, "energy_kwh")));
        }

        if (rows.Count > MaxRows)
        {
            rows.RemoveRange(MaxRows, rows.Count - MaxRows);
            errors.Add("数据超过 5000 行，已截取前 5000 行");
        }
        return new AnalyticsCsvResult(rows, errors);
    }

    private static string? Get(Dictionary<string, string> values, string key) =>
        values.TryGetValue(key, out var value) ? value : null;

    private static double Get(Dictionary<string, double> values, string key) =>
        values.TryGetValue(key, out var value) ? value : 0;

    private static double JsRound(double value) => Math.Floor(value + 0.5);

    private static IReadOnlyList<string> SplitLine(string line)
    {
        if (!line.Contains('"')) return line.Split(',');
        var cells = new List<string>();
        var current = new System.Text.StringBuilder();
        var quoted = false;
        for (var index = 0; index < line.Length; index++)
        {
            var character = line[index];
            if (quoted)
            {
                if (character == '"')
                {
                    if (index + 1 < line.Length && line[index + 1] == '"')
                    {
                        current.Append('"');
                        index++;
                    }
                    else quoted = false;
                }
                else current.Append(character);
            }
            else if (character == '"') quoted = true;
            else if (character == ',')
            {
                cells.Add(current.ToString());
                current.Clear();
            }
            else current.Append(character);
        }
        cells.Add(current.ToString());
        return cells;
    }

    [GeneratedRegex("\\r\\n|\\n|\\r", RegexOptions.CultureInvariant)]
    private static partial Regex LineSeparator();

    // JS 正则的 \d 恒为 ASCII [0-9]，而 .NET 的 \d 匹配 Unicode 数字（如全角１２３）——
    // 必须显式 [0-9]，否则全角数字会越过文法检查落到"超出有限数值范围"的错误分支
    //（经典侧报"不是有效数值"），错误文案在双跑对比中漂移。
    [GeneratedRegex("^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex StrictNumber();
}
