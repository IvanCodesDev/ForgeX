/* G-code 导入 Worker 的消息协议（类型层，无运行时代码）。

   设计对齐 V1 §5.5 对 Worker 的硬性要求：进度、取消、超时、结构化错误、
   Transferable 数据。authority/gcode-types.ts 里的 GcodeWorker* 是面向
   「预览契约」的另一套（服务 C# 权威链路的采样预览）；本协议服务的是
   工作台导入链路——产物是与切片器同构的完整 ParsedGcodeResult。 */
import type { GcodeParserOptions } from "../../engine/gcode-parser";
import type { ToolpathBuffers } from "../../engine/toolpath-buffers";
import type { PackedParsedGcode } from "./gcode-toolpath-pack";

export type GcodeImportPhase = "read" | "hash" | "parse" | "pack" | "rebuild";

export type GcodeImportErrorCode =
  "FILE_TOO_LARGE" | "READ_FAILED" | "CRYPTO_UNAVAILABLE" | "PARSE_FAILED" | "WORKER_FAILURE" | "TIMEOUT" | "CANCELLED";

export interface GcodeImportRequest {
  readonly type: "parse";
  readonly requestId: number;
  readonly file: File;
  readonly options: GcodeParserOptions;
}

export type GcodeImportWorkerReply =
  | {
      readonly type: "progress";
      readonly requestId: number;
      readonly phase: GcodeImportPhase;
      readonly progress: number;
    }
  /** 原文与结果分两条消息回传：单条超大结构化克隆会在主线程集中反序列化，拆开可控。 */
  | { readonly type: "source-text"; readonly requestId: number; readonly sourceText: string }
  | {
      readonly type: "result";
      readonly requestId: number;
      readonly sha256: string;
      readonly packed: PackedParsedGcode;
      readonly toolpath: ToolpathBuffers;
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly phase: GcodeImportPhase;
      readonly code: GcodeImportErrorCode;
      readonly message: string;
    };
