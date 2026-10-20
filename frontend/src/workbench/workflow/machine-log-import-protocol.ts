import type { MachineLogSummary } from "../../engine/machine-log-summary";

export type MachineLogImportPhase = "read" | "hash" | "parse" | "summary";
export type MachineLogImportErrorCode =
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FORMAT"
  | "READ_FAILED"
  | "CRYPTO_UNAVAILABLE"
  | "INVALID_UTF8"
  | "PARSE_FAILED"
  | "WORKER_FAILURE"
  | "TIMEOUT"
  | "CANCELLED";
export interface MachineLogImportRequest {
  readonly type: "parse";
  readonly requestId: number;
  readonly file: File;
}
export type MachineLogImportWorkerReply =
  | {
      readonly type: "progress";
      readonly requestId: number;
      readonly phase: MachineLogImportPhase;
      readonly progress: number;
    }
  | { readonly type: "result"; readonly requestId: number; readonly log: MachineLogSummary }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly phase: MachineLogImportPhase;
      readonly code: MachineLogImportErrorCode;
      readonly message: string;
    };

export class MachineLogImportError extends Error {
  constructor(
    readonly code: MachineLogImportErrorCode,
    message: string,
    readonly phase: MachineLogImportPhase | null = null
  ) {
    super(message);
    this.name = "MachineLogImportError";
  }
}
