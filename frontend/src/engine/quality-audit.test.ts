import { describe, expect, it } from "vitest";
import { simulationQualityAudit, type AuditableQualityReport } from "./quality-audit";
import { FXSim, type SimSettings, type SimTelemetry } from "./sim";
const settings = { material: "PLA", speed: 60 } as SimSettings;
const tel = {
  printTime: 100,
  tempTime: 100,
  tempDevSum: 20,
  tempDevMax: 1,
  offSpeedTime: 0,
  faults: [],
  pauses: 0,
  tunes: 0,
  leveled: true,
  levelMax: 0.01,
  firstLayerUneven: 0.01,
  firstLayerAreaMm2: 100,
  usedG0: 0,
  settings0: { ...settings },
  clogLoadMax: 0,
  slipRiskMax: 0,
  travelMoves: 2,
  travelMm: 10,
  retractions: 2,
  retractedMm: 1,
  stringingRiskWeighted: 1,
  stringingTravelMm: 1,
  retractionStress: 0,
  machineId: "FX-TEST",
} as unknown as SimTelemetry;
const report = () =>
  FXSim.computeActualQuality(structuredClone(tel), { ...settings }, { id: "model", name: "合成测试模型" } as never, {
    elapsed: 120,
    usedG: 1,
    gcodeSha256: "a".repeat(64),
  });
describe("simulation quality audit", () => {
  it("exports source, inputs and bounded aggregate telemetry with an explicit simulation boundary", () => {
    const result = report(),
      audit = JSON.parse(simulationQualityAudit(result));
    expect(audit.source).toBe("browser-simulation");
    expect(audit.modelVersion).toBe("forgex-simulation-quality/1");
    expect(audit.basis.gcodeSha256).toBe("a".repeat(64));
    expect(audit.basis.modelName).toBe("合成测试模型");
    expect(audit.basis.telemetry.faults).toBe(0);
    expect(audit.basis.telemetry.tempDevSum).toBe(20);
    expect(audit.result.score).toBe(result.score);
    expect(audit.warnings.join(" ")).toContain("不是打印机实测");
  });
  it("freezes initial/final settings and scalar telemetry at report creation", () => {
    const telemetry = structuredClone(tel),
      final = { ...settings },
      result = FXSim.computeActualQuality(telemetry, final, null);
    final.speed = 500;
    telemetry.settings0.speed = 1000;
    telemetry.tempDevMax = 1000;
    telemetry.faults.push("later");
    expect(result.provenance.basis.finalSettings.speed).toBe(60);
    expect(result.provenance.basis.initialSettings.speed).toBe(60);
    expect(result.provenance.basis.telemetry.tempDevMax).toBe(1);
    expect(result.provenance.basis.telemetry.faults).toBe(0);
  });
  it("does not claim a G-code origin for generated models", () => {
    expect(FXSim.computeActualQuality(tel, settings, null).provenance.basis.gcodeSha256).toBeNull();
  });
  it("rejects reports without provenance or with corrupt numeric evidence", () => {
    const value = report();
    expect(() =>
      simulationQualityAudit({ ...value, provenance: undefined } as unknown as AuditableQualityReport)
    ).toThrow("来源");
    for (const field of ["score", "elapsed", "usedG"] as const)
      expect(() => simulationQualityAudit({ ...value, [field]: NaN })).toThrow();
    const changed = {
      ...value,
      provenance: { ...value.provenance, basis: { ...value.provenance.basis, telemetry: { broken: Infinity } } },
    };
    expect(() => simulationQualityAudit(changed)).toThrow("非有限");
  });
});
