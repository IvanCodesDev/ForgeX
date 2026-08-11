import type { GcodeParseOptions } from "../gcode/gcode-types";

export type ProfileKinematics = "corexy" | "i3" | "delta" | "gantry";

export interface MachinePhysics {
  readonly hotendFouling?: number;
  readonly feederGrip?: number;
  readonly spoolDrag?: number;
  readonly heaterHealth?: number;
  readonly beltWear?: number;
  readonly ambientC?: number;
  readonly draft?: number;
}

export interface MachineProfileDefinition {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly kinematics: ProfileKinematics;
  readonly description: string;
  readonly buildVolume: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly enclosed: boolean;
  readonly physics?: MachinePhysics;
  readonly source: string;
}

export interface TemperatureRange {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export interface BedTemperatureRange {
  readonly default: number;
  readonly min: number;
}

export interface MaterialProfileDefinition {
  readonly id: string;
  readonly name: string;
  readonly nozzle: TemperatureRange;
  readonly bed: BedTemperatureRange;
  readonly fan: number;
  readonly densityG: number;
  readonly maxSpeed: number;
  readonly flowMm3s: number;
  readonly shrinkage: number;
  readonly priceCnyKg: number;
  readonly source: string;
}

export interface MachineProfile extends MachineProfileDefinition {
  readonly community: boolean;
}

export interface MaterialProfile extends MaterialProfileDefinition {
  readonly community: boolean;
  readonly nozzleTemp: number;
  readonly nozzleRange: readonly [number, number];
  readonly bedTemp: number;
  readonly bedMin: number;
}

export interface ProfileBundle {
  readonly $schema?: string;
  readonly format: "forgex-profile-bundle";
  readonly version: 1;
  readonly machines: readonly MachineProfileDefinition[];
  readonly materials: readonly MaterialProfileDefinition[];
}

export interface ProfileValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export interface ProfileCatalog {
  readonly machines: readonly MachineProfile[];
  readonly materials: readonly MaterialProfile[];
}

export interface ProfileSelection {
  readonly machineId: string;
  readonly materialId: string;
}

export interface ProfileOptionDraft {
  readonly bedSize: string;
  readonly densityG: string;
  readonly origin: GcodeParseOptions["origin"];
}

export type ProfileOptionField = keyof ProfileOptionDraft;
export type ProfileOptionErrors = Readonly<Partial<Record<ProfileOptionField, string>>>;

export interface ProfileOptionValidation {
  readonly ok: boolean;
  readonly options: GcodeParseOptions | null;
  readonly errors: ProfileOptionErrors;
}

export type ProfileStorageStatus =
  { readonly available: true; readonly message: string } | { readonly available: false; readonly message: string };

export type ProfileImportStatus = "idle" | "reading" | "success" | "error";

export interface ProfileImportResult {
  readonly machines: readonly MachineProfile[];
  readonly materials: readonly MaterialProfile[];
  readonly persisted: boolean;
}

export type ProfileImportErrorCode =
  | "INVALID_EXTENSION"
  | "FILE_TOO_LARGE"
  | "READ_FAILED"
  | "INVALID_JSON"
  | "INVALID_BUNDLE"
  | "BUILTIN_OVERRIDE"
  | "IMPORT_FAILED";

export interface ProfileSelectionValue {
  readonly catalog: ProfileCatalog;
  readonly selection: ProfileSelection;
  readonly machine: MachineProfile;
  readonly material: MaterialProfile;
  readonly draft: ProfileOptionDraft;
  readonly baselineOptions: GcodeParseOptions;
  readonly options: GcodeParseOptions | null;
  readonly errors: ProfileOptionErrors;
  readonly dirty: boolean;
  readonly importStatus: ProfileImportStatus;
  readonly importMessage: string;
  readonly storage: ProfileStorageStatus;
}

export interface ProfileSelectionActions {
  selectMachine(id: string): void;
  selectMaterial(id: string): void;
  setBedSize(value: string): void;
  setDensityG(value: string): void;
  setOrigin(value: GcodeParseOptions["origin"]): void;
  restoreProfileOptions(): void;
  importFile(file: File): Promise<void>;
}

export interface ProfileSelectionController {
  readonly value: ProfileSelectionValue;
  readonly actions: ProfileSelectionActions;
}
