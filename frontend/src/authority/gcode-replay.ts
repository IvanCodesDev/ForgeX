import {
  forgeXApiPath,
  type GCodeLayerTimeline,
  type GCodeReplayCheckpoint,
  type GCodeTimelineLayer,
} from "../generated/forgex-api";
import type { AuthorityAnalysisResponse } from "./gcode-authority";
import { createNodeRequestInit, detectRuntimeMode, resolveNodeApiBase } from "./runtime";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("层计划响应结构无效");
  return value as Record<string, unknown>;
}
function near(actual: unknown, expected: number): boolean {
  return (
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-9)
  );
}
export function deriveLayerPlan(source: AuthorityAnalysisResponse) {
  const ordered = [...source.layers].sort((a, b) => (a.sourceOrder ?? -1) - (b.sourceOrder ?? -1));
  if (
    !ordered.length ||
    ordered.length > 100000 ||
    ordered.length !== source.summary.totalLayers ||
    ordered.some(
      (layer, index) =>
        layer.sourceOrder !== index ||
        !Number.isInteger(layer.index) ||
        source.layers[layer.index] !== layer ||
        !Number.isFinite(layer.timeSeconds) ||
        layer.timeSeconds < 0 ||
        !Number.isFinite(layer.filamentLengthMm) ||
        layer.filamentLengthMm < 0
    )
  )
    throw new Error("该分析未保存完整执行顺序，请重新分析原始 G-code");
  const duration = source.summary.estimatedTimeSeconds;
  const sum = source.layers.reduce((total, layer) => total + layer.timeSeconds, 0);
  if (
    !Number.isFinite(duration) ||
    duration < 0 ||
    duration > 31536000 ||
    sum > duration + Math.max(1e-9, duration * 1e-9)
  )
    throw new Error("层计划时长来源无效");
  const leading = Math.max(0, duration - sum);
  let time = leading,
    positive = 0;
  const layers: GCodeTimelineLayer[] = ordered.map((layer, sequence) => {
    const row = {
      sequence,
      layerIndex: layer.index,
      zMm: layer.zMm,
      startSeconds: time,
      endSeconds: time + layer.timeSeconds,
      durationSeconds: layer.timeSeconds,
      pathCount: layer.pathCount,
      positiveExtrusionMm: layer.filamentLengthMm,
      completedPositiveExtrusionMm: positive,
    };
    time = row.endSeconds;
    positive += layer.filamentLengthMm;
    return row;
  });
  return { layers, leading, total: time, positive };
}
function validateBasis(root: Record<string, unknown>, id: string, source: AuthorityAnalysisResponse) {
  const basis = object(root.basis);
  if (
    root.schemaVersion !== "1.0" ||
    root.modelVersion !== "forgex-gcode-layer-timeline/1" ||
    typeof root.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(root.fingerprint) ||
    basis.jobId !== id ||
    basis.inputSha256 !== source.input.sha256 ||
    basis.profileFingerprint !== source.profile.fingerprint ||
    basis.analysisEngineVersion !== source.engine.version ||
    basis.sourceMotionSeconds !== source.summary.estimatedTimeSeconds ||
    basis.netFilamentLengthM !== source.summary.filamentLengthM ||
    basis.netFilamentMassG !== source.summary.filamentMassG
  )
    throw new Error("层计划与当前 C# 作业来源不一致");
}
function validateLayer(value: unknown, expected: GCodeTimelineLayer) {
  const row = object(value);
  for (const key of Object.keys(expected) as (keyof GCodeTimelineLayer)[])
    if (
      ["sequence", "layerIndex", "pathCount"].includes(key)
        ? row[key] !== expected[key]
        : !near(row[key], expected[key])
    )
      throw new Error("层计划数值与原始分析不一致");
}
export function validateLayerTimeline(
  value: unknown,
  id: string,
  source: AuthorityAnalysisResponse,
  offset: number,
  limit = 50
): GCodeLayerTimeline {
  const root = object(value),
    plan = deriveLayerPlan(source);
  validateBasis(root, id, source);
  const rows = plan.layers.slice(offset, offset + limit);
  const next = offset + rows.length < plan.layers.length ? offset + rows.length : null;
  if (
    root.offset !== offset ||
    root.limit !== limit ||
    root.totalLayers !== plan.layers.length ||
    root.nextOffset !== next ||
    !near(root.leadingMotionSeconds, plan.leading) ||
    !near(root.totalSeconds, plan.total) ||
    !near(root.totalPositiveExtrusionMm, plan.positive) ||
    !Array.isArray(root.layers) ||
    root.layers.length !== rows.length ||
    !Array.isArray(root.warnings) ||
    root.warnings.length > 20 ||
    !root.warnings.every((v) => typeof v === "string" && v.length <= 1000)
  )
    throw new Error("层计划分页或汇总不一致");
  root.layers.forEach((row, index) => validateLayer(row, rows[index]!));
  return value as GCodeLayerTimeline;
}
export function validateReplayCheckpoint(
  value: unknown,
  id: string,
  source: AuthorityAnalysisResponse,
  elapsed: number,
  fingerprint?: string
): GCodeReplayCheckpoint {
  const root = object(value),
    plan = deriveLayerPlan(source);
  validateBasis(root, id, source);
  const completed = plan.layers.filter((layer) => layer.endSeconds <= elapsed).length;
  const active = elapsed < plan.leading ? null : (plan.layers[completed] ?? null);
  const phase = elapsed >= plan.total ? "completed" : active ? "layer" : "initial-travel";
  if (
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    elapsed > plan.total ||
    root.elapsedSeconds !== elapsed ||
    (fingerprint !== undefined && root.fingerprint !== fingerprint) ||
    root.phase !== phase ||
    root.completedLayerCount !== completed ||
    !near(root.remainingSeconds, Math.max(0, plan.total - elapsed)) ||
    !near(root.completedPositiveExtrusionMm, plan.layers[completed]?.completedPositiveExtrusionMm ?? plan.positive)
  )
    throw new Error("回放检查点与请求或来源不一致");
  if (active) {
    validateLayer(root.activeLayer, active);
    if (
      !near(root.layerElapsedSeconds, elapsed - active.startSeconds) ||
      !near(root.layerFraction, (elapsed - active.startSeconds) / active.durationSeconds)
    )
      throw new Error("当前层时间位置不一致");
  } else if (root.activeLayer !== null || root.layerElapsedSeconds !== null || root.layerFraction !== null)
    throw new Error("空驶或完成状态不应包含活动层");
  return value as GCodeReplayCheckpoint;
}
async function request(
  id: string,
  env: ImportMetaEnv,
  signal: AbortSignal,
  elapsed?: number,
  offset = 0
): Promise<unknown> {
  if (
    detectRuntimeMode(typeof window === "undefined" ? { protocol: "http:" } : window.location, env).kind === "offline"
  )
    throw new Error("离线模式不请求 C# 层计划");
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("缺少有效 C# 作业");
  signal.throwIfAborted();
  const controller = new AbortController(),
    abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("层计划请求超时")), 15000);
  try {
    const path =
      elapsed === undefined
        ? forgeXApiPath("getGCodeLayerTimeline", { id }) + `?offset=${offset}&limit=50`
        : forgeXApiPath("createGCodeReplayCheckpoint", { id });
    const response = await fetch(
      resolveNodeApiBase(env) + path,
      createNodeRequestInit(env, {
        method: elapsed === undefined ? "GET" : "POST",
        signal: controller.signal,
        ...(elapsed === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ elapsedSeconds: elapsed }) }),
      })
    );
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { title?: unknown } | null;
      throw new Error(
        `层计划 HTTP ${response.status}${typeof problem?.title === "string" ? "：" + problem.title.slice(0, 240) : ""}`
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
export async function requestLayerTimeline(
  id: string,
  source: AuthorityAnalysisResponse,
  offset: number,
  env: ImportMetaEnv,
  signal: AbortSignal
) {
  deriveLayerPlan(source);
  return validateLayerTimeline(await request(id, env, signal, undefined, offset), id, source, offset);
}
export async function requestReplayCheckpoint(
  id: string,
  source: AuthorityAnalysisResponse,
  elapsed: number,
  fingerprint: string | undefined,
  env: ImportMetaEnv,
  signal: AbortSignal
) {
  const plan = deriveLayerPlan(source);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > plan.total) throw new Error("回放时间超出层计划范围");
  return validateReplayCheckpoint(await request(id, env, signal, elapsed), id, source, elapsed, fingerprint);
}
