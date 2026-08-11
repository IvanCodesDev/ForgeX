using System.Text.Json.Serialization;

namespace ForgeX.Analytics;

public enum AnalyticsStatus
{
    Success,
    Fail,
}

public sealed record AnalyticsRow(
    string? JobId,
    string? Date,
    string? MachineId,
    string? ModelName,
    string? Material,
    double LayerHeightMm,
    double DurationMin,
    double FilamentG,
    double CostFen,
    AnalyticsStatus Status,
    string? FailReason,
    double EnergyKwh);

public sealed record AnalyticsCsvResult(
    IReadOnlyList<AnalyticsRow> Rows,
    IReadOnlyList<string> Errors);

public sealed record RateInterval(
    double P,
    double Lo,
    double Hi,
    int N,
    int K,
    double Width);

public sealed record FisherResult(
    double PValue,
    double? OddsRatio,
    int A,
    int B,
    int C,
    int D,
    int N);

public sealed record RateGroup(string Key, int K, int N);

public sealed record RateComparison(
    RateInterval A,
    RateInterval B,
    double Diff,
    double PValue,
    double? OddsRatio,
    bool Significant,
    bool Enough);

public sealed record RateVsRest(int K, int N, double Rate);

public sealed record RankedRate(
    string Key,
    int K,
    int N,
    double Rate,
    RateInterval Ci,
    RateVsRest VsRest,
    double PValue,
    double? OddsRatio,
    bool Significant);

public sealed record SkippedRate(
    string Key,
    int K,
    int N,
    RateInterval Ci,
    string Reason);

public sealed record FleetRate(int K, int N, double Rate);

public sealed record RateRanking(
    IReadOnlyList<RankedRate> Ranked,
    IReadOnlyList<SkippedRate> Skipped,
    RankedRate? Worst,
    int MinSample,
    double Alpha,
    FleetRate Fleet);

public readonly record struct NumericPair(double X, double Y);

public sealed record CorrelationResult(
    double R,
    int N,
    IReadOnlyList<double>? Ci95,
    double PValue,
    bool Significant,
    string Method);

public sealed record PartialCorrelationObservation(
    double X,
    double Y,
    IReadOnlyList<string?> Controls);

public sealed record PartialCorrelationResult(
    double R,
    int N,
    IReadOnlyList<double>? Ci95,
    double PValue,
    bool Significant,
    string Method,
    int Groups,
    int Dropped,
    IReadOnlyList<string> Controls);

public sealed record MannKendallResult(
    int N,
    [property: JsonPropertyName("S")] long S,
    double Tau,
    double Z,
    double PValue,
    string Direction,
    bool Significant,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Method);

public sealed record AnalyticsDateRange(
    string From,
    string To,
    int Days,
    string Label);

public sealed record AnalyticsWorstMachine(
    string Id,
    double FailRate,
    int N,
    RateInterval Ci,
    double PValue,
    bool Significant);

public sealed record AnalyticsTopReason(string Name, int N);

public sealed record AnalyticsKpis(
    int Total,
    double Yield,
    long AvgCostFen,
    double FilamentKg,
    double EnergyKwh,
    AnalyticsWorstMachine? WorstMachine,
    AnalyticsTopReason? TopReason,
    int RankedMachines,
    AnalyticsDateRange? DateRange);
