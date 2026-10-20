import { forgeXApiPath, type GCodeCostEstimate, type GCodeCostInputs } from "../generated/forgex-api";
import type { AuthorityAnalysisResponse } from "./gcode-authority";
import { createNodeRequestInit, detectRuntimeMode, resolveNodeApiBase } from "./runtime";

export const COST_LIMITS = {
  averagePowerWatts: 100000,
  electricityCnyPerKwh: 100,
  machineCnyPerHour: 100000,
  materialCnyPerKg: 5000,
} as const;
export type CostField = keyof typeof COST_LIMITS;
export function normalizeCostInputs(inputs: GCodeCostInputs): GCodeCostInputs {
  for (const field of Object.keys(COST_LIMITS) as CostField[]) {
    const value = inputs[field];
    if (
      value !== null &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > COST_LIMITS[field])
    )
      throw new Error("成本输入超出允许范围");
  }
  if (typeof inputs.evidence !== "string") throw new Error("请输入功率或费率的依据");
  const evidence = inputs.evidence.replace(/\r\n/g, "\n").trim();
  if (
    evidence.length > 500 ||
    [...evidence].some(
      (c) => (c.charCodeAt(0) < 32 && c !== "\n" && c !== "\t") || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)
    ) ||
    (Object.keys(COST_LIMITS).some((key) => inputs[key as CostField] !== null) && !evidence)
  )
    throw new Error("填写数值时须提供 1–500 字的输入依据");
  return { ...inputs, evidence };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("成本响应结构无效");
  return value as Record<string, unknown>;
}
export function validateCostEstimate(
  value: unknown,
  jobId: string,
  source: AuthorityAnalysisResponse,
  rawInputs: GCodeCostInputs
): GCodeCostEstimate {
  const root = object(value),
    basis = object(root.basis),
    inputs = object(root.inputs),
    totals = object(root.totals);
  const expected = normalizeCostInputs(rawInputs);
  for (const [key, maximum] of [
    ["durationSeconds", 31536000],
    ["filamentMassG", 1000000],
  ] as const) {
    const number = basis[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > maximum)
      throw new Error("成本来源数值超出支持范围");
  }
  if (
    root.schemaVersion !== "1.0" ||
    root.modelVersion !== "forgex-gcode-cost/2" ||
    root.currency !== "CNY" ||
    typeof root.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(root.fingerprint)
  )
    throw new Error("成本引擎或指纹无效");
  if (
    basis.jobId !== jobId ||
    basis.inputSha256 !== source.input.sha256 ||
    basis.profileFingerprint !== source.profile.fingerprint ||
    basis.analysisEngineVersion !== source.engine.version ||
    basis.durationSeconds !== source.summary.estimatedTimeSeconds ||
    basis.filamentMassG !== source.summary.filamentMassG
  )
    throw new Error("成本结果与当前 G-code 作业不一致");
  for (const key of [...Object.keys(COST_LIMITS), "evidence"])
    if (inputs[key] !== expected[key as keyof GCodeCostInputs]) throw new Error("成本结果与当前输入不一致");
  const missing = (Object.keys(COST_LIMITS) as CostField[]).filter((key) => expected[key] === null);
  if (
    !Array.isArray(root.missingInputs) ||
    root.missingInputs.length !== missing.length ||
    new Set(root.missingInputs).size !== missing.length ||
    !missing.every((key) => (root.missingInputs as unknown[]).includes(key)) ||
    totals.isComplete !== (missing.length === 0)
  )
    throw new Error("成本完整性状态无效");
  const energy =
    expected.averagePowerWatts === null
      ? null
      : (source.summary.estimatedTimeSeconds * expected.averagePowerWatts) / 3600000;
  const material =
    expected.materialCnyPerKg === null ? null : (source.summary.filamentMassG * expected.materialCnyPerKg) / 1000;
  const electricity =
    energy === null || expected.electricityCnyPerKwh === null ? null : energy * expected.electricityCnyPerKwh;
  const machine =
    expected.machineCnyPerHour === null
      ? null
      : (source.summary.estimatedTimeSeconds * expected.machineCnyPerHour) / 3600;
  const match = (key: string, expectedValue: number | null, tolerance = 0.000002) => {
    const actual = totals[key];
    if (
      expectedValue === null
        ? actual !== null
        : typeof actual !== "number" ||
          !Number.isFinite(actual) ||
          actual < 0 ||
          Math.abs(actual - expectedValue) > Math.max(tolerance, Math.abs(expectedValue) * 2e-15)
    )
      throw new Error("成本分项计算不一致");
  };
  match("energyKwh", energy, 6e-10);
  match("materialCostCny", material);
  match("electricityCostCny", electricity);
  match("machineTimeCostCny", machine);
  match(
    "totalCostCny",
    missing.length
      ? null
      : (totals.materialCostCny as number) +
          (totals.electricityCostCny as number) +
          (totals.machineTimeCostCny as number)
  );
  if (
    !Array.isArray(root.warnings) ||
    root.warnings.length > 4 ||
    root.warnings.some((w) => typeof w !== "string" || w.length > 500)
  )
    throw new Error("成本提示无效");
  return root as unknown as GCodeCostEstimate;
}
export async function requestCostEstimate(
  jobId: string,
  source: AuthorityAnalysisResponse,
  rawInputs: GCodeCostInputs,
  env: ImportMetaEnv,
  signal: AbortSignal
): Promise<GCodeCostEstimate> {
  if (
    detectRuntimeMode(typeof window === "undefined" ? { protocol: "http:" } : window.location, env).kind === "offline"
  )
    throw new Error("离线模式不请求后端成本估算");
  if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error("成本估算缺少有效作业");
  const inputs = normalizeCostInputs(rawInputs);
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("成本估算请求超时")), 15000);
  try {
    const response = await fetch(
      resolveNodeApiBase(env) + forgeXApiPath("estimateGCodeCost", { id: jobId }),
      createNodeRequestInit(env, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inputs),
        signal: controller.signal,
      })
    );
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { title?: unknown } | null;
      throw new Error(
        `成本估算 HTTP ${response.status}${typeof problem?.title === "string" ? "：" + problem.title.slice(0, 240) : ""}`
      );
    }
    return validateCostEstimate(await response.json(), jobId, source, inputs);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
