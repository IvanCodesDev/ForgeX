export type AnalyticsStatus = "success" | "fail";

export interface AnalyticsRow {
  readonly job_id?: string;
  readonly date?: string;
  readonly machine_id?: string;
  readonly model_name?: string;
  readonly material?: string;
  readonly layer_height_mm?: number;
  readonly duration_min?: number;
  readonly filament_g?: number;
  readonly cost_fen?: number;
  readonly status: AnalyticsStatus;
  readonly fail_reason?: string;
  readonly energy_kwh?: number;
  readonly [field: string]: string | number | AnalyticsStatus | undefined;
}

export interface AnalyticsGenerator {
  readonly name: string;
  readonly version: number;
  readonly seed: number | null;
}

export interface AnalyticsProvenance {
  readonly source: string;
  readonly synthetic: boolean;
  readonly badge: string;
  readonly note: string;
  readonly generator: AnalyticsGenerator | null;
  readonly datasetKey: string;
  readonly rowCount: number;
}

export type AnalyticsDatasetKind = "physical-simulation" | "synthetic-demo" | "user-upload";

export interface AnalyticsDataset {
  readonly id: string;
  readonly label: string;
  readonly kind: AnalyticsDatasetKind;
  readonly description: string;
  readonly rows: readonly AnalyticsRow[];
  readonly provenance: AnalyticsProvenance;
  readonly warnings: readonly string[];
}

export interface AnalyticsDateRange {
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly label: string;
}

export interface AnalyticsRateInterval {
  readonly p: number;
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  readonly k: number;
  readonly width: number;
}

export interface AnalyticsKpis {
  readonly total: number;
  readonly yield: number;
  readonly avgCostFen: number;
  readonly filamentKg: number;
  readonly energyKwh: number;
  readonly worstMachine: {
    readonly id: string;
    readonly failRate: number;
    readonly n: number;
    readonly ci: AnalyticsRateInterval;
    readonly pValue: number | null;
    readonly significant: boolean;
  } | null;
  readonly topReason: { readonly name: string; readonly n: number } | null;
  readonly rankedMachines: number;
  readonly dateRange: AnalyticsDateRange | null;
}

export interface AnalyticsSection {
  readonly h: string;
  readonly lines: readonly string[];
}

export interface AnalyticsEvidence {
  readonly claim: string;
  readonly method: string;
  readonly n: number;
  readonly statistic: number | null;
  readonly ci95: readonly [number, number] | null;
  readonly pValue: number | null;
}

export interface AnalyticsChartItem {
  readonly label: string;
  readonly value: number;
  readonly hint?: string;
  readonly weak?: boolean;
  readonly ciLo?: number;
  readonly ciHi?: number;
}

export interface AnalyticsChart {
  readonly kind: string;
  readonly title: string;
  readonly items: readonly AnalyticsChartItem[];
}

export interface AnalyticsReport {
  readonly schemaVersion: number;
  readonly title: string;
  readonly verdict: string;
  readonly confidence: string;
  readonly sections: readonly AnalyticsSection[];
  readonly chart: AnalyticsChart | null;
  readonly evidence: readonly AnalyticsEvidence[];
  readonly intent: string;
  readonly intentMatched?: boolean;
  readonly rowCount: number;
  readonly engine: "local-rules";
  readonly provenance: AnalyticsProvenance | null;
  readonly highlight?: { readonly type: string; readonly id: string } | null;
}

export interface AnalyticsCsvParseResult {
  readonly rows: readonly AnalyticsRow[];
  readonly errors: readonly string[];
}

export interface AnalyticsCsvFile {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
}
