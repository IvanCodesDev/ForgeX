export type MachineLogBindingStatus = "verified" | "missing" | "invalid" | "unavailable" | "mismatch";

export type ReconciliationProvenance = "browser-preview" | "dotnet-authority";

export type MachineLogMetricCode = "durationSec" | "filamentMm" | "filamentG" | "completedLayers";

export interface MachineLogSample {
  readonly timeSec: number | null;
  readonly nozzleC: number | null;
  readonly bedC: number | null;
}

export interface MachineLogRecord {
  readonly name: string;
  readonly format: string;
  readonly jobId: string;
  readonly machineId: string;
  readonly firmware: string;
  readonly slicer: string;
  readonly gcodeSha256: string;
  readonly actualTimeSec: number | null;
  readonly filamentMm: number | null;
  readonly filamentG: number | null;
  readonly completedLayers: number | null;
  readonly status: string;
  readonly samples: readonly MachineLogSample[];
  readonly warnings: readonly string[];
  readonly source: string;
}

export interface MachineLogBinding {
  readonly verified: boolean;
  readonly status: MachineLogBindingStatus;
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}

export interface LegacyMachineLogComparison {
  readonly name: string;
  readonly planned: number;
  readonly actual: number;
  readonly unit: string;
  readonly relDiff: number;
  readonly agrees: boolean;
  readonly note: string;
}

export interface MachineLogComparison extends LegacyMachineLogComparison {
  readonly metric: MachineLogMetricCode;
}

export interface GcodeReconciliationPlan {
  readonly gcodeSha256: string;
  readonly provenance: ReconciliationProvenance;
  readonly engineVersion: string;
  readonly totalLayers: number;
  readonly estimatedTimeSec: number;
  readonly filamentMm: number;
  readonly filamentG: number | null;
}

export interface MachineLogImportResult {
  readonly file: {
    readonly name: string;
    readonly byteLength: number;
    readonly sha256: string;
  };
  readonly log: MachineLogRecord;
  readonly binding: MachineLogBinding;
  readonly comparisons: readonly MachineLogComparison[];
  readonly plan: GcodeReconciliationPlan;
}

export type MachineLogWorkerPhase = "read" | "hash" | "decode" | "parse" | "bind" | "reconcile";

export type MachineLogWorkerErrorCode =
  "FILE_TOO_LARGE" | "READ_FAILED" | "CRYPTO_UNAVAILABLE" | "DECODE_FAILED" | "INVALID_LOG" | "WORKER_FAILURE";

export interface MachineLogWorkerRequest {
  readonly type: "parse";
  readonly requestId: string;
  readonly file: File;
  readonly plan: GcodeReconciliationPlan;
}

export type MachineLogWorkerResponse =
  | {
      readonly type: "progress";
      readonly requestId: string;
      readonly phase: MachineLogWorkerPhase;
      readonly progress: number;
      readonly stage: string;
    }
  | {
      readonly type: "result";
      readonly requestId: string;
      readonly result: MachineLogImportResult;
    }
  | {
      readonly type: "error";
      readonly requestId: string;
      readonly code: MachineLogWorkerErrorCode;
      readonly phase: MachineLogWorkerPhase;
      readonly message: string;
      readonly retryable: boolean;
    };
