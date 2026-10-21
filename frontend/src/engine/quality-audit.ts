export interface SimulationQualityBasis {
  readonly machineId: string;
  readonly modelId: string | null;
  readonly modelName: string | null;
  readonly gcodeSha256: string | null;
  readonly initialSettings: Readonly<Record<string, unknown>>;
  readonly finalSettings: Readonly<Record<string, unknown>>;
  readonly telemetry: Readonly<Record<string, number | boolean | null>>;
}
export interface AuditableQualityReport {
  readonly score: number;
  readonly grade: string;
  readonly elapsed: number;
  readonly usedG: number;
  readonly at: Date;
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly level: string;
    readonly tip: string;
  }>;
  readonly provenance?: {
    readonly source: "browser-simulation";
    readonly modelVersion: "forgex-simulation-quality/1";
    readonly basis: SimulationQualityBasis;
  };
}
export function simulationQualityAudit(report: AuditableQualityReport) {
  if (
    report.provenance?.source !== "browser-simulation" ||
    report.provenance.modelVersion !== "forgex-simulation-quality/1"
  )
    throw new Error("该报告缺少仿真来源信息，请重新完成一次仿真");
  if (
    !Number.isFinite(report.at.getTime()) ||
    !Number.isFinite(report.score) ||
    report.score < 0 ||
    report.score > 100 ||
    !Number.isFinite(report.elapsed) ||
    report.elapsed < 0 ||
    !Number.isFinite(report.usedG) ||
    report.usedG < 0
  )
    throw new Error("仿真报告数值无效");
  const artifact = {
    format: "forgex-simulation-quality-audit",
    version: 1,
    source: "browser-simulation",
    modelVersion: report.provenance.modelVersion,
    basis: report.provenance.basis,
    result: {
      score: report.score,
      grade: report.grade,
      elapsedSeconds: report.elapsed,
      filamentMassG: report.usedG,
      completedAt: report.at.toISOString(),
      checks: report.checks,
    },
    warnings: [
      "数据来自浏览器仿真，不是打印机实测、现场检测或 C# 权威评分。",
      "评分是当前规则对模拟轨迹的推导，不能替代成品尺寸、强度或表面质量检测。",
    ],
  };
  const json = JSON.stringify(
    artifact,
    (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("仿真报告包含非有限数值");
      return value;
    },
    2
  );
  if (new TextEncoder().encode(json).byteLength > 262144) throw new Error("仿真审计超过 256 KiB");
  return json;
}
