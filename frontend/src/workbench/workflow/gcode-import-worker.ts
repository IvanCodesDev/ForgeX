/* FORGE·X — G-code 导入 Worker 入口（V1 §5.5 落地）。

   主线程只负责选文件、进度展示与结果挂载；本线程完成：
   读取字节 → SHA-256 → 流式解码（4 MiB 一块喂增量解析器，绝不整体转字符串
   后 split）→ 顶点缓冲构建 → TypedArray 打包。产物经 Transferable 零拷贝回传。

   经 Vite `?worker&inline` 内联打包：普通构建与离线单 HTML（file:// 直开）
   同一条代码路径，不产生外部 chunk 引用。 */
import { MAX_BYTES, createIncrementalParser, sha256 } from "../../engine/gcode-parser";
import { buildToolpathBuffers } from "../../engine/toolpath-buffers";
import { packParsedGcode, packedGcodeTransferables } from "./gcode-toolpath-pack";
import type { GcodeImportPhase, GcodeImportRequest, GcodeImportWorkerReply } from "./gcode-import-protocol";

const DECODE_CHUNK_BYTES = 4 * 1024 * 1024;

/* tsconfig 只挂 DOM lib（主应用），Worker 全局作用域收窄成本文件用到的最小面 */
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<GcodeImportRequest>) => void) | null;
  postMessage(message: GcodeImportWorkerReply, transfer?: Transferable[]): void;
};

async function handleParse(request: GcodeImportRequest): Promise<void> {
  const { requestId, file, options } = request;
  const progress = (phase: GcodeImportPhase, value: number) =>
    scope.postMessage({ type: "progress", requestId, phase, progress: value });
  let phase: GcodeImportPhase = "read";
  try {
    if (file.size > MAX_BYTES) {
      throw new Error(`G-code 超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，请先精简`);
    }
    progress("read", 0);
    const buffer = await file.arrayBuffer();
    progress("read", 1);

    phase = "hash";
    progress("hash", 0);
    const digest = await sha256(buffer);
    progress("hash", 1);

    phase = "parse";
    const parser = createIncrementalParser(options);
    const decoder = new TextDecoder("utf-8");
    const bytes = new Uint8Array(buffer);
    /* 原文按块保留：导出「原始 G-code」需要全文，但拼接发生在本线程，不占主线程 */
    const textChunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += DECODE_CHUNK_BYTES) {
      const end = Math.min(offset + DECODE_CHUNK_BYTES, bytes.length);
      const text = decoder.decode(bytes.subarray(offset, end), { stream: end < bytes.length });
      if (text) {
        parser.push(text);
        textChunks.push(text);
      }
      progress("parse", end / bytes.length);
    }
    const parsed = parser.finish();

    phase = "pack";
    progress("pack", 0);
    const packed = packParsedGcode(parsed);
    const toolpath = buildToolpathBuffers(parsed.layers);
    progress("pack", 1);

    scope.postMessage({ type: "source-text", requestId, sourceText: textChunks.join("") });
    scope.postMessage({ type: "result", requestId, sha256: digest, packed, toolpath }, [
      ...packedGcodeTransferables(packed),
      toolpath.positions.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    const code = message.includes("超过")
      ? "FILE_TOO_LARGE"
      : phase === "read"
        ? "READ_FAILED"
        : phase === "hash"
          ? "CRYPTO_UNAVAILABLE"
          : "PARSE_FAILED";
    scope.postMessage({ type: "error", requestId, phase, code, message });
  }
}

scope.onmessage = (event) => {
  if (event.data && event.data.type === "parse") void handleParse(event.data);
};
