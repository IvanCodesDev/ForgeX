import type {
  AnalyticsCsvParseResult,
  AnalyticsDataset,
  AnalyticsKpis,
  AnalyticsProvenance,
  AnalyticsReport,
  AnalyticsRow,
} from "../features/analytics/analytics-types";

export const legacyAnalytics: {
  builtInDatasets(): readonly AnalyticsDataset[];
  parseCsv(text: string): AnalyticsCsvParseResult;
  toCsv(rows: readonly AnalyticsRow[]): string;
  kpis(rows: readonly AnalyticsRow[]): AnalyticsKpis;
  analyze(
    question: string,
    rows: readonly AnalyticsRow[],
    options: { readonly provenance: AnalyticsProvenance }
  ): AnalyticsReport;
  readonly supportedDimensions: readonly string[];
};
