import { describe, expect, it, vi } from "vitest";
import {
  importAnalyticsCsv,
  listBuiltInAnalyticsDatasets,
  MAX_ANALYTICS_CSV_BYTES,
  runAnalyticsQuestion,
} from "./analytics-model";
import type { AnalyticsCsvFile } from "./analytics-types";

function csvFile(text: string, name = "fixture.csv"): AnalyticsCsvFile {
  return {
    name,
    size: new TextEncoder().encode(text).byteLength,
    text: vi.fn().mockResolvedValue(text),
  };
}

describe("analytics migration model", () => {
  it("exposes physical-simulation and synthetic-demo fixtures with explicit provenance", () => {
    const datasets = listBuiltInAnalyticsDatasets();
    const physical = datasets.find((item) => item.kind === "physical-simulation");
    const synthetic = datasets.find((item) => item.kind === "synthetic-demo");

    expect(physical?.rows).toHaveLength(400);
    expect(physical?.provenance).toMatchObject({ source: "sim-farm", synthetic: true, rowCount: 400 });
    expect(physical?.provenance.note).toContain("物理仿真");
    expect(synthetic?.rows).toHaveLength(96);
    expect(synthetic?.provenance).toMatchObject({ source: "synthetic", synthetic: true, rowCount: 96 });
    expect(synthetic?.provenance.note).toContain("预先写死");
  });

  it("delegates analysis to the existing rules engine and retains provenance", () => {
    const dataset = listBuiltInAnalyticsDatasets()[0]!;
    const report = runAnalyticsQuestion("哪台机故障率最高？", dataset);

    expect(report.engine).toBe("local-rules");
    expect(report.intent).toBe("machine_fault");
    expect(report.verdict).not.toBe("");
    expect(report.provenance).toEqual(dataset.provenance);
    expect(report.rowCount).toBe(400);
  });

  it("imports a valid CSV locally and marks its claims as user-provided", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const csv = [
      "job_id,date,machine_id,material,status,duration_min,cost_fen",
      "J-1,2026-08-01,M-1,PLA,success,20,100",
      "J-2,2026-08-02,M-1,PLA,fail,8,40",
    ].join("\n");

    const dataset = await importAnalyticsCsv(csvFile(csv, "line-a.csv"));

    expect(dataset.kind).toBe("user-upload");
    expect(dataset.rows).toHaveLength(2);
    expect(dataset.provenance).toMatchObject({ source: "user-upload", synthetic: false, rowCount: 2 });
    expect(dataset.provenance.note).toContain("不会自动证明");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized and structurally invalid files with typed errors", async () => {
    const read = vi.fn().mockResolvedValue("ignored");
    const oversized: AnalyticsCsvFile = {
      name: "too-large.csv",
      size: MAX_ANALYTICS_CSV_BYTES + 1,
      text: read,
    };

    await expect(importAnalyticsCsv(oversized)).rejects.toMatchObject({
      code: "file-too-large",
    });
    expect(read).not.toHaveBeenCalled();
    await expect(importAnalyticsCsv(csvFile("a,b\n1,2"))).rejects.toMatchObject({
      code: "parse-error",
    });
  });

  it("does not turn unknown status or invalid numbers into successful zero-valued jobs", async () => {
    const csv = [
      "machine_id,status,duration_min,cost_fen",
      "M-1,running,20,100",
      "M-2,success,12oops,80",
      "M-3,success,21,90",
    ].join("\n");

    const dataset = await importAnalyticsCsv(csvFile(csv, "dirty.csv"));

    expect(dataset.rows).toHaveLength(1);
    expect(dataset.rows[0]).toMatchObject({ machine_id: "M-3", status: "success", duration_min: 21 });
    expect(dataset.warnings).toEqual([
      expect.stringMatching(/第 2 行.*status/),
      expect.stringMatching(/第 3 行.*duration_min/),
    ]);
  });

  it("does not run an empty question", () => {
    expect(() => runAnalyticsQuestion("  ", listBuiltInAnalyticsDatasets()[0]!)).toThrow("请输入要分析的问题");
  });
});
