/// <reference lib="webworker" />

import { legacyGcodeParser } from "../legacy/gcode-parser-adapter.js";
import type {
  GcodeWorkerErrorCode,
  GcodeWorkerPhase,
  GcodeWorkerRequest,
  GcodeWorkerResponse,
} from "../features/gcode/gcode-types";
import { buildPreview, composePreviewResult } from "../features/gcode/preview-model";
import { toWorkerErrorMessage } from "../features/gcode/worker-protocol";

const YIELD_EVERY_CHUNKS = 8;

function send(message: GcodeWorkerResponse): void {
  self.postMessage(message);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (!crypto.subtle) throw new Error("当前运行环境缺少 WebCrypto SHA-256 能力");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function classifyError(error: unknown, phase: GcodeWorkerPhase): GcodeWorkerErrorCode {
  const message = toWorkerErrorMessage(error).toLowerCase();
  if (message.includes("超过") && message.includes("mb")) return "FILE_TOO_LARGE";
  if (message.includes("webcrypto") || message.includes("sha-256")) return "CRYPTO_UNAVAILABLE";
  if (message.includes("挤出路径")) return "NO_EXTRUSION";
  if (phase === "read") return "READ_FAILED";
  if (phase === "parse" && (message.includes("decode") || message.includes("编码"))) return "DECODE_FAILED";
  return "WORKER_FAILURE";
}

function yieldToWorkerLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function parse(request: GcodeWorkerRequest): Promise<void> {
  let phase: GcodeWorkerPhase = "read";
  try {
    if (request.file.size > legacyGcodeParser.MAX_BYTES) {
      throw new Error(`G-code 超过 ${Math.round(legacyGcodeParser.MAX_BYTES / 1024 / 1024)}MB，请先精简`);
    }
    send({ type: "progress", requestId: request.requestId, phase, progress: 0.06, stage: "读取原始文件字节" });
    const bytes = await request.file.arrayBuffer();
    phase = "hash";
    send({ type: "progress", requestId: request.requestId, phase, progress: 0.14, stage: "计算原始文件 SHA-256" });
    const digest = await sha256(bytes);

    phase = "parse";
    const parser = legacyGcodeParser.createIncrementalParser(request.options);
    const decoder = new TextDecoder("utf-8");
    const view = new Uint8Array(bytes);
    const requestedChunkBytes = Number.isFinite(request.limits.chunkBytes) ? Math.floor(request.limits.chunkBytes) : 0;
    const chunkBytes = Math.max(64 * 1024, requestedChunkBytes);
    const totalChunks = Math.max(1, Math.ceil(view.byteLength / chunkBytes));
    for (let offset = 0, chunkIndex = 0; offset < view.byteLength; offset += chunkBytes, chunkIndex += 1) {
      const end = Math.min(view.byteLength, offset + chunkBytes);
      parser.push(decoder.decode(view.subarray(offset, end), { stream: end < view.byteLength }));
      const parseProgress = (chunkIndex + 1) / totalChunks;
      send({
        type: "progress",
        requestId: request.requestId,
        phase,
        progress: 0.22 + parseProgress * 0.58,
        stage: `流式解析 G-code（${Math.round(parseProgress * 100)}%）`,
      });
      if ((chunkIndex + 1) % YIELD_EVERY_CHUNKS === 0) await yieldToWorkerLoop();
    }
    const tail = decoder.decode();
    if (tail) parser.push(tail);
    const parsed = parser.finish();

    phase = "pack";
    send({
      type: "progress",
      requestId: request.requestId,
      phase,
      progress: 0.86,
      stage: "生成受预算约束的分层预览",
    });
    const preview = buildPreview(parsed, {
      maxSegments: request.limits.maxPreviewSegments,
      maxPointsPerPath: request.limits.maxPointsPerPath,
    });
    const result = composePreviewResult({
      fileName: request.file.name,
      byteLength: request.file.size,
      sha256: digest,
      parsed,
      preview,
    });
    send({ type: "result", requestId: request.requestId, result });
  } catch (error) {
    send({
      type: "error",
      requestId: request.requestId,
      code: classifyError(error, phase),
      phase,
      message: toWorkerErrorMessage(error),
      retryable: phase === "read",
    });
  }
}

self.onmessage = (event: MessageEvent<GcodeWorkerRequest>) => {
  if (event.data.type === "parse") void parse(event.data);
};
