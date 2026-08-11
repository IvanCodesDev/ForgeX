import { describe, expect, it } from "vitest";
import type { AnalyticsReport } from "./analytics-types";
import { createAnalyticsReportExport } from "./report-export";

const report: AnalyticsReport = {
  schemaVersion: 1,
  title: "材料失败率对比",
  verdict: "ABS 失败率较高",
  confidence: "high",
  sections: [{ h: "口径", lines: ["只比较当前样本"] }],
  chart: {
    kind: "bar-rate",
    title: "材料失败率",
    items: [{ label: "=SUM(1,2)", value: 0.4, hint: "8/20" }],
  },
  evidence: [
    {
      claim: "ABS 高于 PLA",
      method: "Fisher 精确检验",
      n: 40,
      statistic: 4.2,
      ci95: [0.2, 0.6],
      pValue: 0.02,
    },
  ],
  intent: "material_cmp",
  intentMatched: true,
  rowCount: 40,
  engine: "local-rules",
  provenance: {
    source: "synthetic",
    synthetic: true,
    badge: "合成",
    note: "回归夹具",
    generator: { name: "fixture", version: 1, seed: 7 },
    datasetKey: "fixture",
    rowCount: 40,
  },
};

describe("analytics report export", () => {
  it("builds a deterministic audit JSON artifact", () => {
    const artifact = createAnalyticsReportExport(report, "json", {
      basename: "材料 报告",
      exportedAt: "2026-08-11T00:00:00.000Z",
    });
    const parsed = JSON.parse(artifact.text) as {
      exportSchemaVersion: number;
      exportedAt: string;
      report: AnalyticsReport;
    };

    expect(artifact.filename).toBe("材料-报告.json");
    expect(artifact.mimeType).toContain("application/json");
    expect(parsed.exportSchemaVersion).toBe(1);
    expect(parsed.exportedAt).toBe("2026-08-11T00:00:00.000Z");
    expect(parsed.report.provenance?.source).toBe("synthetic");
    expect(parsed.report.engine).toBe("local-rules");
  });

  it("exports provenance, evidence and chart records to Excel-friendly CSV", () => {
    const artifact = createAnalyticsReportExport(report, "csv", {
      exportedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(artifact.filename).toBe("forgex-analytics-report.csv");
    expect(artifact.text.startsWith("\uFEFF")).toBe(true);
    expect(artifact.text).toContain('"provenance","0","source","synthetic"');
    expect(artifact.text).toContain('"evidence","1","method","Fisher 精确检验"');
    expect(artifact.text).toContain('"chart","1","label","\'=SUM(1,2)"');
  });

  it("neutralizes spreadsheet formulas even when whitespace or controls precede them", () => {
    const guarded: AnalyticsReport = {
      ...report,
      chart: {
        ...report.chart!,
        items: [
          { label: " \t=CMD()", value: 1 },
          { label: "\r+SUM(1,2)", value: 2 },
          { label: "  @IMPORTXML", value: 3 },
        ],
      },
    };

    const artifact = createAnalyticsReportExport(guarded, "csv");

    expect(artifact.text).toContain('"\' \t=CMD()"');
    expect(artifact.text).toContain('"\'\r+SUM(1,2)"');
    expect(artifact.text).toContain('"\'  @IMPORTXML"');
  });
});
