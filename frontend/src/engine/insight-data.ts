/* FORGE·X 智造洞察 — 数据层：示例生产数据生成 / CSV 解析与导出 / 模拟器运行数据采集。
   自 js/insight-data.js 机械迁移：算法逐行保留，仅换模块壳并加类型。
   金额以「分」为最小单位整数存储，展示层转元。 */
import { mulberry32 } from "./util.ts";
import * as farmDataset from "./farm-dataset.ts";

export interface JobRow {
  job_id?: string;
  date?: string;
  machine_id?: string;
  model_name?: string;
  material?: string;
  layer_height_mm?: number;
  duration_min?: number;
  filament_g?: number;
  cost_fen?: number;
  status?: string;
  fail_reason?: string;
  energy_kwh?: number;
  _telemetry?: SimTelemetrySnapshot | undefined;
  [key: string]: unknown;
}

export interface SimTelemetrySnapshot {
  clogLoadMax: number | null;
  slipRiskMax: number | null;
  warpRisk: number | null;
  overhangRisk: number | null;
  tempDevMax: number | null;
  firstLayerUneven: number | null;
  leveled: boolean;
  pauses: number;
  tunes: number;
  nozzleTemp: number | null;
  bedTemp: number | null;
  speed: number | null;
  supportEnabled: boolean | null;
  machineProfile: unknown;
}

export interface CostProfile {
  id: string;
  label: string;
  source: string;
  material: Record<string, number>;
  materialDefaultFen: number;
  powerFenPerKwh: number;
  machineFenPerHour: number;
  [key: string]: unknown;
}

export interface Provenance {
  source: string;
  synthetic: boolean;
  badge: string;
  note: string;
  generator: { name: string; version: number; seed: number | null } | null;
}

export interface StoreProvenance extends Provenance {
  datasetKey: string;
  rowCount: number;
}

/* ── 常量口径 ─────────────────────────────── */

export const FIELDS = [
  "job_id",
  "date",
  "machine_id",
  "model_name",
  "material",
  "layer_height_mm",
  "duration_min",
  "filament_g",
  "cost_fen",
  "status",
  "fail_reason",
  "energy_kwh",
] as const;

/**
 * 计价口径（可替换）。材料单价（分/kg）· 电价（分/kWh）· 机时折旧（分/小时）。
 * ⚠ 这是估算值，不是权威数据。任何用它算出的金额在报告中都必须连同 `source` 一起披露。
 */
const DEFAULT_COST_PROFILE: CostProfile = {
  id: "cn-retail-2026q3",
  label: "中国大陆零售参考价（2026Q3）",
  source: "主流电商耗材零售均价 + 民用商业电价的量级估算，非权威数据；请按自己的采购成本替换",
  material: { PLA: 6900, PETG: 8900, ABS: 7900, TPU: 15900 },
  materialDefaultFen: 8000, // 未知材料的兜底单价（分/kg）
  powerFenPerKwh: 60,
  machineFenPerHour: 12,
};

let costProfile: CostProfile = DEFAULT_COST_PROFILE;

export function getCostProfile(): CostProfile {
  return costProfile;
}

/** 替换计价口径；缺省字段沿用当前值。返回生效后的 profile。 */
export function setCostProfile(p: Partial<CostProfile> | null | undefined): CostProfile {
  if (!p || typeof p !== "object") return costProfile;
  const next = {} as CostProfile;
  for (const k in costProfile) (next as Record<string, unknown>)[k] = costProfile[k];
  for (const j in p) (next as Record<string, unknown>)[j] = (p as Record<string, unknown>)[j];
  costProfile = next;
  return next;
}

export const MACHINES = ["FX-256-01", "FX-256-02", "FX-256-03", "FX-256-04"];

/**
 * 故障词表（单一真源）。仿真侧与分析侧共用这一份枚举。
 * `mech` 是该类故障在仿真器中的物理产生机理；`match` 是仿真器故障名 → 标准类型的匹配子串。
 */
export const FAULT_TAXONOMY = [
  { name: "堵料", stage: "runtime", match: ["堵"], mech: "热端积碳 × 温度不足 × 体积流量过大 → 挤出负载超限" },
  { name: "断料", stage: "runtime", match: ["断料"], mech: "送料齿轮咬合力不足 × 料架阻力 × 料盘将空 → 打滑" },
  {
    name: "热失控",
    stage: "runtime",
    match: ["热失控", "加热失败"],
    mech: "加热器有效功率不足，够不到高温材料目标 → 温度失守保护",
  },
  {
    name: "翘边",
    stage: "scrap",
    match: ["翘边"],
    mech: "床温低于材料下限 × 环境冷/有风 × 材料收缩率 × 大平面 → 首层附着失效",
  },
  { name: "悬垂塌陷", stage: "scrap", match: ["塌陷"], mech: "需支撑却未开启，或冷却/层高/速度不足以成形桥接段" },
] as const;
export const FAIL_REASONS = FAULT_TAXONOMY.map((f) => f.name);
/** 仿真器可真实产出的故障类型（现已覆盖全部五类） */
export const SIM_FAULTS = FAIL_REASONS.slice();
/** 无法归类时的取值——绝不允许兜底猜成某个具体故障 */
export const FAULT_UNKNOWN = "未知";

/**
 * 仿真器故障名 → 标准故障类型。单一真源：前端采集与虚拟机群共用本函数。
 * 匹配不上一律返回「未知」，绝不猜。
 */
export function normalizeFault(name: unknown): string {
  const s = String(name || "");
  if (!s) return "";
  for (let i = 0; i < FAULT_TAXONOMY.length; i++) {
    const t = FAULT_TAXONOMY[i]!;
    for (let j = 0; j < t.match.length; j++) {
      if (s.indexOf(t.match[j]!) >= 0) return t.name;
    }
  }
  return FAULT_UNKNOWN;
}

export function costFen(material: string, filamentG: number, energyKwh: number, durationMin: number): number {
  const p = costProfile;
  const price = p.material[material] || p.materialDefaultFen;
  return Math.round(
    (filamentG / 1000) * price + energyKwh * p.powerFenPerKwh + (durationMin / 60) * p.machineFenPerHour
  );
}

/* ── 合成基准数据（确定性，种子固定） ───────── */

/**
 * ⚠⚠ 这是合成数据，不是真实产线数据。⚠⚠
 * 按预先写死的概率生成；用途仅限 UI 演示与回归测试的确定性输入。
 * 任何展示它的界面都必须显示 PROVENANCE.sample 的合成标记。
 */
export function generateSample(count?: number): JobRow[] {
  const rnd = mulberry32(20260721);
  const n = count || 96;
  const rows: JobRow[] = [];

  const models = [
    { name: "行星齿轮", baseMin: 95, baseG: 34, difficulty: 0.03 },
    { name: "涡轮叶轮", baseMin: 150, baseG: 52, difficulty: 0.07 },
    { name: "传感器支架", baseMin: 120, baseG: 41, difficulty: 0.12 },
  ];
  const materials = ["PLA", "PLA", "PETG", "PETG", "ABS", "TPU"]; // 权重分布
  const layerHs = [0.12, 0.2, 0.2, 0.2, 0.28];
  const machineFailBase: Record<string, number> = {
    "FX-256-01": 0.04,
    "FX-256-02": 0.06,
    "FX-256-03": 0.2,
    "FX-256-04": 0.05,
  };
  const speedFactor: Record<string, number> = { PLA: 1, PETG: 1.18, ABS: 1.12, TPU: 2.1 };

  const startDay = Date.UTC(2026, 5, 29); // 2026-06-29，三周
  for (let i = 0; i < n; i++) {
    const machine = MACHINES[Math.floor(rnd() * 4)]!;
    const model = models[Math.floor(rnd() * models.length)]!;
    const material = materials[Math.floor(rnd() * materials.length)]!;
    const lh = layerHs[Math.floor(rnd() * layerHs.length)]!;

    const dayOff = Math.floor(rnd() * 21);
    const date = new Date(startDay + dayOff * 86400000);
    const dateStr = date.toISOString().slice(0, 10);

    // 失败概率：机台基线 + 模型难度 + 危险组合（ABS/PETG × 悬垂件）
    let pFail = machineFailBase[machine]! + model.difficulty;
    const risky = model.name === "传感器支架" && (material === "ABS" || material === "PETG");
    if (risky) pFail += material === "ABS" ? 0.22 : 0.1;
    const failed = rnd() < pFail;

    let reason = "";
    if (failed) {
      const r = rnd();
      if (machine === "FX-256-03") reason = r < 0.42 ? "堵料" : r < 0.75 ? "断料" : "热失控";
      else if (risky) reason = r < 0.55 ? "翘边" : "悬垂塌陷";
      else reason = FAIL_REASONS[Math.floor(r * FAIL_REASONS.length)]!;
    }

    const lhFactor = 0.2 / lh;
    let dur = model.baseMin * lhFactor * speedFactor[material]! * (0.9 + rnd() * 0.22);
    let g = model.baseG * (0.94 + rnd() * 0.14);
    if (failed) {
      const cut = 0.15 + rnd() * 0.6;
      dur *= cut;
      g *= cut;
    } // 中途失败
    dur = Math.round(dur);
    g = Math.round(g * 10) / 10;
    const kwh = Math.round((dur / 60) * (material === "ABS" ? 0.34 : 0.24) * 100) / 100;

    rows.push({
      job_id: "J202607-" + String(1000 + i + 1).slice(1),
      date: dateStr,
      machine_id: machine,
      model_name: model.name,
      material,
      layer_height_mm: lh,
      duration_min: dur,
      filament_g: g,
      cost_fen: costFen(material, g, kwh, dur),
      status: failed ? "fail" : "success",
      fail_reason: reason,
      energy_kwh: kwh,
    });
  }
  return rows;
}

/* ── CSV 解析 / 导出 ─────────────────────── */

const HEADER_ALIAS: Record<string, string[]> = {
  job_id: ["job_id", "任务id", "任务编号", "job"],
  date: ["date", "日期", "打印日期"],
  machine_id: ["machine_id", "机台", "机台编号", "设备", "machine"],
  model_name: ["model_name", "模型", "模型名称", "model"],
  material: ["material", "材料", "耗材类型"],
  layer_height_mm: ["layer_height_mm", "层高", "layer_height"],
  duration_min: ["duration_min", "耗时", "时长", "duration", "耗时分钟"],
  filament_g: ["filament_g", "耗材克重", "耗材", "克重"],
  cost_fen: ["cost_fen", "成本分", "cost"],
  cost_cny: ["cost_cny", "成本", "成本元", "单件成本"],
  status: ["status", "状态", "结果"],
  fail_reason: ["fail_reason", "故障类型", "失败原因", "故障"],
  energy_kwh: ["energy_kwh", "能耗", "电量"],
};
const NUM_FIELDS: Record<string, 1> = {
  layer_height_mm: 1,
  duration_min: 1,
  filament_g: 1,
  cost_fen: 1,
  energy_kwh: 1,
};
const STRICT_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SUCCESS_STATUS: Record<string, 1> = {
  success: 1,
  succeeded: 1,
  ok: 1,
  complete: 1,
  completed: 1,
  成功: 1,
  完成: 1,
};
const FAIL_STATUS: Record<string, 1> = { fail: 1, failed: 1, failure: 1, error: 1, 失败: 1, 故障: 1 };

/** 单行 CSV 切分（支持双引号包裹与转义），无引号时按逗号直切 */
export function splitCsvLine(line: string): string[] {
  if (line.indexOf('"') < 0) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * 解析 CSV 文本 → { rows, errors[] }。表头中英文宽松匹配；
 * status 归一化为 success/fail；cost_cny（元）自动转 cost_fen（分）。
 */
export function parseCsv(text: string): { rows: JobRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) return { rows: [], errors: ["CSV 至少需要表头 + 1 行数据"] };

  const heads = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const map: Record<number, string> = {}; // 列下标 → 标准字段
  for (let c = 0; c < heads.length; c++) {
    for (const field in HEADER_ALIAS) {
      if (HEADER_ALIAS[field]!.indexOf(heads[c]!) >= 0) {
        map[c] = field;
        break;
      }
    }
  }
  const mapped: string[] = [];
  for (const mc in map) mapped.push(map[mc]!);
  if (mapped.indexOf("status") < 0) errors.push("缺少必需列：status（状态）");
  if (mapped.indexOf("machine_id") < 0 && mapped.indexOf("material") < 0)
    errors.push("machine_id（机台）与 material（材料）至少需其一");
  if (errors.length) return { rows: [], errors };

  let rows: JobRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const row: JobRow = {};
    const rowErrors: string[] = [];
    for (let ci = 0; ci < cells.length; ci++) {
      const f = map[ci];
      if (!f) continue;
      const v = cells[ci]!.trim();
      if (f === "cost_cny" || NUM_FIELDS[f]) {
        if (v === "") {
          if (f === "cost_cny") row.cost_fen = 0;
          else (row as Record<string, unknown>)[f] = 0;
          continue;
        }
        if (!STRICT_NUMBER.test(v)) {
          rowErrors.push(f + " 不是有效数值（" + v + "）");
          continue;
        }
        const numeric = Number(v);
        if (!isFinite(numeric)) {
          rowErrors.push(f + " 超出有限数值范围（" + v + "）");
          continue;
        }
        if (f === "cost_cny") row.cost_fen = Math.round(numeric * 100);
        else (row as Record<string, unknown>)[f] = numeric;
        continue;
      }
      (row as Record<string, unknown>)[f] = v;
    }
    // 状态归一化
    const st = String(row.status || "").toLowerCase();
    if (FAIL_STATUS[st]) row.status = "fail";
    else if (SUCCESS_STATUS[st]) row.status = "success";
    else rowErrors.push("status 取值无效（" + (st || "空") + "）");
    if (rowErrors.length) {
      errors.push("第 " + (i + 1) + " 行：" + rowErrors.join("；"));
      continue;
    }
    if (row.status !== "fail") row.fail_reason = "";
    rows.push(row);
  }
  if (rows.length > 5000) {
    rows = rows.slice(0, 5000);
    errors.push("数据超过 5000 行，已截取前 5000 行");
  }
  return { rows, errors };
}

/** rows → CSV 文本（标准字段序） */
export function toCsv(rows: JobRow[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [FIELDS.join(",")];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const line: string[] = [];
    for (let f = 0; f < FIELDS.length; f++) line.push(esc(r[FIELDS[f]!]));
    out.push(line.join(","));
  }
  return out.join("\n");
}

/* ── 数据来源标记（provenance 契约） ──────────
   synthetic:true 的数据集，在数据接入区、报告头、分享页都必须显示合成标记。 */

export const PROVENANCE: Record<string, Provenance> = {
  farm: {
    source: "sim-farm",
    synthetic: true,
    badge: "机群仿真",
    note:
      "由虚拟机群物理仿真产出：8 台机器各有确定性的固有物理特征（热端积碳、送料咬合力、" +
      "加热器功率、环境温度…），故障是这些特征与本单工艺参数相互作用的结果，" +
      "没有任何一台机器被预先指定过故障率。非真实产线数据，但结论可被证伪。",
    generator: { name: "tools/farm-sim.js", version: 1, seed: 20260726 },
  },
  sample: {
    source: "synthetic",
    synthetic: true,
    badge: "合成",
    note:
      "概率生成的演示数据，含预先写死的故事线（03 号机高故障率、ABS×悬垂件高失败）。" +
      "从中得出的结论只是生成参数的回显，不适用于任何真实设备。保留仅为回归测试的确定性输入。",
    generator: { name: "FXInsightData.generateSample", version: 1, seed: 20260721 },
  },
  upload: {
    source: "user-upload",
    synthetic: false,
    badge: "",
    note: "用户上传的 CSV。",
    generator: null,
  },
  sim: {
    source: "simulator",
    synthetic: true,
    badge: "仿真",
    note:
      "由本机仿真器的物理过程产出（温控惯性、床面误差场、机构负载、成品判废），" +
      "是真实计算结果但非真实产线数据。故障不是抽样出来的：" +
      "每台机器有确定性的固有物理特征，故障是这些特征与本单工艺参数相互作用的结果。",
    generator: { name: "FXSim", version: 2, seed: null },
  },
  "sim-farm": {
    source: "sim-farm",
    synthetic: true,
    badge: "机群仿真",
    note:
      "由虚拟机群（tools/farm-sim.js）批量物理仿真产出。多台机器各有固有物理特征，" +
      "失败与故障类型完全由物理演化决定，仅排产（派给哪台机、用什么材料参数）使用随机。" +
      "同一 seed 完全可复现。",
    generator: { name: "tools/farm-sim.js", version: 1, seed: null },
  },
};

/* ── 数据集管理（浏览器态） ───────────────── */

interface BusLike {
  emit(event: string, payload?: unknown): void;
}

interface DatasetSlot {
  label: string;
  rows: JobRow[];
  provenance: Provenance;
}

/**
 * 三个数据集槽位：farm（机群仿真）/ upload（用户 CSV）/ sim（仿真采集）。
 * bus 事件：insight-data（数据集变更）。
 */
export class Store {
  bus: BusLike | null;
  sets: Record<string, DatasetSlot>;
  active: string;

  constructor(bus?: BusLike | null) {
    this.bus = bus ?? null;
    // 默认数据集是物理仿真产出的机群数据，而不是埋了故事线的概率合成数据——
    // 开箱即用的那份数据，其结论必须是能被证伪的。
    const farm = farmDataset.rows();
    this.sets = {
      farm: { label: "机群仿真", rows: farm, provenance: PROVENANCE.farm! },
      upload: { label: "我的上传", rows: [], provenance: PROVENANCE.upload! },
      sim: { label: "本机采集", rows: [], provenance: PROVENANCE.sim! },
    };
    // 机群数据为空时退回合成数据，但如实标注来源
    if (!farm.length) {
      this.sets.farm = { label: "合成示例", rows: generateSample(), provenance: PROVENANCE.sample! };
    }
    this.active = "farm";
  }

  rows(): JobRow[] {
    return this.sets[this.active]!.rows;
  }

  /** 当前数据集的来源标记（随报告一起流转） */
  provenance(): StoreProvenance {
    const s = this.sets[this.active]!;
    const p = s.provenance || PROVENANCE.upload!;
    return {
      source: p.source,
      synthetic: p.synthetic,
      badge: p.badge,
      note: p.note,
      generator: p.generator,
      datasetKey: this.active,
      rowCount: s.rows.length,
    };
  }

  use(key: string): void {
    if (!this.sets[key]) return;
    this.active = key;
    if (this.bus) this.bus.emit("insight-data", { set: key });
  }

  setUpload(rows: JobRow[]): void {
    this.sets.upload!.rows = rows;
    this.active = "upload";
    if (this.bus) this.bus.emit("insight-data", { set: "upload" });
  }

  addSimRecord(rec: JobRow): void {
    this.sets.sim!.rows.push(rec);
    if (this.bus) this.bus.emit("insight-data", { set: "sim", appended: true });
  }
}

/** 当前在跑的机型 → 机台编号。取仿真器实际装载的机型，不写死。
    单机仿真固定为 -01 实例；P2 的虚拟机群会给出真实的多实例编号。 */
export function machineIdFromSim(sim: { printer?: { MODEL_TAG?: string; MODEL_NAME?: string } | null } | null): string {
  const p = sim && sim.printer;
  let tag = (p && (p.MODEL_TAG || p.MODEL_NAME)) || "";
  tag = String(tag).trim();
  return tag ? tag + "-01" : "UNKNOWN-01";
}

interface SimLike {
  settings: { material: string; layerHeight: number };
  machineElapsed: number;
  usedG: number;
  model: { name: string } | null;
  printer?: { MODEL_TAG?: string; MODEL_NAME?: string } | null;
  _telemetry?: {
    clogLoadMax?: number | null;
    slipRiskMax?: number | null;
    warpRisk?: number | null;
    overhangRisk?: number | null;
    tempDevMax?: number | null;
    firstLayerUneven?: number | null;
    leveled?: boolean;
    pauses?: number;
    tunes?: number;
    settings0?: { nozzleTemp?: number; bedTemp?: number; speed?: number; supportEnabled?: boolean } | null;
    machineProfile?: unknown;
  } | null;
}

/**
 * 由模拟器状态构造一条生产记录（sim 完成/中止/故障时调用）。
 * 除 12 个标准 CSV 列外，还挂上 `_telemetry` —— 仿真过程真实采集的物理量。
 * 它们不进 CSV（保持标准字段简洁），但留在内存记录上供后续深度分析使用。
 */
export function recordFromSim(sim: SimLike, status: string, failReason?: string): JobRow {
  const mat = sim.settings.material;
  const dur = Math.round(sim.machineElapsed / 60) || 1; // 机时（分钟）
  const g = Math.round(sim.usedG * 10) / 10;
  const kwh = Math.round((dur / 60) * (mat === "ABS" ? 0.34 : 0.24) * 100) / 100;
  const rec: JobRow = {
    job_id: "SIM-" + String(Date.now()).slice(-6),
    date: new Date().toISOString().slice(0, 10),
    machine_id: machineIdFromSim(sim), // 曾写死 "FX-256-01"：跑 FX-500 也记成 FX-256
    model_name: sim.model ? sim.model.name : "未知模型",
    material: mat,
    layer_height_mm: sim.settings.layerHeight,
    duration_min: dur,
    filament_g: g,
    cost_fen: costFen(mat, g, kwh, dur),
    status,
    fail_reason: failReason || "",
    energy_kwh: kwh,
  };
  const t = sim._telemetry;
  if (t) {
    rec._telemetry = {
      clogLoadMax: round2(t.clogLoadMax),
      slipRiskMax: round2(t.slipRiskMax),
      warpRisk: t.warpRisk != null ? t.warpRisk : null,
      overhangRisk: t.overhangRisk != null ? t.overhangRisk : null,
      tempDevMax: round2(t.tempDevMax),
      firstLayerUneven: round3(t.firstLayerUneven),
      leveled: !!t.leveled,
      pauses: t.pauses ?? 0,
      tunes: t.tunes ?? 0,
      nozzleTemp: t.settings0 ? (t.settings0.nozzleTemp ?? null) : null,
      bedTemp: t.settings0 ? (t.settings0.bedTemp ?? null) : null,
      speed: t.settings0 ? (t.settings0.speed ?? null) : null,
      supportEnabled: t.settings0 ? !!t.settings0.supportEnabled : null,
      machineProfile: t.machineProfile || null,
    };
  }
  return rec;
}

function round2(v: number | null | undefined): number | null {
  return v == null ? null : Math.round(v * 100) / 100;
}
function round3(v: number | null | undefined): number | null {
  return v == null ? null : Math.round(v * 1000) / 1000;
}

/** 浏览器下载 CSV（data URI，file:// 直开可用） */
export function downloadCsv(rows: JobRow[], filename?: string): void {
  const a = document.createElement("a");
  a.href = "data:text/csv;charset=utf-8,\uFEFF" + encodeURIComponent(toCsv(rows));
  a.download = filename || "print_jobs.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 兼容 FXInsightData 形状的聚合对象（COST_PROFILE / PRICE 为可变字段）。 */
export const FXInsightDataCompat = {
  FIELDS,
  get COST_PROFILE() {
    return costProfile;
  },
  set COST_PROFILE(v: CostProfile) {
    costProfile = v;
  },
  get PRICE() {
    return costProfile;
  },
  setCostProfile,
  MACHINES,
  FAULT_TAXONOMY,
  FAIL_REASONS,
  SIM_FAULTS,
  FAULT_UNKNOWN,
  normalizeFault,
  costFen,
  generateSample,
  splitCsvLine,
  parseCsv,
  toCsv,
  PROVENANCE,
  Store,
  machineIdFromSim,
  recordFromSim,
  downloadCsv,
};
