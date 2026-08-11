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

public sealed record AnalyticsGenerator(
    string Name,
    int Version,
    long? Seed);

public sealed record AnalyticsProvenance(
    string Source,
    bool Synthetic,
    string Badge,
    string Note,
    AnalyticsGenerator? Generator,
    string DatasetKey,
    int RowCount);

public sealed record AnalyticsReportSection(
    string H,
    IReadOnlyList<string> Lines);

public sealed record AnalyticsEvidence(
    string Claim,
    string Method,
    int N,
    double? Statistic,
    IReadOnlyList<double>? Ci95,
    double? PValue);

public sealed record AnalyticsChartItem(
    string Label,
    double Value,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Hint = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Weak = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] double? CiLo = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] double? CiHi = null);

public sealed record AnalyticsChart(
    string Kind,
    string Title,
    IReadOnlyList<AnalyticsChartItem> Items);

public sealed record AnalyticsHighlight(
    string Type,
    string Id);

public sealed record AnalyticsReport(
    int SchemaVersion,
    string Title,
    string Verdict,
    string Confidence,
    IReadOnlyList<AnalyticsReportSection> Sections,
    AnalyticsChart? Chart,
    IReadOnlyList<AnalyticsEvidence> Evidence,
    string Intent,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? IntentMatched,
    int RowCount,
    string Engine,
    AnalyticsProvenance? Provenance,
    AnalyticsHighlight? Highlight = null);

public sealed record AnalyticsCostProfile(
    string Id,
    string Label,
    string Source,
    IReadOnlyDictionary<string, double> MaterialFenPerKg,
    double MaterialDefaultFenPerKg,
    double PowerFenPerKwh,
    double MachineFenPerHour);
