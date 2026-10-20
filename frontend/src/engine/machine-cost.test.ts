import { describe, expect, it } from "vitest";
import type { GCodeCostEstimate } from "../generated/forgex-api";
import { reconcileMachineCost } from "./machine-cost";
import { parse, verifyGcodeBinding } from "./machine-log";

const sha = "a".repeat(64);
function estimate(): GCodeCostEstimate {
  return {
    schemaVersion: "1.0",
    modelVersion: "forgex-gcode-cost/2",
    currency: "CNY",
    fingerprint: "f".repeat(64),
    basis: {
      jobId: "b".repeat(32),
      inputSha256: sha,
      profileFingerprint: "c".repeat(64),
      analysisEngineVersion: "1.4.0",
      durationSeconds: 3600,
      filamentMassG: 100,
    },
    inputs: {
      averagePowerWatts: 200,
      electricityCnyPerKwh: 1,
      machineCnyPerHour: 5,
      materialCnyPerKg: 100,
      evidence: "功率和费率依据",
    },
    totals: {
      isComplete: true,
      energyKwh: 0.2,
      materialCostCny: 10,
      electricityCostCny: 0.2,
      machineTimeCostCny: 5,
      totalCostCny: 15.2,
    },
    missingInputs: [],
    warnings: ["估算"],
  };
}
function log(patch: Record<string, unknown> = {}) {
  const result = parse(
    JSON.stringify({
      job: {
        jobId: "J-1",
        machineId: "M-1",
        status: "success",
        gcodeSha256: sha,
        durationSec: 5400,
        filamentG: 120,
        energyKwh: 0.4,
        energyEvidence: "电表任务起止差额",
        ...patch,
      },
    })
  );
  result.sourceSha256 = "d".repeat(64);
  result.gcodeBinding = verifyGcodeBinding({ sha256: sha }, result);
  return result;
}
describe("同一作业、同一费率的日志成本对账", () => {
  it("保留权威成本原件、日志原件和身份，计算分项及有符号差异", () => {
    const planned = estimate();
    const record = log();
    const report = reconcileMachineCost(planned, record);
    expect(report.estimate).toEqual(planned);
    expect(report.log).toMatchObject({
      sha256: "d".repeat(64),
      gcodeSha256: sha,
      energyEvidence: record.energyEvidence,
      status: "success",
      durationSeconds: 5400,
      filamentMassG: 120,
    });
    expect(report.rows.find((row) => row.key === "total")?.recorded).toBeCloseTo(19.9, 10);
    expect(report.rows.find((row) => row.key === "energy")).toMatchObject({
      planned: 0.2,
      recorded: 0.4,
      delta: 0.2,
      relativeDelta: 1,
    });
    expect(report.rows.find((row) => row.key === "machine")).toMatchObject({
      planned: 5,
      recorded: 7.5,
      delta: 2.5,
      relativeDelta: 0.5,
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
  it.each(["actualTimeSec", "filamentG", "energyKwh"] as const)("缺失 %s 仅使相关分项和总额保持未知", (key) => {
    const record = { ...log(), [key]: null };
    const rows = reconcileMachineCost(estimate(), record).rows;
    expect(rows.find((row) => row.key === "total")?.recorded).toBeNull();
    expect(rows.filter((row) => row.unit === "CNY" && row.recorded !== null)).toHaveLength(2);
  });
  it("有能耗无计量依据时不生成电费与总成本，原始声明仍保留", () => {
    const report = reconcileMachineCost(estimate(), log({ energyEvidence: "" }));
    expect(report.log.energyKwh).toBe(0.4);
    expect(report.rows.find((row) => row.key === "energy")?.recorded).toBeNull();
    expect(report.rows.find((row) => row.key === "electricity")?.recorded).toBeNull();
    expect(report.rows.find((row) => row.key === "total")?.recorded).toBeNull();
    expect(report.warnings.join(" ")).toContain("计量依据");
  });
  it("零消耗与零费率可核算，未知功率不妨碍日志成本核算", () => {
    const planned = estimate();
    const noPower: GCodeCostEstimate = {
      ...planned,
      inputs: { ...planned.inputs, averagePowerWatts: null },
      totals: { ...planned.totals, energyKwh: null, electricityCostCny: null, totalCostCny: null, isComplete: false },
      missingInputs: ["averagePowerWatts"],
    };
    expect(reconcileMachineCost(noPower, log()).rows.find((row) => row.key === "total")).toMatchObject({
      planned: null,
      recorded: 19.9,
      delta: null,
      relativeDelta: null,
    });
    const free = {
      ...planned,
      inputs: { ...planned.inputs, electricityCnyPerKwh: 0, machineCnyPerHour: 0, materialCnyPerKg: 0 },
    };
    expect(
      reconcileMachineCost(free, log({ durationSec: 0, filamentG: 0, energyKwh: 0 })).rows.find(
        (row) => row.key === "total"
      )?.recorded
    ).toBe(0);
  });
  it.each(["electricityCnyPerKwh", "materialCnyPerKg", "machineCnyPerHour"] as const)(
    "缺少费率 %s 时不编造总额",
    (key) => {
      const planned = estimate();
      const partial = { ...planned, inputs: { ...planned.inputs, [key]: null } };
      expect(reconcileMachineCost(partial, log()).rows.find((row) => row.key === "total")?.recorded).toBeNull();
    }
  );
  it.each([
    { sourceSha256: "" },
    { sourceSha256: "wrong" },
    { gcodeSha256: "" },
    { gcodeSha256: "e".repeat(64) },
    { gcodeBinding: { verified: false, status: "missing", message: "missing" } },
  ])("拒绝缺失或错配的文件责任链 %j", (patch) => {
    expect(() => reconcileMachineCost(estimate(), { ...log(), ...patch })).toThrow(/摘要/);
  });
  it.each([
    { actualTimeSec: -1 },
    { actualTimeSec: Infinity },
    { actualTimeSec: 31536001 },
    { filamentG: NaN },
    { filamentG: 1000001 },
    { energyKwh: -1 },
    { energyKwh: 1000001 },
  ])("拒绝超范围的记录值 %j", (patch) => {
    expect(() => reconcileMachineCost(estimate(), { ...log(), ...patch })).toThrow(/范围/);
  });
  it("零计划无百分比基准；少用料的差值保留负号，失败状态明确保留", () => {
    const planned = estimate();
    const changed = { ...planned, totals: { ...planned.totals, energyKwh: 0 } };
    const report = reconcileMachineCost(changed, log({ filamentG: 50, status: "cancelled" }));
    expect(report.rows.find((row) => row.key === "energy")).toMatchObject({ relativeDelta: null, delta: 0.4 });
    expect(report.rows.find((row) => row.key === "filament")).toMatchObject({ delta: -50, relativeDelta: -0.5 });
    expect(report.warnings.join(" ")).toContain("cancelled");
  });
});
