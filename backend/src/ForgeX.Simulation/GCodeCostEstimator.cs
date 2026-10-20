using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ForgeX.Domain;

namespace ForgeX.Simulation;

/// <summary>Declared average-power and rate scenario, bound to a stored authority result. Never a measured bill.</summary>
public static class GCodeCostEstimator
{
    public const string ModelVersion = "forgex-gcode-cost/2";
    private static readonly JsonSerializerOptions CanonicalJson = new(JsonSerializerDefaults.Web);
    public static GCodeCostEstimate Estimate(string jobId, GCodeAnalysisResult result, GCodeCostInputs inputs)
    {
        if (inputs.Evidence is null) throw new GCodeCostException("cost_inputs_invalid", "输入依据必须为文本，未配置时可留空");
        static bool Hash(string text, int size) => text is not null && text.Length == size && text.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
        if (result.Profile is null || result.Statistics is null || !Hash(jobId, 32) || !Hash(result.Sha256, 64) || !Hash(result.Profile.Fingerprint, 64) ||
            string.IsNullOrWhiteSpace(result.EngineVersion) || result.EngineVersion.Length > 64 ||
            !double.IsFinite(result.Statistics.TimeSeconds) || result.Statistics.TimeSeconds is < 0 or > 31_536_000 ||
            !double.IsFinite(result.Statistics.FilamentMassG) || result.Statistics.FilamentMassG is < 0 or > 1_000_000)
            throw new GCodeCostException("cost_source_invalid", "作业时长、耗材或指纹不满足成本估算范围");
        static decimal? Value(decimal? value, decimal maximum, string name)
        {
            if (value < 0 || value > maximum) throw new GCodeCostException("cost_inputs_invalid", $"{name} 超出允许范围 0–{maximum}");
            return value is null ? null : decimal.Parse(value.Value.ToString("G29", CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture);
        }
        var normalized = new GCodeCostInputs(
            Value(inputs.AveragePowerWatts, 100_000, "平均功率 W"), Value(inputs.ElectricityCnyPerKwh, 100, "电价 CNY/kWh"),
            Value(inputs.MachineCnyPerHour, 100_000, "纯机时费率 CNY/h"), Value(inputs.MaterialCnyPerKg, 5000, "材料单价 CNY/kg"),
            (inputs.Evidence ?? "").Replace("\r\n", "\n").Trim());
        var hasValues = normalized.AveragePowerWatts.HasValue || normalized.ElectricityCnyPerKwh.HasValue || normalized.MachineCnyPerHour.HasValue || normalized.MaterialCnyPerKg.HasValue;
        if (normalized.Evidence.Length > 500 || normalized.Evidence.Any(c => char.IsControl(c) && c is not ('\n' or '\t')) ||
            (hasValues && normalized.Evidence.Length == 0))
            throw new GCodeCostException("cost_evidence_required", "填写功率或费率时须提供 1–500 字的输入依据，不接受控制字符");
        var basis = new GCodeCostBasis(jobId, result.Sha256, result.Profile.Fingerprint, result.EngineVersion,
            result.Statistics.TimeSeconds == 0 ? 0 : result.Statistics.TimeSeconds, result.Statistics.FilamentMassG == 0 ? 0 : result.Statistics.FilamentMassG);
        var hours = (decimal)basis.DurationSeconds / 3600m;
        var rawEnergy = normalized.AveragePowerWatts * hours / 1000m;
        static decimal? Round(decimal? value, int digits = 6) => value is null ? null : Math.Round(value.Value, digits, MidpointRounding.ToEven);
        var energy = Round(rawEnergy, 9);
        var material = Round((decimal)basis.FilamentMassG * normalized.MaterialCnyPerKg / 1000m);
        var electricity = Round(rawEnergy * normalized.ElectricityCnyPerKwh);
        var machine = Round(hours * normalized.MachineCnyPerHour);
        var total = material + electricity + machine;
        var missing = new List<string>();
        if (normalized.AveragePowerWatts is null) missing.Add("averagePowerWatts");
        if (normalized.ElectricityCnyPerKwh is null) missing.Add("electricityCnyPerKwh");
        if (normalized.MachineCnyPerHour is null) missing.Add("machineCnyPerHour");
        if (normalized.MaterialCnyPerKg is null) missing.Add("materialCnyPerKg");
        var canonical = JsonSerializer.Serialize(new { modelVersion = ModelVersion, basis, inputs = normalized }, CanonicalJson);
        var fingerprint = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
        return new GCodeCostEstimate("1.0", ModelVersion, "CNY", fingerprint, basis, normalized,
            new GCodeCostTotals(missing.Count == 0, energy, material, electricity, machine, total), missing,
            ["按 G-code 运动估算时长及声明平均功率计算，不含未计入作业时长的预热、保温、待机或换料；不是电表实测或最终账单。",
             "机时费率应排除材料和电费，避免重复计费；输入依据由用户声明，系统不核实其真实性。"]);
    }
}
