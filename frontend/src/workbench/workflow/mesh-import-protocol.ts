/* STL / 3MF 网格导入 Worker 的消息协议（类型 + 错误码归类，Worker 与主线程兜底共用）。

   与 gcode-import-protocol 同构：进度、结构化错误、Transferable 结果。
   Stage 9.3 前半——浏览器侧预览解析；C# 权威解析（后半）就位后，结果面板会在
   预览数字旁并列权威数字，本协议不变。 */
import type { MeshImportPayload } from "../../engine/mesh-import";

export type MeshImportPhase = "read" | "hash" | "parse" | "rebuild";

export type MeshImportErrorCode =
  | "FILE_TOO_LARGE"
  | "READ_FAILED"
  | "CRYPTO_UNAVAILABLE"
  | "UNSUPPORTED_FORMAT"
  | "PARSE_FAILED"
  | "WORKER_FAILURE"
  | "TIMEOUT"
  | "CANCELLED";

/** 引擎抛出的错误消息 → 结构化错误码（消息文案是引擎的公开契约的一部分） */
export function classifyMeshError(message: string, phase: MeshImportPhase): MeshImportErrorCode {
  if (message.includes("超过")) return "FILE_TOO_LARGE";
  if (phase === "read") return "READ_FAILED";
  if (phase === "hash") return "CRYPTO_UNAVAILABLE";
  if (message.includes("无法识别")) return "UNSUPPORTED_FORMAT";
  return "PARSE_FAILED";
}

export interface MeshImportRequest {
  readonly type: "parse";
  readonly requestId: number;
  readonly file: File;
}

export type MeshImportWorkerReply =
  | {
      readonly type: "progress";
      readonly requestId: number;
      readonly phase: MeshImportPhase;
      readonly progress: number;
    }
  | {
      readonly type: "result";
      readonly requestId: number;
      readonly sha256: string;
      readonly mesh: MeshImportPayload;
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly phase: MeshImportPhase;
      readonly code: MeshImportErrorCode;
      readonly message: string;
    };
