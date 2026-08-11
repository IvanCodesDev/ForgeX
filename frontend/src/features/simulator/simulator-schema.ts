import type {
  IdentityTransform,
  QuickSimulationInput,
  QuickSimulationSettings,
  SimulationMachineSnapshot,
  SimulationMaterialSnapshot,
  SimulatorInfillPattern,
  SimulatorModelId,
} from "./simulator-types";
import { SIMULATOR_INFILL_PATTERNS, SIMULATOR_MODEL_IDS } from "./simulator-types";

export const IDENTITY_SIMULATION_TRANSFORM: IdentityTransform = Object.freeze({
  scale: 1,
  rotZ: 0,
  offX: 0,
  offY: 0,
});

export const STANDARD_SIMULATION_SETTINGS: QuickSimulationSettings = Object.freeze({
  material: "PLA",
  colorIdx: 2,
  layerHeight: 0.2,
  extrusionWidth: 0.45,
  perimeters: 2,
  solidLayers: 3,
  infillDensity: 0.18,
  infillPattern: "斜线网格",
  nozzleTemp: 210,
  bedTemp: 60,
  speed: 120,
  travelSpeed: 260,
  retraction: 1.2,
  fanSpeed: 100,
  supportEnabled: true,
  supportSpacing: 4.5,
  skirtLoops: 2,
  skirtGap: 5,
  autoLevel: true,
  zOffset: 0,
});

export interface SimulationValidationSuccess {
  readonly ok: true;
  readonly value: QuickSimulationInput;
  readonly errors: readonly [];
}

export interface SimulationValidationFailure {
  readonly ok: false;
  readonly value: null;
  readonly errors: readonly string[];
}

export type SimulationValidationResult = SimulationValidationSuccess | SimulationValidationFailure;

export class QuickSimulationInputError extends Error {
  public readonly code = "INVALID_INPUT" as const;
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(issues.join("；"));
    this.name = "QuickSimulationInputError";
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(value: UnknownRecord, allowed: readonly string[], path: string, errors: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${path}.${key} 不是允许的字段`);
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{1,47}$/.test(value);
}

function finiteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return finiteIn(value, min, max) && Number.isInteger(value);
}

function validateNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: string[],
  integer = false
): void {
  if (!(integer ? integerIn(value, min, max) : finiteIn(value, min, max))) {
    errors.push(`${path} 必须是 ${min}–${max}${integer ? " 的整数" : " 的有限数"}`);
  }
}

function validatePhysics(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  const ranges = {
    hotendFouling: [0, 1],
    feederGrip: [0.4, 1],
    spoolDrag: [0, 1],
    heaterHealth: [0.5, 1],
    beltWear: [0, 1],
    ambientC: [0, 60],
    draft: [0, 1],
  } as const;
  rejectUnknown(value, Object.keys(ranges), path, errors);
  for (const [key, range] of Object.entries(ranges)) {
    if (value[key] !== undefined) validateNumber(value[key], `${path}.${key}`, range[0], range[1], errors);
  }
}

function validateMachine(value: unknown, errors: string[]): value is SimulationMachineSnapshot {
  const path = "input.machine";
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return false;
  }
  rejectUnknown(
    value,
    ["id", "name", "tag", "kinematics", "description", "buildVolume", "enclosed", "physics", "source", "community"],
    path,
    errors
  );
  if (!safeId(value.id)) errors.push(`${path}.id 格式无效`);
  if (!safeText(value.name, 80)) errors.push(`${path}.name 必填且不超过 80 字符`);
  if (!safeText(value.tag, 40)) errors.push(`${path}.tag 必填且不超过 40 字符`);
  if (!["corexy", "i3", "delta", "gantry"].includes(String(value.kinematics)))
    errors.push(`${path}.kinematics 取值无效`);
  if (!safeText(value.description, 120)) errors.push(`${path}.description 必填且不超过 120 字符`);
  if (!isRecord(value.buildVolume)) errors.push(`${path}.buildVolume 必须是对象`);
  else {
    rejectUnknown(value.buildVolume, ["x", "y", "z"], `${path}.buildVolume`, errors);
    for (const axis of ["x", "y", "z"] as const)
      validateNumber(value.buildVolume[axis], `${path}.buildVolume.${axis}`, 50, 2000, errors);
  }
  if (typeof value.enclosed !== "boolean") errors.push(`${path}.enclosed 必须是布尔值`);
  if (!safeText(value.source, 240)) errors.push(`${path}.source 必填且不超过 240 字符`);
  if (typeof value.community !== "boolean") errors.push(`${path}.community 必须是布尔值`);
  validatePhysics(value.physics, `${path}.physics`, errors);
  return true;
}

function validateMaterial(value: unknown, errors: string[]): value is SimulationMaterialSnapshot {
  const path = "input.material";
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return false;
  }
  rejectUnknown(
    value,
    [
      "id",
      "name",
      "nozzle",
      "bed",
      "fan",
      "densityG",
      "maxSpeed",
      "flowMm3s",
      "shrinkage",
      "priceCnyKg",
      "source",
      "community",
      "nozzleTemp",
      "nozzleRange",
      "bedTemp",
      "bedMin",
    ],
    path,
    errors
  );
  if (!safeId(value.id)) errors.push(`${path}.id 格式无效`);
  if (!safeText(value.name, 80)) errors.push(`${path}.name 必填且不超过 80 字符`);
  if (!isRecord(value.nozzle)) errors.push(`${path}.nozzle 必须是对象`);
  else {
    rejectUnknown(value.nozzle, ["default", "min", "max"], `${path}.nozzle`, errors);
    validateNumber(value.nozzle.default, `${path}.nozzle.default`, 120, 450, errors);
    validateNumber(value.nozzle.min, `${path}.nozzle.min`, 120, 450, errors);
    validateNumber(value.nozzle.max, `${path}.nozzle.max`, 120, 450, errors);
    if (
      finiteIn(value.nozzle.default, 120, 450) &&
      finiteIn(value.nozzle.min, 120, 450) &&
      finiteIn(value.nozzle.max, 120, 450) &&
      (value.nozzle.default < value.nozzle.min || value.nozzle.default > value.nozzle.max)
    )
      errors.push(`${path}.nozzle.default 必须落在 min/max 内`);
  }
  if (!isRecord(value.bed)) errors.push(`${path}.bed 必须是对象`);
  else {
    rejectUnknown(value.bed, ["default", "min"], `${path}.bed`, errors);
    validateNumber(value.bed.default, `${path}.bed.default`, 0, 180, errors);
    validateNumber(value.bed.min, `${path}.bed.min`, 0, 180, errors);
    if (finiteIn(value.bed.default, 0, 180) && finiteIn(value.bed.min, 0, 180) && value.bed.default < value.bed.min)
      errors.push(`${path}.bed.default 不能低于 bed.min`);
  }
  validateNumber(value.fan, `${path}.fan`, 0, 100, errors);
  validateNumber(value.densityG, `${path}.densityG`, 0.2, 5, errors);
  validateNumber(value.maxSpeed, `${path}.maxSpeed`, 5, 1000, errors);
  validateNumber(value.flowMm3s, `${path}.flowMm3s`, 0.2, 100, errors);
  validateNumber(value.shrinkage, `${path}.shrinkage`, 0, 3, errors);
  validateNumber(value.priceCnyKg, `${path}.priceCnyKg`, 0, 5000, errors);
  if (!safeText(value.source, 240)) errors.push(`${path}.source 必填且不超过 240 字符`);
  if (typeof value.community !== "boolean") errors.push(`${path}.community 必须是布尔值`);
  validateNumber(value.nozzleTemp, `${path}.nozzleTemp`, 120, 450, errors);
  if (!Array.isArray(value.nozzleRange) || value.nozzleRange.length !== 2) {
    errors.push(`${path}.nozzleRange 必须是两个温度组成的数组`);
  } else {
    validateNumber(value.nozzleRange[0], `${path}.nozzleRange[0]`, 120, 450, errors);
    validateNumber(value.nozzleRange[1], `${path}.nozzleRange[1]`, 120, 450, errors);
  }
  validateNumber(value.bedTemp, `${path}.bedTemp`, 0, 180, errors);
  validateNumber(value.bedMin, `${path}.bedMin`, 0, 180, errors);
  return true;
}

const SETTINGS_RANGES = {
  colorIdx: [0, 4, true],
  layerHeight: [0.08, 0.32, false],
  extrusionWidth: [0.2, 1.2, false],
  perimeters: [1, 5, true],
  solidLayers: [2, 6, true],
  infillDensity: [0.05, 1, false],
  nozzleTemp: [120, 450, false],
  bedTemp: [0, 180, false],
  speed: [20, 1000, false],
  travelSpeed: [100, 1000, false],
  retraction: [0, 4, false],
  fanSpeed: [0, 100, false],
  supportSpacing: [2, 8, false],
  skirtLoops: [0, 10, true],
  skirtGap: [0, 50, false],
  zOffset: [-0.3, 0.3, false],
} as const;

function validateSettings(value: unknown, errors: string[]): value is QuickSimulationSettings {
  const path = "input.settings";
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return false;
  }
  rejectUnknown(
    value,
    [
      "material",
      "colorIdx",
      "layerHeight",
      "extrusionWidth",
      "perimeters",
      "solidLayers",
      "infillDensity",
      "infillPattern",
      "nozzleTemp",
      "bedTemp",
      "speed",
      "travelSpeed",
      "retraction",
      "fanSpeed",
      "supportEnabled",
      "supportSpacing",
      "skirtLoops",
      "skirtGap",
      "autoLevel",
      "zOffset",
    ],
    path,
    errors
  );
  if (!safeId(value.material)) errors.push(`${path}.material 格式无效`);
  for (const [key, range] of Object.entries(SETTINGS_RANGES))
    validateNumber(value[key], `${path}.${key}`, range[0], range[1], errors, range[2]);
  if (!SIMULATOR_INFILL_PATTERNS.includes(value.infillPattern as SimulatorInfillPattern))
    errors.push(`${path}.infillPattern 取值无效`);
  if (typeof value.supportEnabled !== "boolean") errors.push(`${path}.supportEnabled 必须是布尔值`);
  if (typeof value.autoLevel !== "boolean") errors.push(`${path}.autoLevel 必须是布尔值`);
  return true;
}

function validateIdentityTransform(value: unknown, errors: string[]): value is IdentityTransform {
  const path = "input.tf";
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return false;
  }
  rejectUnknown(value, ["scale", "rotZ", "offX", "offY"], path, errors);
  if (value.scale !== 1 || value.rotZ !== 0 || value.offX !== 0 || value.offY !== 0)
    errors.push(`${path} 首切片只接受 identity transform`);
  return true;
}

export function validateQuickSimulationInput(value: unknown): SimulationValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, value: null, errors: ["input 必须是对象"] };
  rejectUnknown(value, ["modelId", "machine", "material", "settings", "tf"], "input", errors);
  if (!SIMULATOR_MODEL_IDS.includes(value.modelId as SimulatorModelId)) errors.push("input.modelId 取值无效");
  validateMachine(value.machine, errors);
  validateMaterial(value.material, errors);
  validateSettings(value.settings, errors);
  validateIdentityTransform(value.tf, errors);
  if (isRecord(value.material) && isRecord(value.settings) && value.settings.material !== value.material.id)
    errors.push("input.settings.material 必须与 input.material.id 一致");
  return errors.length
    ? { ok: false, value: null, errors }
    : { ok: true, value: value as unknown as QuickSimulationInput, errors: [] };
}

export function assertQuickSimulationInput(value: unknown): QuickSimulationInput {
  const validation = validateQuickSimulationInput(value);
  if (!validation.ok) throw new QuickSimulationInputError(validation.errors);
  return validation.value;
}
