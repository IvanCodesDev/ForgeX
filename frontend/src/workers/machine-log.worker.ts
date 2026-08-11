/// <reference lib="webworker" />

import { MACHINE_LOG_MAX_BYTES } from "../features/machine-logs/machine-log-limits";
import { parseMachineLog, reconcileMachineLog } from "../features/machine-logs/machine-log-model";
import type {
  MachineLogWorkerErrorCode,
  MachineLogWorkerPhase,
  MachineLogWorkerRequest,
  MachineLogWorkerResponse,
} from "../features/machine-logs/machine-log-types";

function send(message: MachineLogWorkerResponse): void {
  self.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "真机日志解析失败");
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (!crypto.subtle) throw new Error("当前运行环境缺少 WebCrypto SHA-256 能力");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function classifyError(error: unknown, phase: MachineLogWorkerPhase): MachineLogWorkerErrorCode {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("超过") && message.includes("mb")) return "FILE_TOO_LARGE";
  if (message.includes("webcrypto") || message.includes("sha-256")) return "CRYPTO_UNAVAILABLE";
  if (phase === "read") return "READ_FAILED";
  if (phase === "decode") return "DECODE_FAILED";
  if (phase === "parse" || phase === "bind" || phase === "reconcile") return "INVALID_LOG";
  return "WORKER_FAILURE";
}

async function parse(request: MachineLogWorkerRequest): Promise<void> {
  let phase: MachineLogWorkerPhase = "read";
  try {
    if (request.file.size > MACHINE_LOG_MAX_BYTES) {
      throw new Error(`真机日志超过 ${Math.round(MACHINE_LOG_MAX_BYTES / 1024 / 1024)}MB`);
    }

    send({ type: "progress", requestId: request.requestId, phase, progress: 0.08, stage: "读取日志原始字节" });
    const bytes = await request.file.arrayBuffer();

    phase = "hash";
    send({
      type: "progress",
      requestId: request.requestId,
      phase,
      progress: 0.28,
      stage: "计算日志文件 SHA-256",
    });
    const digest = await sha256(bytes);

    phase = "decode";
    send({ type: "progress", requestId: request.requestId, phase, progress: 0.48, stage: "解码日志文本" });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));

    phase = "parse";
    send({ type: "progress", requestId: request.requestId, phase, progress: 0.66, stage: "归一化真机日志" });
    const log = parseMachineLog(text, request.file.name);

    phase = "bind";
    send({ type: "progress", requestId: request.requestId, phase, progress: 0.82, stage: "核验 G-code SHA-256 绑定" });
    const reconciled = reconcileMachineLog(log, request.plan);

    phase = "reconcile";
    send({ type: "progress", requestId: request.requestId, phase, progress: 0.94, stage: "生成计划/实测对账" });
    send({
      type: "result",
      requestId: request.requestId,
      result: {
        file: { name: request.file.name, byteLength: request.file.size, sha256: digest },
        log,
        binding: reconciled.binding,
        comparisons: reconciled.comparisons,
        plan: request.plan,
      },
    });
  } catch (error) {
    send({
      type: "error",
      requestId: request.requestId,
      code: classifyError(error, phase),
      phase,
      message: errorMessage(error),
      retryable: phase === "read",
    });
  }
}

self.onmessage = (event: MessageEvent<MachineLogWorkerRequest>) => {
  if (event.data.type === "parse") void parse(event.data);
};
