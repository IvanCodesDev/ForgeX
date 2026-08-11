import type { MachineProfile, MaterialProfile } from "../profiles/profile-types";

export const SIMULATOR_MODEL_IDS = ["gear", "impeller", "bracket"] as const;
export type SimulatorModelId = (typeof SIMULATOR_MODEL_IDS)[number];

export const SIMULATOR_INFILL_PATTERNS = ["斜线网格", "直线", "蜂窝"] as const;
export type SimulatorInfillPattern = (typeof SIMULATOR_INFILL_PATTERNS)[number];

export type SimulationMachineSnapshot = MachineProfile;
export type SimulationMaterialSnapshot = MaterialProfile;

/** Legacy FXSim 的完整工艺设置。所有数值都沿用旧引擎的制造业单位。 */
export interface QuickSimulationSettings {
  readonly material: string;
  readonly colorIdx: number;
  readonly layerHeight: number;
  readonly extrusionWidth: number;
  readonly perimeters: number;
  readonly solidLayers: number;
  readonly infillDensity: number;
  readonly infillPattern: SimulatorInfillPattern;
  readonly nozzleTemp: number;
  readonly bedTemp: number;
  readonly speed: number;
  readonly travelSpeed: number;
  readonly retraction: number;
  readonly fanSpeed: number;
  readonly supportEnabled: boolean;
  readonly supportSpacing: number;
  readonly skirtLoops: number;
  readonly skirtGap: number;
  readonly autoLevel: boolean;
  readonly zOffset: number;
}

export interface IdentityTransform {
  readonly scale: 1;
  readonly rotZ: 0;
  readonly offX: 0;
  readonly offY: 0;
}

export interface QuickSimulationInput {
  readonly modelId: SimulatorModelId;
  readonly machine: SimulationMachineSnapshot;
  readonly material: SimulationMaterialSnapshot;
  readonly settings: QuickSimulationSettings;
  readonly tf: IdentityTransform;
}

export interface QuickSimulationSummary {
  readonly totalLayers: number;
  readonly pathCount: number;
  readonly heightMm: number;
  readonly extrusionLengthMm: number;
  readonly travelLengthMm: number;
  readonly pathTimeSeconds: number;
  readonly fixedOverheadSeconds: 95;
  readonly estimatedTimeSeconds: number;
  readonly volumeCm3: number;
  readonly filamentLengthM: number;
  readonly filamentMassG: number;
  readonly materialCostCny: number;
}

export interface QuickSimulationQualityFinding {
  readonly name: string;
  readonly score: number;
  readonly level: "good" | "mid" | "bad";
  readonly tip: string;
}

export interface QuickSimulationWarning {
  readonly code: string;
  readonly message: string;
}

export interface QuickSimulationEvidence {
  readonly code: "FIXED_PROCESS_OVERHEAD";
  readonly value: 95;
  readonly unit: "s";
  readonly note: string;
}

export interface QuickSimulationResult {
  readonly authority: {
    readonly kind: "instant-preview";
    readonly authoritative: false;
    readonly label: "浏览器即时预览（非权威）";
  };
  readonly engine: {
    readonly name: "FXSlicer + FXSim.computeQuality";
    readonly source: "legacy-js-adapter";
    readonly version: "legacy-js-preview/1";
  };
  readonly input: {
    readonly modelId: SimulatorModelId;
    readonly machineProfile: { readonly id: string; readonly source: string };
    readonly materialProfile: { readonly id: string; readonly source: string };
    readonly settings: QuickSimulationSettings;
    readonly tf: IdentityTransform;
  };
  readonly model: {
    readonly id: SimulatorModelId;
    readonly name: string;
    readonly dimensions: string;
  };
  readonly profiles: {
    readonly machineId: string;
    readonly materialId: string;
  };
  readonly summary: QuickSimulationSummary;
  readonly quality: readonly QuickSimulationQualityFinding[];
  readonly evidence: readonly [QuickSimulationEvidence];
  readonly runtimeMs: number;
  readonly warnings: readonly QuickSimulationWarning[];
}

export type SimulatorWorkerPhase = "validate" | "simulate" | "pack";

export type SimulatorWorkerRequest =
  | {
      readonly type: "simulate";
      readonly jobId: string;
      readonly input: QuickSimulationInput;
    }
  | {
      readonly type: "cancel";
      readonly jobId: string;
    };

export type SimulatorWorkerResponse =
  | {
      readonly type: "progress";
      readonly jobId: string;
      readonly phase: SimulatorWorkerPhase;
      readonly progress: number;
      readonly stage: string;
    }
  | {
      readonly type: "result";
      readonly jobId: string;
      readonly result: QuickSimulationResult;
    }
  | {
      readonly type: "error";
      readonly jobId: string;
      readonly code: "INVALID_INPUT" | "SIMULATION_FAILED" | "WORKER_CRASH";
      readonly message: string;
    }
  | {
      readonly type: "cancelled";
      readonly jobId: string;
    }
  | {
      readonly type: "stale";
      readonly jobId: string;
    };

export type QuickSimulationStatus = "idle" | "running" | "success" | "error" | "cancelled" | "stale";

export interface QuickSimulationState {
  readonly status: QuickSimulationStatus;
  readonly jobId: string;
  readonly progress: number;
  readonly stage: string;
  readonly result: QuickSimulationResult | null;
  readonly error: string;
  readonly errorCode: string;
}

export interface QuickSimulationController {
  readonly state: QuickSimulationState;
  run(input: QuickSimulationInput): void;
  cancel(): void;
  markStale(): void;
  reset(): void;
}
