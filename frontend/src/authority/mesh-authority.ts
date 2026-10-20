import { createNodeRequestInit, detectRuntimeMode, resolveNodeApiBase } from "./runtime";
import { forgeXApiOperations, type MeshAnalysisResult } from "../generated/forgex-api";

export type MeshAuthorityState = {
  readonly status: "idle" | "running" | "done" | "error";
  readonly result: MeshAnalysisResult | null;
  readonly error: string | null;
};
export const MESH_AUTHORITY_IDLE: MeshAuthorityState = { status: "idle", result: null, error: null };

export function meshAuthorityEnabled(
  env: ImportMetaEnv,
  location: Pick<Location, "protocol"> = typeof window === "undefined" ? { protocol: "http:" } : window.location
): boolean {
  return detectRuntimeMode(location, env).kind !== "offline" && env.VITE_MESH_AUTHORITY === "dotnet";
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("网格权威响应结构无效");
  return value as Record<string, unknown>;
}
function numeric(value: unknown, integer = false, minimum = 0, maximum = Number.MAX_VALUE): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error("网格权威响应数值无效");
  return value;
}

export function parseMeshAuthorityResponse(
  value: unknown,
  sha256: string,
  bytes: number,
  format: "stl" | "3mf"
): MeshAnalysisResult {
  const root = record(value);
  if (
    root.schemaVersion !== "1.0" ||
    root.engine !== "forgex-mesh-csharp" ||
    typeof root.engineVersion !== "string" ||
    !root.engineVersion.trim() ||
    root.engineVersion.length > 64
  )
    throw new Error("网格权威引擎或契约不匹配");
  if (!/^[a-f0-9]{64}$/.test(sha256) || root.sha256 !== sha256 || root.bytes !== bytes)
    throw new Error("网格权威结果与当前文件 SHA-256 / 字节数不一致");
  if (format === "3mf" ? root.format !== "3mf" : !["stl-binary", "stl-ascii"].includes(String(root.format)))
    throw new Error("网格权威格式不匹配");
  if (
    root.unit !== null &&
    !["micron", "millimeter", "centimeter", "inch", "foot", "meter"].includes(String(root.unit))
  )
    throw new Error("网格权威单位无效");
  if (format === "stl" && root.unit !== null) throw new Error("STL 不应声明单位");
  if (format === "3mf" && root.unit === null) throw new Error("3MF 必须提供解释单位");
  numeric(root.bytes, true, 1, 64 * 1024 * 1024);
  numeric(root.triangleCount, true, 1, 250_000);
  numeric(root.droppedTriangles, true, 0, 250_000 - (root.triangleCount as number));
  numeric(root.objectCount, true, 1, 4096);
  const size = record(root.sizeMm);
  for (const key of ["x", "y", "z"]) numeric(size[key], false, 0, 2_000_000);
  numeric(root.surfaceAreaCm2);
  const topology = record(root.topology);
  for (const key of ["boundaryEdges", "nonManifoldEdges", "inconsistentEdges"])
    numeric(topology[key], true, 0, 3 * (root.triangleCount as number));
  const closed = topology.boundaryEdges === 0 && topology.nonManifoldEdges === 0;
  const oriented = topology.inconsistentEdges === 0;
  if (
    topology.closedEdgeManifold !== closed ||
    topology.orientationConsistent !== oriented ||
    topology.selfIntersectionChecked !== false
  )
    throw new Error("网格权威拓扑状态不一致");
  if (closed && oriented && root.objectCount === 1) numeric(root.volumeCm3);
  else if (root.volumeCm3 !== null) throw new Error("未闭合或多对象网格不应给出体积数值");
  if (
    !Array.isArray(root.warnings) ||
    root.warnings.length > 16 ||
    root.warnings.some((w) => typeof w !== "string" || w.length > 1024)
  )
    throw new Error("网格权威提示结构无效");
  return root as unknown as MeshAnalysisResult;
}

export async function requestMeshAuthority(
  file: File,
  sha256: string,
  env: ImportMetaEnv,
  signal: AbortSignal
): Promise<MeshAnalysisResult> {
  if (!meshAuthorityEnabled(env)) throw new Error("当前模式未启用后端网格校验");
  if (file.size < 1 || file.size > 64 * 1024 * 1024) throw new Error("网格文件大小不在 1 字节到 64 MB 范围内");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension !== "stl" && extension !== "3mf") throw new Error("网格权威校验仅支持 STL / 3MF");
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("后端网格校验请求超时")), 30_000);
  try {
    const response = await fetch(
      `${resolveNodeApiBase(env)}${forgeXApiOperations.analyzeMesh.path}?format=${extension}`,
      createNodeRequestInit(env, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
        signal: controller.signal,
      })
    );
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { title?: unknown } | null;
      const detail = typeof problem?.title === "string" ? `：${problem.title.slice(0, 240)}` : "";
      throw new Error(`后端网格校验 HTTP ${response.status}${detail}`);
    }
    return parseMeshAuthorityResponse(await response.json(), sha256, file.size, extension);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
