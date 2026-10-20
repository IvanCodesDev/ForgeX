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
  onProgress?: (progress: MeshImportProgress) => void
): Promise<MeshImportSuccess> {
  let phase: MeshImportPhase = "read";
  try {
    if (file.size > MAX_MESH_BYTES)
      throw new Error(`网格文件超过 ${Math.round(MAX_MESH_BYTES / 1024 / 1024)}MB，请先精简`);
    onProgress?.({ phase: "read", progress: 0 });
    const buffer = await file.arrayBuffer();
    phase = "hash";
    const digest = await sha256(buffer);
    phase = "parse";
    onProgress?.({ phase: "parse", progress: 0 });
    const mesh = await parseMeshBuffer(buffer, file.name);
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
    const fallbackToMainThread = () => {
      cleanup();
      parseOnMainThread(file, onProgress).then(settle, fail);
    };

    try {
      worker = new MeshImportWorkerCtor();
    } catch {
      worker = null;
    }
    if (!worker) {
      fallbackToMainThread();
      return;
    }

    const requestId = nextRequestId++;
    let workerReplied = false;
    watchdog = window.setTimeout(() => {
      fail(new MeshImportError("TIMEOUT", "网格解析超时，已终止后台任务"));
    }, IMPORT_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<MeshImportWorkerReply>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId || settled) return;
      workerReplied = true;
      if (message.type === "progress") {
        onProgress?.({ phase: message.phase, progress: message.progress });
        return;
      }
      if (message.type === "error") {
        fail(new MeshImportError(message.code, message.message, message.phase));
        return;
      }
      onProgress?.({ phase: "rebuild", progress: 1 });
      settle({ mesh: message.mesh, sha256: message.sha256, via: "worker" });
    };
    worker.onerror = (event) => {
      if (settled) return;
      if (!workerReplied) {
        event.preventDefault();
        fallbackToMainThread();
        return;
      }
      fail(new MeshImportError("WORKER_FAILURE", event.message || "网格解析 Worker 异常退出"));
    };
    worker.postMessage({ type: "parse", requestId, file } satisfies MeshImportRequest);
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
