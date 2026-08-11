import type {
  LegacyMachineLogComparison,
  MachineLogBinding,
  MachineLogRecord,
} from "../features/machine-logs/machine-log-types";

export const legacyMachineLog: {
  readonly MAX_BYTES: number;
  readonly MAX_ROWS: number;
  parse(text: string, options?: { readonly name?: string }): MachineLogRecord;
  verifyGcodeBinding(gcode: { readonly sha256: string }, log: MachineLogRecord): MachineLogBinding;
  compare(
    gcode: {
      readonly totalLayers: number;
      readonly stats: {
        readonly timeSec: number;
        readonly filamentM: number;
        readonly filamentG: number | undefined;
      };
    },
    log: MachineLogRecord
  ): readonly LegacyMachineLogComparison[];
};
