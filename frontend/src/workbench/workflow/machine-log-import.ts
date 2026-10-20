import type { MachineLogSummary } from "../../engine/machine-log-summary";
import MachineLogImportWorkerCtor from "./machine-log-import-worker?worker&inline";
import {
  parseMachineLogFile,
  validateMachineLogFile,
  type MachineLogImportProgress,
} from "./machine-log-import-pipeline";
import {
  MachineLogImportError,
  type MachineLogImportWorkerReply,
  type MachineLogImportRequest,
} from "./machine-log-import-protocol";

export { MachineLogImportError } from "./machine-log-import-protocol";
export type { MachineLogImportProgress } from "./machine-log-import-pipeline";
export interface MachineLogImportSuccess {
  readonly log: MachineLogSummary;
  readonly via: "worker" | "main";
}
export interface MachineLogImportHandle {
  readonly promise: Promise<MachineLogImportSuccess>;
  cancel(): void;
}
const IMPORT_TIMEOUT_MS = 60_000;
let nextRequestId = 1;

/** 默认后台解析，只对启动失败回退；解析失败不会在主线程重试。 */
export function importMachineLogFile(
  file: File,
  onProgress?: (progress: MachineLogImportProgress) => void
): MachineLogImportHandle {
  let worker: Worker | null = null;
  let settled = false,
    fallback = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectPromise: (error: unknown) => void = () => {};
  const controller = new AbortController();
  const cleanup = () => {
    clearTimeout(timer);
    worker?.terminate();
    worker = null;
    controller.abort();
  };
  const promise = new Promise<MachineLogImportSuccess>((resolve, reject) => {
    rejectPromise = reject;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const complete = (result: MachineLogImportSuccess) => {
      if (settled) return;
      settled = true;
      cleanup();
      (globalThis as { __forgexMachineLogImportVia?: string }).__forgexMachineLogImportVia = result.via;
      resolve(result);
    };
    const report = (progress: MachineLogImportProgress) => {
      if (!settled) onProgress?.(progress);
    };
    const startFallback = () => {
      if (settled || fallback) return;
      fallback = true;
      worker?.terminate();
      worker = null;
      // 保留看门狗；取消后每个异步阶段均检查信号，不再解析旧文件。
      void parseMachineLogFile(file, report, controller.signal).then((log) => complete({ log, via: "main" }), fail);
    };
    try {
      validateMachineLogFile(file);
    } catch (error) {
      fail(error);
      return;
    }
    timer = setTimeout(
      () => fail(new MachineLogImportError("TIMEOUT", "真机日志解析超时，已结束本次导入")),
      IMPORT_TIMEOUT_MS
    );
    try {
      worker = new MachineLogImportWorkerCtor({ name: "forgex-machine-log" });
    } catch {
      startFallback();
      return;
    }
    let replied = false;
    const requestId = nextRequestId++;
    worker.onmessage = (event: MessageEvent<MachineLogImportWorkerReply>) => {
      const message = event.data;
      if (settled || fallback || message?.requestId !== requestId) return;
      replied = true;
      if (message.type === "progress") report(message);
      else if (message.type === "error") fail(new MachineLogImportError(message.code, message.message, message.phase));
      else if (message.type === "result") complete({ log: message.log, via: "worker" });
    };
    worker.onerror = (event) => {
      if (settled || fallback) return;
      if (!replied) {
        event.preventDefault();
        startFallback();
      } else fail(new MachineLogImportError("WORKER_FAILURE", "真机日志后台任务异常退出"));
    };
    worker.onmessageerror = () => {
      if (!fallback) fail(new MachineLogImportError("WORKER_FAILURE", "无法读取真机日志后台结果"));
    };
    try {
      worker.postMessage({ type: "parse", requestId, file } satisfies MachineLogImportRequest);
    } catch {
      startFallback();
    }
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new MachineLogImportError("CANCELLED", "真机日志导入已取消"));
    },
  };
}
