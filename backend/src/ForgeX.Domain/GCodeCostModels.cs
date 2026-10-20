using System.Text.Json.Serialization;

namespace ForgeX.Domain;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record GCodeCostInputs(
    [property: JsonRequired, JsonIgnore(Condition = JsonIgnoreCondition.Never)] decimal? AveragePowerWatts,
    [property: JsonRequired, JsonIgnore(Condition = JsonIgnoreCondition.Never)] decimal? ElectricityCnyPerKwh,
    [property: JsonRequired, JsonIgnore(Condition = JsonIgnoreCondition.Never)] decimal? MachineCnyPerHour,
    [property: JsonRequired, JsonIgnore(Condition = JsonIgnoreCondition.Never)] decimal? MaterialCnyPerKg,
    [property: JsonRequired] string Evidence);

public sealed record GCodeCostBasis(string JobId, string InputSha256, string ProfileFingerprint,
    string AnalysisEngineVersion, double DurationSeconds, double FilamentMassG);

public sealed record GCodeCostTotals(bool IsComplete,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] decimal? EnergyKwh,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] decimal? MaterialCostCny,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] decimal? ElectricityCostCny,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] decimal? MachineTimeCostCny,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] decimal? TotalCostCny);

public sealed record GCodeCostEstimate(string SchemaVersion, string ModelVersion, string Currency,
    string Fingerprint, GCodeCostBasis Basis, GCodeCostInputs Inputs, GCodeCostTotals Totals,
    IReadOnlyList<string> MissingInputs, IReadOnlyList<string> Warnings);

public sealed class GCodeCostException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
