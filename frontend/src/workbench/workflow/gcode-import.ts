/* G-code 导入的主线程客户端：Worker 边界 + 主线程同步兜底。

   默认走 gcode-import-worker（读取/哈希/流式解析/打包全部离主线程），
   收到 Transferable 结果后分片重建对象图——满足 V1 §5.5 的进度、取消、
   超时、结构化错误与 Transferable 要求。Worker 基建不可用（极端环境下
   构造抛错或模块加载失败）时退回与旧实现逐字节一致的主线程同步路径，
   保住「零依赖直开」承诺；解析类错误不触发回退——主线程重跑只会同样失败。 */
import { MAX_BYTES, parse, sha256, type GcodeParserOptions, type ParsedGcodeResult } from "../../engine/gcode-parser";
import type { ToolpathBuffers } from "../../engine/toolpath-buffers";
import GcodeImportWorkerCtor from "./gcode-import-worker?worker&inline";
import { unpackParsedGcode } from "./gcode-toolpath-pack";
import type {
  GcodeImportErrorCode,
  GcodeImportPhase,
  GcodeImportRequest,
  GcodeImportWorkerReply,
} from "./gcode-import-protocol";

export type { GcodeImportErrorCode, GcodeImportPhase } from "./gcode-import-protocol";

/** 64 MB 级文件在低端机 Worker 里也远用不满；到点即判死并结构化报错（V1 §5.5 超时要求） */
const IMPORT_TIMEOUT_MS = 300_000;

export interface GcodeImportProgress {
  readonly phase: GcodeImportPhase;
  readonly progress: number;
}

export interface GcodeImportSuccess {
  readonly parsed: ParsedGcodeResult;
  readonly sourceText: string;
  readonly sha256: string;
  /** Worker 预计算的渲染顶点缓冲；主线程兜底路径下缺省，由 attachToolpath 就地构建 */
  readonly toolpath?: ToolpathBuffers;
  readonly via: "worker" | "main";
}

export interface GcodeImportHandle {
  readonly promise: Promise<GcodeImportSuccess>;
  /** 终止 Worker 并以 CANCELLED 结束 promise；调用方对该错误码保持静默 */
  cancel(): void;
}

export class GcodeImportError extends Error {
  readonly code: GcodeImportErrorCode;
  readonly phase: GcodeImportPhase | null;
  constructor(code: GcodeImportErrorCode, message: string, phase?: GcodeImportPhase) {
    super(message);
    this.name = "GcodeImportError";
    this.code = code;
    this.phase = phase ?? null;
  }
}

let nextRequestId = 1;

/** 与旧 handleGcodeFile 逐步一致的主线程路径（读取 → SHA-256 → 整体解码 → 同步解析） */
async function parseOnMainThread(
  file: File,
  options: GcodeParserOptions,
  onProgress: ((progress: GcodeImportProgress) => void) | undefined,
  checkActive: () => void
): Promise<GcodeImportSuccess> {
  let phase: GcodeImportPhase = "read";
  try {
    if (file.size > MAX_BYTES) {
      throw new GcodeImportError("FILE_TOO_LARGE", `G-code 超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，请先精简`);
    }
    onProgress?.({ phase: "read", progress: 0 });
    checkActive();
    const buffer = await file.arrayBuffer();
    checkActive();
    phase = "hash";
    const digest = await sha256(buffer);
    checkActive();
    phase = "parse";
    onProgress?.({ phase: "parse", progress: 0 });
    const sourceText = new TextDecoder("utf-8").decode(new Uint8Array(buffer));
    const parsed = parse(sourceText, options);
    checkActive();
    parsed.sha256 = digest;
    onProgress?.({ phase: "parse", progress: 1 });
    return { parsed, sourceText, sha256: digest, via: "main" };
  } catch (error) {
    if (error instanceof GcodeImportError) throw error;
    throw new GcodeImportError(
      phase === "read" ? "READ_FAILED" : phase === "hash" ? "CRYPTO_UNAVAILABLE" : "PARSE_FAILED",
      String((error as Error)?.message ?? error),
      phase
    );
  }
}

/** 测试探针（与 window.FX 调试句柄同性质）：E2E 卡口据此断言 Worker 路径真的被走到 */
function markImportVia(via: GcodeImportSuccess["via"]): void {
  (globalThis as { __forgexGcodeImportVia?: string }).__forgexGcodeImportVia = via;
}

export function importGcodeFile(
  file: File,
  options: GcodeParserOptions,
  onProgress?: (progress: GcodeImportProgress) => void
): GcodeImportHandle {
  let worker: Worker | null = null;
  let watchdog: number | null = null;
  let settled = false;
  let fallback = false;
  let rebuilding = false;
  let rejectPromise: (error: unknown) => void = () => {};

  const cleanup = () => {
    if (watchdog != null) window.clearTimeout(watchdog);
    watchdog = null;
    worker?.terminate();
    worker = null;
  };

  const promise = new Promise<GcodeImportSuccess>((resolve, reject) => {
    rejectPromise = reject;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const settle = (value: GcodeImportSuccess) => {
      if (settled) return;
      settled = true;
      cleanup();
      markImportVia(value.via);
      resolve(value);
    };
    const checkActive = () => {
      if (settled) throw new GcodeImportError("CANCELLED", "G-code 导入已结束");
    };
    const report = (progress: GcodeImportProgress) => {
      if (!settled) onProgress?.(progress);
    };
    const fallbackToMainThread = () => {
      if (settled || fallback) return;
      fallback = true;
      worker?.terminate();
      worker = null;
      // 看门狗覆盖兜底路径；每个异步阶段后检查取消/超时，阻止旧文件继续处理。
      parseOnMainThread(file, options, report, checkActive).then(settle, fail);
    };
    watchdog = window.setTimeout(() => {
      fail(new GcodeImportError("TIMEOUT", "G-code 解析超时，已结束本次导入"));
    }, IMPORT_TIMEOUT_MS);

    try {
      worker = new GcodeImportWorkerCtor({ name: "forgex-gcode" });
    } catch {
      worker = null;
    }
    if (!worker) {
      fallbackToMainThread();
      return;
    }

    const requestId = nextRequestId++;
    let workerReplied = false;
    let sourceText = "";

    worker.onmessage = (event: MessageEvent<GcodeImportWorkerReply>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId || settled || fallback || rebuilding) return;
      workerReplied = true;
      if (message.type === "progress") {
        report({ phase: message.phase, progress: message.progress });
        return;
      }
      if (message.type === "source-text") {
        sourceText = message.sourceText;
        return;
      }
      if (message.type === "error") {
        fail(new GcodeImportError(message.code, message.message, message.phase));
        return;
      }
      /* result：分片重建对象图；每片之间让出事件循环并响应取消 */
      rebuilding = true;
      worker?.terminate();
      worker = null;
      report({ phase: "rebuild", progress: 0 });
      const yieldToEventLoop = () =>
        new Promise<void>((yieldResolve, yieldReject) => {
          window.setTimeout(() => {
            if (settled) yieldReject(new GcodeImportError("CANCELLED", "G-code 导入已取消"));
            else yieldResolve();
          }, 0);
        });
      unpackParsedGcode(message.packed, { yieldToEventLoop })
        .then((parsed) => {
          checkActive();
          parsed.sha256 = message.sha256;
          report({ phase: "rebuild", progress: 1 });
          settle({ parsed, sourceText, sha256: message.sha256, toolpath: message.toolpath, via: "worker" });
        })
        .catch(fail);
    };
    worker.onerror = (event) => {
      if (settled || fallback || rebuilding) return;
      /* 业务消息到达前的失败＝Worker 基建不可用（如受限环境加载失败）→ 回退主线程；
         之后的失败是真异常，结构化上抛。 */
      if (!workerReplied) {
        event.preventDefault();
        fallbackToMainThread();
        return;
      }
      fail(new GcodeImportError("WORKER_FAILURE", event.message || "G-code Worker 异常退出"));
    };
    worker.onmessageerror = () => {
      if (!fallback && !rebuilding) fail(new GcodeImportError("WORKER_FAILURE", "无法读取 G-code 后台结果"));
    };
    try {
      worker.postMessage({ type: "parse", requestId, file, options } satisfies GcodeImportRequest);
    } catch {
      if (!workerReplied) fallbackToMainThread();
      else fail(new GcodeImportError("WORKER_FAILURE", "无法发送 G-code 后台任务"));
    }
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new GcodeImportError("CANCELLED", "G-code 导入已取消"));
    },
  };
}
