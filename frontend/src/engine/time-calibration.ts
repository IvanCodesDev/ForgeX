/* FORGE·X — 打印时间校准（纯逻辑，浏览器与 Node 共用）。
   自 js/time-calibration.js 机械迁移：算法逐行保留，仅换模块壳并加类型。

   输入是至少三组「G-code 匀速估算 + 同一任务真机时长」，输出：
     actualSec = fixedOverheadSec + motionScale × plannedSec
   使用 Theil–Sen 中位斜率而不是普通最小二乘，降低单个暂停、换料或日志异常
   对模型的破坏。 */
import type { ParsedGcodeResult } from "./gcode-parser.ts";
import type { MachineLogResult } from "./machine-log.ts";

export const MIN_SAMPLES = 3;

export interface CalibrationSample {
  id?: string;
  plannedTimeSec?: number;
  plannedSec?: number;
  actualTimeSec?: number;
  actualSec?: number;
  machineId?: string;
  firmware?: string;
}

interface NormalizedRow {
  id: string;
  plannedTimeSec: number;
  actualTimeSec: number;
  machineId: string;
  firmware: string;
  predictedTimeSec?: number;
}

export interface CalibrationMetrics {
  sampleCount: number;
  maeSec: number;
  mape: number;
  rmseSec: number;
  maxApe: number;
  r2: number | null;
}

export interface TimeCalibrationModel {
  format: string;
  version: number;
  method: string;
  scope: { machineId: string; firmware: string };
  sampleCount: number;
  motionScale: number;
  fixedOverheadSec: number;
  trainingMetrics?: CalibrationMetrics;
  crossValidation?: CalibrationMetrics | null;
}

export interface DriftReport {
  status: "insufficient" | "drift" | "warning" | "stable";
  sampleCount: number;
  requiredSamples: number;
  medianApe: number | null;
  medianBias: number | null;
  p90Ape: number | null;
  thresholds?: { maxMape: number; maxBias: number };
  note: string;
}

function finite(v: unknown): number | null {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function normalize(samples: CalibrationSample[]): NormalizedRow[] {
  if (!Array.isArray(samples)) throw new Error("校准样本必须是数组");
  return samples.map((sample, i) => {
    const planned = finite(sample && (sample.plannedTimeSec != null ? sample.plannedTimeSec : sample.plannedSec));
    const actual = finite(sample && (sample.actualTimeSec != null ? sample.actualTimeSec : sample.actualSec));
    if (planned == null || planned <= 0 || actual == null || actual <= 0)
      throw new Error("校准样本 " + (i + 1) + " 缺少正数 plannedTimeSec / actualTimeSec");
    return {
      id: String(sample.id || "sample-" + (i + 1)),
      plannedTimeSec: planned,
      actualTimeSec: actual,
      machineId: sample.machineId ? String(sample.machineId) : "",
      firmware: sample.firmware ? String(sample.firmware) : "",
    };
  });
}

function fitLine(rows: NormalizedRow[]): { motionScale: number; fixedOverheadSec: number } {
  if (rows.length < MIN_SAMPLES) throw new Error("至少需要 " + MIN_SAMPLES + " 个配对任务才能校准时间模型");
  const distinct: Record<number, boolean> = {};
  rows.forEach((row) => {
    distinct[row.plannedTimeSec] = true;
  });
  if (Object.keys(distinct).length < MIN_SAMPLES)
    throw new Error("校准样本至少需要 " + MIN_SAMPLES + " 个不同的计划时长");

  const slopes: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const dx = rows[j]!.plannedTimeSec - rows[i]!.plannedTimeSec;
      if (Math.abs(dx) > 1e-9) slopes.push((rows[j]!.actualTimeSec - rows[i]!.actualTimeSec) / dx);
    }
  }
  let slope = median(slopes);
  if (slope == null || !isFinite(slope) || slope <= 0) throw new Error("校准样本无法得到正数时间倍率");
  let intercept = median(rows.map((row) => row.actualTimeSec - slope! * row.plannedTimeSec))!;

  // 负固定开销没有物理意义。约束到 0 后，用中位倍率重新估计剩余项。
  if (intercept < 0) {
    intercept = 0;
    slope = median(rows.map((row) => row.actualTimeSec / row.plannedTimeSec))!;
  }
  return { motionScale: slope!, fixedOverheadSec: intercept };
}

function metrics(rows: NormalizedRow[], predictFn: ((planned: number) => number) | null): CalibrationMetrics {
  const abs: number[] = [];
  const ape: number[] = [];
  const sq: number[] = [];
  const mean = rows.reduce((sum, row) => sum + row.actualTimeSec, 0) / rows.length;
  let ssRes = 0;
  let ssTot = 0;
  rows.forEach((row) => {
    const predicted = row.predictedTimeSec != null ? row.predictedTimeSec : predictFn!(row.plannedTimeSec);
    const err = predicted - row.actualTimeSec;
    abs.push(Math.abs(err));
    ape.push(Math.abs(err) / row.actualTimeSec);
    sq.push(err * err);
    ssRes += err * err;
    ssTot += Math.pow(row.actualTimeSec - mean, 2);
  });
  return {
    sampleCount: rows.length,
    maeSec: abs.reduce((a, b) => a + b, 0) / rows.length,
    mape: ape.reduce((a, b) => a + b, 0) / rows.length,
    rmseSec: Math.sqrt(sq.reduce((a, b) => a + b, 0) / rows.length),
    maxApe: Math.max(...ape),
    r2: ssTot > 0 ? 1 - ssRes / ssTot : null,
  };
}

export function predict(
  model: Pick<TimeCalibrationModel, "fixedOverheadSec" | "motionScale">,
  plannedTimeSec: number
): number {
  const planned = finite(plannedTimeSec);
  if (!model || planned == null || planned < 0) throw new Error("需要有效校准模型与计划时长");
  return Math.max(0, Number(model.fixedOverheadSec) + Number(model.motionScale) * planned);
}

export function evaluate(
  model: Pick<TimeCalibrationModel, "fixedOverheadSec" | "motionScale">,
  samples: CalibrationSample[]
): CalibrationMetrics {
  const rows = normalize(samples);
  if (!rows.length) throw new Error("评估样本不能为空");
  return metrics(rows, (planned) => predict(model, planned));
}

export function fit(
  samples: CalibrationSample[],
  opt?: { machineId?: string; firmware?: string }
): TimeCalibrationModel {
  opt = opt || {};
  const rows = normalize(samples);
  const line = fitLine(rows);
  const model: TimeCalibrationModel = {
    format: "forgex-time-calibration",
    version: 1,
    method: "theil-sen",
    scope: {
      machineId: String(opt.machineId || ""),
      firmware: String(opt.firmware || ""),
    },
    sampleCount: rows.length,
    motionScale: line.motionScale,
    fixedOverheadSec: line.fixedOverheadSec,
  };
  model.trainingMetrics = evaluate(model, rows);

  if (rows.length >= 4) {
    const predictions: NormalizedRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const training = rows.filter((_row, idx) => idx !== i);
      const fold = fitLine(training);
      predictions.push({
        id: rows[i]!.id,
        plannedTimeSec: rows[i]!.plannedTimeSec,
        actualTimeSec: rows[i]!.actualTimeSec,
        machineId: rows[i]!.machineId,
        firmware: rows[i]!.firmware,
        predictedTimeSec: Math.max(0, fold.fixedOverheadSec + fold.motionScale * rows[i]!.plannedTimeSec),
      });
    }
    model.crossValidation = metrics(predictions, null);
  } else {
    model.crossValidation = null;
  }
  return model;
}

export function fromPair(
  gcode: ParsedGcodeResult,
  log: MachineLogResult,
  meta?: { id?: string; machineId?: string; firmware?: string }
): NormalizedRow {
  if (!gcode || !gcode.stats || !log) throw new Error("需要 G-code 解析结果与对应真机日志");
  if (!(gcode.stats.timeSec > 0) || !(log.actualTimeSec != null && log.actualTimeSec > 0))
    throw new Error("配对任务缺少有效计划时长或实测时长");
  meta = meta || {};
  return {
    id: String(meta.id || log.name || "paired-job"),
    plannedTimeSec: gcode.stats.timeSec,
    actualTimeSec: log.actualTimeSec,
    machineId: String(meta.machineId || log.machineId || ""),
    firmware: String(meta.firmware || log.firmware || ""),
  };
}

export function observation(gcode: ParsedGcodeResult, log: MachineLogResult) {
  const row = fromPair(gcode, log);
  return {
    plannedTimeSec: row.plannedTimeSec,
    actualTimeSec: row.actualTimeSec,
    deltaSec: row.actualTimeSec - row.plannedTimeSec,
    rawRatio: row.actualTimeSec / row.plannedTimeSec,
    eligibleForCalibration: true,
    note: "单个任务只能形成观测倍率；至少三个不同时长的配对任务才能拟合固定开销与运动倍率。",
  };
}

/**
 * 用后续生产观测检查已发布模型是否漂移。
 * 少于 minSamples 只返回 insufficient，不用一两次偶然暂停宣布模型失效。
 */
export function detectDrift(
  model: Pick<TimeCalibrationModel, "fixedOverheadSec" | "motionScale">,
  samples: CalibrationSample[],
  opt?: { minSamples?: number; maxMape?: number; maxBias?: number }
): DriftReport {
  opt = opt || {};
  const rows = normalize(samples);
  const minSamples = Math.max(3, Math.floor(finite(opt.minSamples) || 5));
  let maxMape = finite(opt.maxMape);
  let maxBias = finite(opt.maxBias);
  if (maxMape == null) maxMape = 0.2;
  if (maxBias == null) maxBias = 0.12;
  if (rows.length < minSamples) {
    return {
      status: "insufficient",
      sampleCount: rows.length,
      requiredSamples: minSamples,
      medianApe: null,
      medianBias: null,
      p90Ape: null,
      note: "观测不足，继续收集同一机型与固件的配对任务。",
    };
  }

  const signed: number[] = [];
  const absolute: number[] = [];
  rows.forEach((row) => {
    const predicted = predict(model, row.plannedTimeSec);
    const err = predicted > 0 ? (row.actualTimeSec - predicted) / predicted : 0;
    signed.push(err);
    absolute.push(Math.abs(err));
  });
  const sortedAbs = absolute.slice().sort((a, b) => a - b);
  const p90Index = Math.min(sortedAbs.length - 1, Math.ceil(sortedAbs.length * 0.9) - 1);
  const medianApe = median(absolute)!;
  const medianBias = median(signed)!;
  const warning = medianApe > maxMape * 0.8 || Math.abs(medianBias) > maxBias * 0.8;
  const drift = medianApe > maxMape || Math.abs(medianBias) > maxBias;
  return {
    status: drift ? "drift" : warning ? "warning" : "stable",
    sampleCount: rows.length,
    requiredSamples: minSamples,
    medianApe,
    medianBias,
    p90Ape: sortedAbs[p90Index]!,
    thresholds: { maxMape, maxBias },
    note: drift
      ? "后续观测已超过模型阈值，应停止自动应用并重新审查训练集。"
      : warning
        ? "误差接近阈值，建议增加 holdout 并检查固件或工艺变更。"
        : "后续观测仍在声明阈值内。",
  };
}
