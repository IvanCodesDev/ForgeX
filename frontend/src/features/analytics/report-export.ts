import type { AnalyticsReport } from "./analytics-types";

export type AnalyticsExportFormat = "json" | "csv";

export interface AnalyticsExportArtifact {
  readonly filename: string;
  readonly mimeType: string;
  readonly text: string;
}

function safeStem(value: string): string {
  const stem = value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return stem.slice(0, 80) || "forgex-analytics-report";
}

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  let firstVisible = 0;
  while (firstVisible < text.length && text.charCodeAt(firstVisible) <= 0x20) firstVisible += 1;
  if ("=+-@".includes(text[firstVisible] ?? "")) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function reportCsv(report: AnalyticsReport, exportedAt: string): string {
  const records: Array<readonly [string, string, string, unknown]> = [
    ["metadata", "0", "exported_at", exportedAt],
    ["report", "0", "schema_version", report.schemaVersion],
    ["report", "0", "engine", report.engine],
    ["report", "0", "title", report.title],
    ["report", "0", "verdict", report.verdict],
    ["report", "0", "confidence", report.confidence],
    ["report", "0", "intent", report.intent],
    ["report", "0", "row_count", report.rowCount],
    ["provenance", "0", "source", report.provenance?.source ?? ""],
    ["provenance", "0", "synthetic", report.provenance?.synthetic ?? ""],
    ["provenance", "0", "dataset_key", report.provenance?.datasetKey ?? ""],
    ["provenance", "0", "note", report.provenance?.note ?? ""],
  ];

  report.sections.forEach((section, index) => {
    records.push(["section", String(index + 1), "heading", section.h]);
    section.lines.forEach((line) => records.push(["section", String(index + 1), "line", line]));
  });
  report.evidence.forEach((evidence, index) => {
    const record = String(index + 1);
    records.push(["evidence", record, "claim", evidence.claim]);
    records.push(["evidence", record, "method", evidence.method]);
    records.push(["evidence", record, "n", evidence.n]);
    records.push(["evidence", record, "statistic", evidence.statistic]);
    records.push(["evidence", record, "ci95", evidence.ci95?.join(" – ") ?? ""]);
    records.push(["evidence", record, "p_value", evidence.pValue]);
  });
  report.chart?.items.forEach((item, index) => {
    const record = String(index + 1);
    records.push(["chart", record, "label", item.label]);
    records.push(["chart", record, "value", item.value]);
    records.push(["chart", record, "hint", item.hint ?? ""]);
  });

  const header = ["record_type", "record_index", "field", "value"].map(csvCell).join(",");
  return `\uFEFF${[header, ...records.map((row) => row.map(csvCell).join(","))].join("\r\n")}`;
}

export function createAnalyticsReportExport(
  report: AnalyticsReport,
  format: AnalyticsExportFormat,
  options: { readonly basename?: string; readonly exportedAt?: string } = {}
): AnalyticsExportArtifact {
  const basename = safeStem(options.basename ?? "forgex-analytics-report");
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  if (format === "json") {
    return {
      filename: `${basename}.json`,
      mimeType: "application/json;charset=utf-8",
      text: `${JSON.stringify({ exportSchemaVersion: 1, exportedAt, report }, null, 2)}\n`,
    };
  }
  return {
    filename: `${basename}.csv`,
    mimeType: "text/csv;charset=utf-8",
    text: reportCsv(report, exportedAt),
  };
}
