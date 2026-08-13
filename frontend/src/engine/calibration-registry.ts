/* FORGE·X — 版本化时间校准包注册表（声明式 JSON，不执行社区代码）。
   自 js/calibration-registry.js 机械迁移：算法逐行保留，仅换模块壳并加类型。

   只有满足真实来源 + holdout 门槛的 active 模型会被自动匹配。
   synthetic-conformance 只能以 demonstration-only 导入，默认永不参与用户估算。 */
import { detectDrift, predict, type CalibrationSample, type DriftReport } from "./time-calibration.ts";

const STORAGE_KEY = "forgex-calibration-bundles-v1";
export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_OBSERVATIONS = 50;

export interface CalibrationBundleSource {
  license: string;
  note: string;
}

export interface CalibrationModelEntry {
  id: string;
  status: "candidate" | "active" | "retired" | "demonstration-only";
  scope: { machineId: string; firmware: string; material?: string };
  algorithm: string;
  trainedAt: string;
  coefficients: { motionScale: number; fixedOverheadSec: number; sampleCount: number };
  validation: { holdoutSamples: number; mape: number; maxApe: number; medianBias: number; evaluatedAt: string };
  thresholds: { maxMape: number; maxBias: number; minDriftSamples: number };
  trainingSetSha256: string;
}

export interface CalibrationBundle {
  $schema?: string;
  format: string;
  version: number;
  id: string;
  revision: number;
  createdAt: string;
  provenance: string;
  source: CalibrationBundleSource;
  models: CalibrationModelEntry[];
}

export interface RegisteredModel extends CalibrationModelEntry {
  bundleId: string;
  bundleRevision: number;
  provenance: string;
  source: CalibrationBundleSource;
}

export interface CalibrationEstimate {
  predictedTimeSec: number;
  lowerTimeSec: number;
  upperTimeSec: number;
  uncertainty: number;
  modelId: string;
  provenance: string;
}

type RawRecord = Record<string, unknown>;

let bundles: CalibrationBundle[] = [];
let models: RegisteredModel[] = [];
let observations: Record<string, Array<CalibrationSample & { id: string }>> = {};

function storage(): Storage | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function finite(v: unknown): number | null {
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function ownKeys(obj: unknown, allowed: string[], at: string, errors: string[]): obj is RawRecord {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    errors.push(at + " 必须是对象");
    return false;
  }
  Object.keys(obj).forEach((key) => {
    if (allowed.indexOf(key) < 0) errors.push(at + " 含未知字段 " + key);
  });
  return true;
}
function idOk(v: unknown): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(text(v));
}
function dateOk(v: unknown): boolean {
  return !!text(v) && isFinite(Date.parse(text(v)));
}
function inRange(v: unknown, min: number, max: number): boolean {
  const n = finite(v);
  return n != null && n >= min && n <= max;
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
function provenanceReal(v: unknown): boolean {
  return v === "real-anonymized" || v === "real-consented";
}
function key(v: unknown): string {
  return text(v).toLowerCase();
}

export function validateBundle(raw: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (
    !ownKeys(
      raw,
      ["$schema", "format", "version", "id", "revision", "createdAt", "provenance", "source", "models"],
      "bundle",
      errors
    )
  )
    return { ok: false, errors };
  if (raw.format !== "forgex-calibration-bundle") errors.push("format 必须是 forgex-calibration-bundle");
  if (raw.version !== 1) errors.push("version 必须是 1");
  if (!idOk(raw.id)) errors.push("bundle.id 格式无效");
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 1) errors.push("revision 必须是正整数");
  if (!dateOk(raw.createdAt)) errors.push("createdAt 必须是 ISO 日期");
  if (["synthetic-conformance", "real-anonymized", "real-consented"].indexOf(raw.provenance as string) < 0)
    errors.push("provenance 不受支持");
  if (ownKeys(raw.source, ["license", "note"], "source", errors)) {
    if (!text(raw.source.license)) errors.push("source.license 必填");
    if (text(raw.source.note).length < 20) errors.push("source.note 至少 20 个字符");
  }
  if (!Array.isArray(raw.models) || !raw.models.length) {
    errors.push("models 至少需要一项");
    return { ok: false, errors };
  }

  const ids: Record<string, boolean> = {};
  (raw.models as unknown[]).forEach((modelRaw, i) => {
    const at = "models[" + i + "]";
    if (
      !ownKeys(
        modelRaw,
        [
          "id",
          "status",
          "scope",
          "algorithm",
          "trainedAt",
          "coefficients",
          "validation",
          "thresholds",
          "trainingSetSha256",
        ],
        at,
        errors
      )
    )
      return;
    const model = modelRaw as unknown as CalibrationModelEntry;
    if (!idOk(model.id)) errors.push(at + ".id 格式无效");
    if (ids[model.id]) errors.push(at + ".id 重复");
    ids[model.id] = true;
    if (["candidate", "active", "retired", "demonstration-only"].indexOf(model.status) < 0)
      errors.push(at + ".status 不受支持");
    if (model.algorithm !== "theil-sen") errors.push(at + ".algorithm 仅支持 theil-sen");
    if (!dateOk(model.trainedAt)) errors.push(at + ".trainedAt 必须是 ISO 日期");
    if (!/^[a-f0-9]{64}$/.test(text(model.trainingSetSha256))) errors.push(at + ".trainingSetSha256 必须是 SHA-256");

    if (ownKeys(model.scope, ["machineId", "firmware", "material"], at + ".scope", errors)) {
      if (!text(model.scope.machineId)) errors.push(at + ".scope.machineId 必填");
      if (!text(model.scope.firmware)) errors.push(at + ".scope.firmware 必填");
      if (model.scope.material != null && !text(model.scope.material)) errors.push(at + ".scope.material 不能为空");
    }
    if (ownKeys(model.coefficients, ["motionScale", "fixedOverheadSec", "sampleCount"], at + ".coefficients", errors)) {
      if (!inRange(model.coefficients.motionScale, 0.1, 10)) errors.push(at + ".coefficients.motionScale 超出 0.1–10");
      if (!inRange(model.coefficients.fixedOverheadSec, 0, 7200))
        errors.push(at + ".coefficients.fixedOverheadSec 超出 0–7200");
      if (!Number.isInteger(model.coefficients.sampleCount) || model.coefficients.sampleCount < 3)
        errors.push(at + ".coefficients.sampleCount 至少为 3");
    }
    if (
      ownKeys(
        model.validation,
        ["holdoutSamples", "mape", "maxApe", "medianBias", "evaluatedAt"],
        at + ".validation",
        errors
      )
    ) {
      if (!Number.isInteger(model.validation.holdoutSamples) || model.validation.holdoutSamples < 0)
        errors.push(at + ".validation.holdoutSamples 必须是非负整数");
      if (!inRange(model.validation.mape, 0, 1)) errors.push(at + ".validation.mape 超出 0–1");
      if (!inRange(model.validation.maxApe, 0, 5)) errors.push(at + ".validation.maxApe 超出 0–5");
      if (!inRange(model.validation.medianBias, -1, 1)) errors.push(at + ".validation.medianBias 超出 -1–1");
      if (!dateOk(model.validation.evaluatedAt)) errors.push(at + ".validation.evaluatedAt 必须是 ISO 日期");
    }
    if (ownKeys(model.thresholds, ["maxMape", "maxBias", "minDriftSamples"], at + ".thresholds", errors)) {
      if (!inRange(model.thresholds.maxMape, 0.01, 0.5)) errors.push(at + ".thresholds.maxMape 超出 0.01–0.5");
      if (!inRange(model.thresholds.maxBias, 0.01, 0.5)) errors.push(at + ".thresholds.maxBias 超出 0.01–0.5");
      if (!Number.isInteger(model.thresholds.minDriftSamples) || model.thresholds.minDriftSamples < 3)
        errors.push(at + ".thresholds.minDriftSamples 至少为 3");
    }

    if (model.status === "active") {
      if (!provenanceReal(raw.provenance)) errors.push(at + " active 模型必须来自真实数据");
      if (model.validation && model.validation.holdoutSamples < 5)
        errors.push(at + " active 模型至少需要 5 个 holdout");
      if (
        model.validation &&
        model.thresholds &&
        (model.validation.mape > model.thresholds.maxMape ||
          Math.abs(model.validation.medianBias) > model.thresholds.maxBias)
      )
        errors.push(at + " holdout 指标未通过启用阈值");
    }
    if (model.status === "demonstration-only" && raw.provenance !== "synthetic-conformance")
      errors.push(at + " demonstration-only 必须使用 synthetic-conformance");
    if (raw.provenance === "synthetic-conformance" && model.status !== "demonstration-only")
      errors.push(at + " 合成校准只能是 demonstration-only");
  });
  return { ok: errors.length === 0, errors };
}

function rebuild(): void {
  models = [];
  bundles.forEach((bundle) => {
    bundle.models.forEach((model) => {
      const item = clone(model) as RegisteredModel;
      item.bundleId = bundle.id;
      item.bundleRevision = bundle.revision;
      item.provenance = bundle.provenance;
      item.source = clone(bundle.source);
      models.push(item);
    });
  });
}

function save(): void {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify({ bundles, observations }));
  } catch {
    // 隐私模式或配额不足时保持当前会话可用。
  }
}

export function reload(): RegisteredModel[] {
  bundles = [];
  observations = {};
  const ls = storage();
  if (ls) {
    try {
      const saved = JSON.parse(ls.getItem(STORAGE_KEY) || "{}") as {
        bundles?: unknown[];
        observations?: Record<string, Array<CalibrationSample & { id: string }>>;
      };
      if (Array.isArray(saved.bundles)) {
        saved.bundles.forEach((bundle) => {
          if (validateBundle(bundle).ok) bundles.push(bundle as CalibrationBundle);
        });
      }
      if (saved.observations && typeof saved.observations === "object") observations = saved.observations;
    } catch {
      bundles = [];
      observations = {};
    }
  }
  rebuild();
  return list();
}

export function importBundle(raw: unknown): { id: string; revision: number; models: string[] } {
  const size = JSON.stringify(raw || {}).length;
  if (size > MAX_BYTES) throw new Error("校准包超过 2MB");
  const checked = validateBundle(raw);
  if (!checked.ok) throw new Error(checked.errors.join("；"));
  const next = clone(raw) as CalibrationBundle;
  let existingIndex = -1;
  for (let i = 0; i < bundles.length; i++) {
    if (bundles[i]!.id === next.id) existingIndex = i;
    if (bundles[i]!.id !== next.id) {
      const otherIds: Record<string, boolean> = {};
      bundles[i]!.models.forEach((m) => {
        otherIds[m.id] = true;
      });
      next.models.forEach((m) => {
        if (otherIds[m.id]) throw new Error("模型 ID 已由其他 bundle 使用：" + m.id);
      });
    }
  }
  if (existingIndex >= 0) {
    if (next.revision <= bundles[existingIndex]!.revision) throw new Error("校准包 revision 必须高于已导入版本");
    bundles[existingIndex] = next;
  } else {
    bundles.push(next);
  }
  rebuild();
  save();
  return {
    id: next.id,
    revision: next.revision,
    models: next.models.map((m) => m.id),
  };
}

export function list(): RegisteredModel[] {
  return models.map(clone);
}

export function match(
  context?: { machineId?: string; firmware?: string; material?: string },
  opt?: { includeDemonstration?: boolean; includeDrifted?: boolean }
): RegisteredModel | null {
  context = context || {};
  opt = opt || {};
  const machineId = key(context.machineId);
  const firmware = key(context.firmware);
  const material = key(context.material);
  if (!machineId || !firmware) return null;
  const candidates = models.filter((model) => {
    if (model.status !== "active" && !(opt!.includeDemonstration && model.status === "demonstration-only"))
      return false;
    if (key(model.scope.machineId) !== machineId || key(model.scope.firmware) !== firmware) return false;
    if (model.scope.material && model.scope.material !== "*" && key(model.scope.material) !== material) return false;
    return opt!.includeDrifted || model.status !== "active" || drift(model).status !== "drift";
  });
  candidates.sort((a, b) => {
    const materialA = a.scope.material && a.scope.material !== "*" ? 1 : 0;
    const materialB = b.scope.material && b.scope.material !== "*" ? 1 : 0;
    return materialB - materialA || b.bundleRevision - a.bundleRevision;
  });
  return candidates.length ? clone(candidates[0]!) : null;
}

export function estimate(model: RegisteredModel, plannedTimeSec: number): CalibrationEstimate {
  if (!model || !model.coefficients) throw new Error("缺少可用校准模型");
  const core = {
    motionScale: model.coefficients.motionScale,
    fixedOverheadSec: model.coefficients.fixedOverheadSec,
  };
  const predicted = predict(core, plannedTimeSec);
  const uncertainty = Math.max(0.03, model.validation.mape, Math.abs(model.validation.medianBias));
  return {
    predictedTimeSec: predicted,
    lowerTimeSec: Math.max(0, predicted * (1 - uncertainty)),
    upperTimeSec: predicted * (1 + uncertainty),
    uncertainty,
    modelId: model.id,
    provenance: model.provenance,
  };
}

export function recordObservation(
  model: RegisteredModel,
  observation: { id?: string; plannedTimeSec: number; actualTimeSec: number }
): DriftReport {
  if (!model || !model.id) throw new Error("缺少模型 ID");
  const row = {
    id: String(observation.id || "observation-" + Date.now()),
    plannedTimeSec: Number(observation.plannedTimeSec),
    actualTimeSec: Number(observation.actualTimeSec),
    machineId: model.scope.machineId,
    firmware: model.scope.firmware,
  };
  let list = Array.isArray(observations[model.id]) ? observations[model.id]! : [];
  list = list.filter((item) => item.id !== row.id);
  list.push(row);
  if (list.length > MAX_OBSERVATIONS) list = list.slice(list.length - MAX_OBSERVATIONS);
  observations[model.id] = list;
  save();
  return drift(model);
}

export function drift(model: RegisteredModel): DriftReport {
  const list = Array.isArray(observations[model.id]) ? observations[model.id]! : [];
  return detectDrift(model.coefficients, list, {
    minSamples: model.thresholds.minDriftSamples,
    maxMape: model.thresholds.maxMape,
    maxBias: model.thresholds.maxBias,
  });
}

export function clear(): void {
  bundles = [];
  models = [];
  observations = {};
  const ls = storage();
  if (ls) {
    try {
      ls.removeItem(STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
  }
}

reload();
