import type { GcodeParseOptions } from "../gcode/gcode-types";
import { legacyProfileRegistry } from "../../legacy/profile-registry-adapter.js";
import type {
  MachineProfile,
  MaterialProfile,
  ProfileBundle,
  ProfileCatalog,
  ProfileImportErrorCode,
  ProfileImportResult,
  ProfileOptionDraft,
  ProfileOptionErrors,
  ProfileOptionValidation,
  ProfileStorageStatus,
  ProfileValidationResult,
} from "./profile-types";

export const PROFILE_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const PROFILE_BED_SIZE_RANGE = { min: 50, max: 2000 } as const;
export const PROFILE_DENSITY_RANGE = { min: 0.2, max: 5 } as const;

export class ProfileImportError extends Error {
  public constructor(
    public readonly code: ProfileImportErrorCode,
    message: string,
    public readonly details: readonly string[] = []
  ) {
    super(message);
    this.name = "ProfileImportError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = JSON.parse(JSON.stringify(value)) as T;
  return deepFreeze(cloned);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function listProfileCatalog(): ProfileCatalog {
  return cloneAndFreeze({
    machines: legacyProfileRegistry.listMachines(),
    materials: legacyProfileRegistry.listMaterials(),
  });
}

/**
 * The legacy validator is the behavior authority during UI migration. The
 * shallow array guard keeps arbitrary JSON from reaching legacy `.forEach`
 * paths and also provides stable, user-facing errors.
 */
export function validateProfileBundle(value: unknown): ProfileValidationResult {
  if (!isRecord(value)) return { ok: false, errors: ["Profile bundle 必须是 JSON 对象"] };

  const preflightErrors: string[] = [];
  if (!Array.isArray(value.machines)) preflightErrors.push("machines 必须是数组");
  if (!Array.isArray(value.materials)) preflightErrors.push("materials 必须是数组");
  if (preflightErrors.length) return { ok: false, errors: preflightErrors };

  try {
    const result = legacyProfileRegistry.validateBundle(value);
    return { ok: result.ok, errors: [...result.errors] };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "Profile bundle 校验失败"],
    };
  }
}

export function deriveProfileOptions(machine: MachineProfile, material: MaterialProfile): GcodeParseOptions {
  return Object.freeze({
    bedSize: Math.max(machine.buildVolume.x, machine.buildVolume.y),
    densityG: material.densityG,
    origin: machine.kinematics === "delta" ? "center" : "corner",
    machineProfileId: machine.id,
    materialProfileId: material.id,
  });
}

function strictNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateProfileOptionDraft(draft: ProfileOptionDraft): ProfileOptionValidation {
  const errors: Partial<Record<keyof ProfileOptionDraft, string>> = {};
  const bedSize = strictNumber(draft.bedSize);
  const densityG = strictNumber(draft.densityG);

  if (bedSize === null || bedSize < PROFILE_BED_SIZE_RANGE.min || bedSize > PROFILE_BED_SIZE_RANGE.max) {
    errors.bedSize = `平台尺寸必须在 ${PROFILE_BED_SIZE_RANGE.min}–${PROFILE_BED_SIZE_RANGE.max} mm`;
  }
  if (densityG === null || densityG < PROFILE_DENSITY_RANGE.min || densityG > PROFILE_DENSITY_RANGE.max) {
    errors.densityG = `材料密度必须在 ${PROFILE_DENSITY_RANGE.min}–${PROFILE_DENSITY_RANGE.max} g/cm³`;
  }
  if (draft.origin !== "corner" && draft.origin !== "center") {
    errors.origin = "坐标原点必须是床角或床心";
  }

  const readonlyErrors: ProfileOptionErrors = Object.freeze(errors);
  if (Object.keys(errors).length || bedSize === null || densityG === null) {
    return { ok: false, options: null, errors: readonlyErrors };
  }
  return {
    ok: true,
    options: Object.freeze({ bedSize, densityG, origin: draft.origin }),
    errors: readonlyErrors,
  };
}

export function getProfileStorageStatus(): ProfileStorageStatus {
  try {
    if (typeof globalThis.localStorage === "undefined") {
      return { available: false, message: "本地存储不可用；导入仅在本次会话保留。" };
    }
    const key = "__forgex_profile_storage_probe__";
    globalThis.localStorage.setItem(key, "1");
    globalThis.localStorage.removeItem(key);
    return { available: true, message: "社区 Profile 保存在当前浏览器本地，可在刷新后继续使用。" };
  } catch {
    return { available: false, message: "本地存储受限；导入仅在本次会话保留。" };
  }
}

export function importProfileBundle(value: unknown): ProfileImportResult {
  const validation = validateProfileBundle(value);
  if (!validation.ok) {
    throw new ProfileImportError(
      "INVALID_BUNDLE",
      `Profile 导入失败：${validation.errors.join("；")}`,
      validation.errors
    );
  }

  try {
    const imported = legacyProfileRegistry.importBundle(value as ProfileBundle);
    const storage = getProfileStorageStatus();
    const persisted = storage.available && legacyProfileRegistry.persist();
    return cloneAndFreeze({
      machines: imported.machines,
      materials: imported.materials,
      persisted,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Profile 导入失败";
    const code: ProfileImportErrorCode = /不能覆盖内置 Profile/.test(message) ? "BUILTIN_OVERRIDE" : "IMPORT_FAILED";
    throw new ProfileImportError(code, message);
  }
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Profile 文件读取失败"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
}

export async function importProfileFile(file: File): Promise<ProfileImportResult> {
  if (!/\.json$/i.test(file.name)) {
    throw new ProfileImportError("INVALID_EXTENSION", "Profile 必须是 .json 文件");
  }
  if (file.size > PROFILE_FILE_MAX_BYTES) {
    throw new ProfileImportError("FILE_TOO_LARGE", "Profile JSON 超过 2 MB 上限");
  }

  let text: string;
  try {
    text = await readFileText(file);
  } catch (error) {
    throw new ProfileImportError("READ_FAILED", error instanceof Error ? error.message : "Profile 文件读取失败");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ProfileImportError("INVALID_JSON", "Profile 文件不是有效 JSON");
  }
  return importProfileBundle(value);
}
