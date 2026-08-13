/* FORGE·X — 社区 Profile 注册表（纯逻辑，可在 Node 与浏览器运行）。
   自 js/profile-registry.js 机械迁移：算法逐行保留，仅换模块壳并加类型。

   Profile 的边界：
     - machine profile 选择现有运动学基座，并提供构建空间、机型标签与物理特征；
     - material profile 提供温度、密度、流量、收缩与速度参数；
     - JSON 不能注入代码。社区扩展只能使用白名单字段与四种已实现运动学。
   浏览器通过文件选择导入 bundle；成功后保存到 localStorage，file:// 同样可用。 */
import { registerModelTrait } from "./machine-profile.ts";
import { FXPrinters } from "./printer3d.ts";
import { getCostProfile, setCostProfile } from "./insight-data.ts";
import "./printers.ts"; // 副作用：确保 i3 / delta / gantry 基座先于内置 Profile 注册

/* 浏览器环境边界：localStorage 在 Node 测试环境不存在，运行时探测。 */
interface EnvGlobals {
  localStorage?: Storage;
}
const env = globalThis as unknown as EnvGlobals;

const STORAGE_KEY = "forgex-community-profiles-v1";
const KINEMATICS = ["corexy", "i3", "delta", "gantry"];

export interface MachineSpec {
  id: string;
  name: string;
  tag: string;
  kinematics: string;
  description: string;
  buildVolume: { x: number; y: number; z: number };
  enclosed: boolean;
  physics?: Record<string, number>;
  source: string;
  community?: boolean;
}

export interface MaterialSpec {
  id: string;
  name: string;
  nozzle: { default: number; min: number; max: number };
  bed: { default: number; min: number };
  fan: number;
  densityG: number;
  maxSpeed: number;
  flowMm3s: number;
  shrinkage: number;
  priceCnyKg: number;
  source: string;
  community?: boolean;
  /** normalize 后附加的便捷字段 */
  nozzleTemp?: number;
  nozzleRange?: [number, number];
  bedTemp?: number;
  bedMin?: number;
}

export interface ProfileBundle {
  $schema?: string;
  format: string;
  version: number;
  machines: MachineSpec[];
  materials: MaterialSpec[];
}

export const machines: Record<string, MachineSpec> = {};
export const materials: Record<string, MaterialSpec> = {};
let community: ProfileBundle = { format: "forgex-profile-bundle", version: 1, machines: [], materials: [] };
let baseCostSource: string | null = null;

const BUILTIN_MACHINES: MachineSpec[] = [
  {
    id: "corexy",
    name: "FX-256 睿造",
    tag: "FX-256",
    kinematics: "corexy",
    description: "CoreXY · 封闭腔体",
    buildVolume: { x: 256, y: 256, z: 256 },
    enclosed: true,
    source: "FORGE·X built-in profile",
  },
  {
    id: "i3",
    name: "FX-220 轻锋",
    tag: "FX-220",
    kinematics: "i3",
    description: "i3 龙门 · 开放式",
    buildVolume: { x: 220, y: 220, z: 250 },
    enclosed: false,
    source: "FORGE·X built-in profile",
  },
  {
    id: "delta",
    name: "FX-Δ260 迅影",
    tag: "FX-Δ260",
    kinematics: "delta",
    description: "Delta · 并联臂",
    buildVolume: { x: 260, y: 260, z: 320 },
    enclosed: false,
    source: "FORGE·X built-in profile",
  },
  {
    id: "gantry",
    name: "FX-500 巨匠",
    tag: "FX-500",
    kinematics: "gantry",
    description: "工业龙门 · 大幅面",
    buildVolume: { x: 500, y: 500, z: 500 },
    enclosed: true,
    source: "FORGE·X built-in profile",
  },
];

const BUILTIN_MATERIALS: MaterialSpec[] = [
  {
    id: "PLA",
    name: "PLA",
    nozzle: { default: 210, min: 195, max: 225 },
    bed: { default: 60, min: 55 },
    fan: 100,
    densityG: 1.24,
    maxSpeed: 300,
    flowMm3s: 11,
    shrinkage: 0.25,
    priceCnyKg: 69,
    source: "FORGE·X engineering baseline",
  },
  {
    id: "PETG",
    name: "PETG",
    nozzle: { default: 240, min: 230, max: 255 },
    bed: { default: 80, min: 70 },
    fan: 40,
    densityG: 1.27,
    maxSpeed: 200,
    flowMm3s: 9,
    shrinkage: 0.45,
    priceCnyKg: 89,
    source: "FORGE·X engineering baseline",
  },
  {
    id: "ABS",
    name: "ABS",
    nozzle: { default: 255, min: 245, max: 268 },
    bed: { default: 100, min: 95 },
    fan: 15,
    densityG: 1.05,
    maxSpeed: 220,
    flowMm3s: 10,
    shrinkage: 1,
    priceCnyKg: 79,
    source: "FORGE·X engineering baseline",
  },
  {
    id: "TPU",
    name: "TPU",
    nozzle: { default: 225, min: 215, max: 240 },
    bed: { default: 50, min: 40 },
    fan: 50,
    densityG: 1.21,
    maxSpeed: 60,
    flowMm3s: 3.5,
    shrinkage: 0.35,
    priceCnyKg: 159,
    source: "FORGE·X engineering baseline",
  },
];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function finite(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && isFinite(v) && v >= min && v <= max;
}

function safeId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{1,47}$/.test(v);
}

function safeText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: string[], path: string, errors: string[]): void {
  Object.keys(obj).forEach((key) => {
    if (allowed.indexOf(key) < 0) errors.push(path + "." + key + " 不是允许的字段");
  });
}

function validatePhysics(obj: unknown, path: string, errors: string[]): void {
  if (obj == null) return;
  if (!plainObject(obj)) {
    errors.push(path + " 必须是对象");
    return;
  }
  const ranges: Record<string, [number, number]> = {
    hotendFouling: [0, 1],
    feederGrip: [0.4, 1],
    spoolDrag: [0, 1],
    heaterHealth: [0.5, 1],
    beltWear: [0, 1],
    ambientC: [0, 60],
    draft: [0, 1],
  };
  Object.keys(obj).forEach((key) => {
    const range = ranges[key];
    if (!range) errors.push(path + "." + key + " 不是允许的物理字段");
    else if (!finite(obj[key], range[0], range[1]))
      errors.push(path + "." + key + " 超出范围 " + range[0] + "–" + range[1]);
  });
}

export function validateMachine(m: unknown, path?: string): string[] {
  path = path || "machine";
  const errors: string[] = [];
  if (!plainObject(m)) return [path + " 必须是对象"];
  rejectUnknown(
    m,
    ["id", "name", "tag", "kinematics", "description", "buildVolume", "enclosed", "physics", "source"],
    path,
    errors
  );
  if (!safeId(m.id)) errors.push(path + ".id 仅允许 2–48 位字母、数字、点、下划线或连字符");
  if (!safeText(m.name, 80)) errors.push(path + ".name 必填且不超过 80 字符");
  if (!safeText(m.tag, 40)) errors.push(path + ".tag 必填且不超过 40 字符");
  if (KINEMATICS.indexOf(m.kinematics as string) < 0)
    errors.push(path + ".kinematics 必须是 " + KINEMATICS.join(" / "));
  if (!safeText(m.description, 120)) errors.push(path + ".description 必填且不超过 120 字符");
  const buildVolume = m.buildVolume;
  if (!plainObject(buildVolume)) errors.push(path + ".buildVolume 必须是对象");
  else {
    rejectUnknown(buildVolume, ["x", "y", "z"], path + ".buildVolume", errors);
    (["x", "y", "z"] as const).forEach((axis) => {
      if (!finite(buildVolume[axis], 50, 2000)) errors.push(path + ".buildVolume." + axis + " 必须在 50–2000mm");
    });
  }
  if (typeof m.enclosed !== "boolean") errors.push(path + ".enclosed 必须是布尔值");
  if (!safeText(m.source, 240)) errors.push(path + ".source 必填，用于说明参数出处");
  validatePhysics(m.physics, path + ".physics", errors);
  return errors;
}

export function validateMaterial(m: unknown, path?: string): string[] {
  path = path || "material";
  const errors: string[] = [];
  if (!plainObject(m)) return [path + " 必须是对象"];
  rejectUnknown(
    m,
    ["id", "name", "nozzle", "bed", "fan", "densityG", "maxSpeed", "flowMm3s", "shrinkage", "priceCnyKg", "source"],
    path,
    errors
  );
  if (!safeId(m.id)) errors.push(path + ".id 仅允许 2–48 位字母、数字、点、下划线或连字符");
  if (!safeText(m.name, 80)) errors.push(path + ".name 必填且不超过 80 字符");
  const nozzle = m.nozzle;
  if (!plainObject(nozzle)) errors.push(path + ".nozzle 必须是对象");
  else {
    rejectUnknown(nozzle, ["default", "min", "max"], path + ".nozzle", errors);
    if (!finite(nozzle.default, 120, 450)) errors.push(path + ".nozzle.default 必须在 120–450°C");
    if (!finite(nozzle.min, 120, 450)) errors.push(path + ".nozzle.min 必须在 120–450°C");
    if (!finite(nozzle.max, 120, 450)) errors.push(path + ".nozzle.max 必须在 120–450°C");
    if (
      finite(nozzle.min, 120, 450) &&
      finite(nozzle.max, 120, 450) &&
      ((nozzle.default as number) < nozzle.min || (nozzle.default as number) > nozzle.max)
    )
      errors.push(path + ".nozzle.default 必须落在 min/max 内");
  }
  const bed = m.bed;
  if (!plainObject(bed)) errors.push(path + ".bed 必须是对象");
  else {
    rejectUnknown(bed, ["default", "min"], path + ".bed", errors);
    if (!finite(bed.default, 0, 180)) errors.push(path + ".bed.default 必须在 0–180°C");
    if (!finite(bed.min, 0, 180)) errors.push(path + ".bed.min 必须在 0–180°C");
    if (finite(bed.default, 0, 180) && finite(bed.min, 0, 180) && bed.default < bed.min)
      errors.push(path + ".bed.default 不能低于 bed.min");
  }
  if (!finite(m.fan, 0, 100)) errors.push(path + ".fan 必须在 0–100%");
  if (!finite(m.densityG, 0.2, 5)) errors.push(path + ".densityG 必须在 0.2–5g/cm³");
  if (!finite(m.maxSpeed, 5, 1000)) errors.push(path + ".maxSpeed 必须在 5–1000mm/s");
  if (!finite(m.flowMm3s, 0.2, 100)) errors.push(path + ".flowMm3s 必须在 0.2–100mm³/s");
  if (!finite(m.shrinkage, 0, 3)) errors.push(path + ".shrinkage 必须在 0–3");
  if (!finite(m.priceCnyKg, 0, 5000)) errors.push(path + ".priceCnyKg 必须在 0–5000 元/kg");
  if (!safeText(m.source, 240)) errors.push(path + ".source 必填，用于说明参数出处");
  return errors;
}

export function validateBundle(bundle: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!plainObject(bundle)) return { ok: false, errors: ["Profile bundle 必须是 JSON 对象"] };
  rejectUnknown(bundle, ["$schema", "format", "version", "machines", "materials"], "bundle", errors);
  if (bundle.format !== "forgex-profile-bundle") errors.push("format 必须是 forgex-profile-bundle");
  if (bundle.version !== 1) errors.push("version 必须是 1");
  if (!Array.isArray(bundle.machines)) errors.push("machines 必须是数组");
  if (!Array.isArray(bundle.materials)) errors.push("materials 必须是数组");
  // 畸形 JSON 也必须返回结构化校验错误，不能在随后调用 .forEach 时抛 TypeError。
  const machineList: unknown[] = Array.isArray(bundle.machines) ? bundle.machines : [];
  const materialList: unknown[] = Array.isArray(bundle.materials) ? bundle.materials : [];
  const ids: Record<string, boolean> = {};
  machineList.forEach((m, i) => {
    errors.push(...validateMachine(m, "machines[" + i + "]"));
    const id = plainObject(m) ? String(m.id) : "";
    if (m && ids["machine:" + id]) errors.push("machine id 重复：" + id);
    if (m) ids["machine:" + id] = true;
  });
  materialList.forEach((m, i) => {
    errors.push(...validateMaterial(m, "materials[" + i + "]"));
    const id = plainObject(m) ? String(m.id) : "";
    if (m && ids["material:" + id]) errors.push("material id 重复：" + id);
    if (m) ids["material:" + id] = true;
  });
  if (!machineList.length && !materialList.length) errors.push("bundle 至少要包含一个 machine 或 material");
  return { ok: errors.length === 0, errors };
}

function normalizeMaterial(m: MaterialSpec): MaterialSpec {
  const x = clone(m);
  x.nozzleTemp = x.nozzle.default;
  x.nozzleRange = [x.nozzle.min, x.nozzle.max];
  x.bedTemp = x.bed.default;
  x.bedMin = x.bed.min;
  x.community = !!x.community;
  return x;
}

export function registerMaterial(m: MaterialSpec, isCommunity?: boolean): MaterialSpec {
  const errors = validateMaterial(m);
  if (errors.length) throw new Error(errors.join("；"));
  const x = normalizeMaterial(m);
  x.community = !!isCommunity;
  if (isCommunity && materials[x.id] && !materials[x.id]!.community)
    throw new Error("社区材料不能覆盖内置 Profile：" + x.id);
  materials[x.id] = x;
  if (isCommunity) syncCostProfile();
  return x;
}

export function registerMachine(m: MachineSpec, isCommunity?: boolean): MachineSpec {
  const errors = validateMachine(m);
  if (errors.length) throw new Error(errors.join("；"));
  const x = clone(m);
  x.community = !!isCommunity;
  if (isCommunity && machines[x.id] && !machines[x.id]!.community)
    throw new Error("社区机型不能覆盖内置 Profile：" + x.id);
  machines[x.id] = x;
  registerModelTrait(x.tag, {
    enclosed: x.enclosed,
    buildMm: Math.max(x.buildVolume.x, x.buildVolume.y),
    label: x.description,
  });
  FXPrinters.registerProfile(x);
  return x;
}

export function importBundle(
  bundle: ProfileBundle,
  opt?: { persist?: boolean }
): {
  machines: MachineSpec[];
  materials: MaterialSpec[];
} {
  const check = validateBundle(bundle);
  if (!check.ok) throw new Error(check.errors.join("；"));
  (bundle.machines || []).forEach((m) => {
    if (machines[m.id] && !machines[m.id]!.community) throw new Error("社区机型不能覆盖内置 Profile：" + m.id);
  });
  (bundle.materials || []).forEach((m) => {
    if (materials[m.id] && !materials[m.id]!.community) throw new Error("社区材料不能覆盖内置 Profile：" + m.id);
  });
  const added: { machines: MachineSpec[]; materials: MaterialSpec[] } = { machines: [], materials: [] };
  (bundle.machines || []).forEach((m) => {
    added.machines.push(registerMachine(m, true));
  });
  (bundle.materials || []).forEach((m) => {
    added.materials.push(registerMaterial(m, true));
  });
  if (!opt || opt.persist !== false) {
    (bundle.machines || []).forEach((m) => {
      const i = community.machines.findIndex((x) => x.id === m.id);
      if (i >= 0) community.machines[i] = clone(m);
      else community.machines.push(clone(m));
    });
    (bundle.materials || []).forEach((m) => {
      const i = community.materials.findIndex((x) => x.id === m.id);
      if (i >= 0) community.materials[i] = clone(m);
      else community.materials.push(clone(m));
    });
    persist();
  }
  return added;
}

export function persist(): boolean {
  try {
    if (env.localStorage) env.localStorage.setItem(STORAGE_KEY, JSON.stringify(community));
    return true;
  } catch {
    return false;
  }
}

export function loadStored(): { machines: MachineSpec[]; materials: MaterialSpec[] } | null {
  try {
    if (!env.localStorage) return null;
    const raw = env.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const bundle = JSON.parse(raw) as ProfileBundle;
    const loaded = importBundle(bundle, { persist: false });
    community = clone(bundle);
    return loaded;
  } catch {
    try {
      env.localStorage?.removeItem(STORAGE_KEY);
    } catch {
      /* 清不掉就留着 */
    }
    return null;
  }
}

export function clearStored(): void {
  try {
    env.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

export function machine(id: string): MachineSpec | null {
  return machines[id] || null;
}
export function material(id: string): MaterialSpec | null {
  return materials[id] || null;
}
export function listMachines(): MachineSpec[] {
  return Object.keys(machines).map((id) => machines[id]!);
}
export function listMaterials(): MaterialSpec[] {
  return Object.keys(materials).map((id) => materials[id]!);
}

export function syncCostProfile(): boolean {
  const current = getCostProfile();
  if (baseCostSource == null) baseCostSource = current.source;
  const prices = clone(current.material || {});
  const sources: string[] = [];
  Object.keys(materials).forEach((id) => {
    const m = materials[id]!;
    if (!m.community || !finite(m.priceCnyKg, 0, 5000)) return;
    prices[id] = Math.round(m.priceCnyKg * 100);
    sources.push(id + "：" + m.source);
  });
  setCostProfile({
    material: prices,
    source: baseCostSource + (sources.length ? "；社区 Profile：" + sources.join("；") : ""),
  });
  return true;
}

export const kinematics = KINEMATICS.slice();

export function builtinBundle(): ProfileBundle {
  return {
    format: "forgex-profile-bundle",
    version: 1,
    machines: clone(BUILTIN_MACHINES),
    materials: clone(BUILTIN_MATERIALS),
  };
}

BUILTIN_MATERIALS.forEach((m) => {
  registerMaterial(m, false);
});
BUILTIN_MACHINES.forEach((m) => {
  registerMachine(m, false);
});
loadStored();
