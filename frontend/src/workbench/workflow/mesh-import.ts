/* STL / 3MF 导入的主线程客户端：Worker 边界 + 主线程兜底（Stage 9.3 前半）。

   默认走 mesh-import-worker（读取/哈希/解析/归一化全部离主线程），主线程只把
   Transferable 顶点缓冲装配成可切片模型；Worker 基建不可用时退回主线程同一
   parseMeshBuffer 路径（结果逐位一致）。解析类错误不触发回退。 */
import { sha256 } from "../../engine/gcode-parser";
import { MAX_MESH_BYTES, parseMeshBuffer, type MeshImportPayload } from "../../engine/mesh-import";
import MeshImportWorkerCtor from "./mesh-import-worker?worker&inline";
import {
  classifyMeshError,
  type MeshImportErrorCode,
  type MeshImportPhase,
  type MeshImportRequest,
  type MeshImportWorkerReply,
} from "./mesh-import-protocol";

export type { MeshImportErrorCode, MeshImportPhase } from "./mesh-import-protocol";

const IMPORT_TIMEOUT_MS = 180_000;

export interface MeshImportProgress {
  readonly phase: MeshImportPhase;
  readonly progress: number;
}

export interface MeshImportSuccess {
  readonly mesh: MeshImportPayload;
  readonly sha256: string;
  readonly via: "worker" | "main";
}

export interface MeshImportHandle {
  readonly promise: Promise<MeshImportSuccess>;
  cancel(): void;
}

export class MeshImportError extends Error {
  readonly code: MeshImportErrorCode;
  readonly phase: MeshImportPhase | null;
  constructor(code: MeshImportErrorCode, message: string, phase?: MeshImportPhase) {
    super(message);
    this.name = "MeshImportError";
    this.code = code;
    this.phase = phase ?? null;
  }
}

let nextRequestId = 1;

async function parseOnMainThread(
  file: File,
  onProgress: ((progress: MeshImportProgress) => void) | undefined,
  checkActive: () => void
): Promise<MeshImportSuccess> {
  let phase: MeshImportPhase = "read";
  try {
    if (file.size > MAX_MESH_BYTES)
      throw new Error(`网格文件超过 ${Math.round(MAX_MESH_BYTES / 1024 / 1024)}MB，请先精简`);
    onProgress?.({ phase: "read", progress: 0 });
    checkActive();
    const buffer = await file.arrayBuffer();
    checkActive();
    phase = "hash";
    const digest = await sha256(buffer);
    checkActive();
    phase = "parse";
    onProgress?.({ phase: "parse", progress: 0 });
    const mesh = await parseMeshBuffer(buffer, file.name);
    checkActive();
    onProgress?.({ phase: "parse", progress: 1 });
    return { mesh, sha256: digest, via: "main" };
  } catch (error) {
    if (error instanceof MeshImportError) throw error;
    const message = String((error as Error)?.message ?? error);
    throw new MeshImportError(classifyMeshError(message, phase), message, phase);
  }
}

function markImportVia(via: MeshImportSuccess["via"]): void {
  (globalThis as { __forgexMeshImportVia?: string }).__forgexMeshImportVia = via;
}

export function importMeshFile(file: File, onProgress?: (progress: MeshImportProgress) => void): MeshImportHandle {
  let worker: Worker | null = null;
  let watchdog: number | null = null;
  let settled = false;
  let fallback = false;
  let rejectPromise: (error: unknown) => void = () => {};

  const cleanup = () => {
    if (watchdog != null) window.clearTimeout(watchdog);
    watchdog = null;
    worker?.terminate();
    worker = null;
  };

  const promise = new Promise<MeshImportSuccess>((resolve, reject) => {
    rejectPromise = reject;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const settle = (value: MeshImportSuccess) => {
      if (settled) return;
      settled = true;
      cleanup();
      markImportVia(value.via);
      resolve(value);
    };
    const checkActive = () => {
      if (settled) throw new MeshImportError("CANCELLED", "网格导入已结束");
    };
    const report = (progress: MeshImportProgress) => {
      if (!settled) onProgress?.(progress);
    };
    const fallbackToMainThread = () => {
      if (settled || fallback) return;
      fallback = true;
      worker?.terminate();
      worker = null;
      // 保留看门狗，取消后阻止后续哈希、解析与进度回调。
      parseOnMainThread(file, report, checkActive).then(settle, fail);
    };
    watchdog = window.setTimeout(() => {
      fail(new MeshImportError("TIMEOUT", "网格解析超时，已结束本次导入"));
    }, IMPORT_TIMEOUT_MS);

    try {
      worker = new MeshImportWorkerCtor({ name: "forgex-mesh" });
    } catch {
      worker = null;
    }
    if (!worker) {
      fallbackToMainThread();
      return;
    }

    const requestId = nextRequestId++;
    let workerReplied = false;

    worker.onmessage = (event: MessageEvent<MeshImportWorkerReply>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId || settled || fallback) return;
      workerReplied = true;
      if (message.type === "progress") {
        report({ phase: message.phase, progress: message.progress });
        return;
      }
      if (message.type === "error") {
        fail(new MeshImportError(message.code, message.message, message.phase));
        return;
      }
      report({ phase: "rebuild", progress: 1 });
      settle({ mesh: message.mesh, sha256: message.sha256, via: "worker" });
    };
    worker.onerror = (event) => {
      if (settled || fallback) return;
      if (!workerReplied) {
        event.preventDefault();
        fallbackToMainThread();
        return;
      }
      fail(new MeshImportError("WORKER_FAILURE", event.message || "网格解析 Worker 异常退出"));
    };
    worker.onmessageerror = () => {
      if (!fallback) fail(new MeshImportError("WORKER_FAILURE", "无法读取网格后台结果"));
    };
    try {
      worker.postMessage({ type: "parse", requestId, file } satisfies MeshImportRequest);
    } catch {
      if (!workerReplied) fallbackToMainThread();
      else fail(new MeshImportError("WORKER_FAILURE", "无法发送网格后台任务"));
    }
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new MeshImportError("CANCELLED", "网格导入已取消"));
    },
  };
}
