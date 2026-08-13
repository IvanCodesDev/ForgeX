/* FORGE·X — 机台固有物理特征（纯逻辑；不得引用 DOM 或 THREE）。
   自 js/machine-profile.js 机械迁移：算法逐行保留，仅换模块壳并加类型。

   这个模块存在的理由：让故障从物理过程中涌现，而不是概率抽样出来。
   每台机器有一组确定性的固有物理特征（磨损、加热器健康度、料架阻力、环境温度…），
   仿真过程按这些特征真实演化。契约：profile 完全由 machineId 决定（确定性），
   因此数据集可复现。 */
/* 相对引擎导入统一带 .ts 扩展名：Node 直载（测试链/对比脚本）与 Vite 同时可解析。 */
import { mulberry32 } from "./util.ts";

export interface ModelTraits {
  enclosed: boolean;
  buildMm: number;
  label: string;
}

export interface MachineProfile {
  id: string;
  modelTag: string;
  seed: number;
  enclosed: boolean;
  buildMm: number;
  hotendFouling: number;
  feederGrip: number;
  spoolDrag: number;
  heaterHealth: number;
  beltWear: number;
  ambientC: number;
  draft: number;
  heaterTauMul: number;
  [key: string]: unknown;
}

/** 机型 → 结构性属性（不是随机的，由机型决定） */
export const MODEL_TRAITS: Record<string, ModelTraits> = {
  "FX-256": { enclosed: true, buildMm: 256, label: "CoreXY 封闭式" },
  "FX-220": { enclosed: false, buildMm: 220, label: "i3 龙门 开放式" },
  "FX-Δ260": { enclosed: false, buildMm: 260, label: "Delta 并联臂" },
  "FX-500": { enclosed: true, buildMm: 500, label: "工业大幅面龙门" },
};
export const DEFAULT_TRAITS: ModelTraits = { enclosed: false, buildMm: 256, label: "未知机型" };

/** 注册社区机型的结构性属性。只接受数据，不执行任何社区代码。 */
export function registerModelTrait(
  tag: string,
  traits: { enclosed?: unknown; buildMm?: unknown; label?: unknown } | null | undefined
): boolean {
  const key = String(tag || "").trim();
  if (!key || !traits) return false;
  MODEL_TRAITS[key] = {
    enclosed: !!traits.enclosed,
    buildMm: Math.max(50, Math.min(2000, Number(traits.buildMm) || 256)),
    label: String(traits.label || key),
  };
  cache = {};
  return true;
}

/** 从机台编号里取出机型标签，如 "FX-256-03" → "FX-256" */
export function modelTagOf(machineId: unknown): string {
  const s = String(machineId || "");
  const m = s.match(/^(.*)-\d+$/);
  return m ? m[1]! : s;
}

function hashSeed(str: string): number {
  let seed = 0x9e3779b9;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    seed = Math.imul(seed ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return seed >>> 0;
}

let cache: Record<string, MachineProfile> = {};

/**
 * 机台固有物理特征。同一个 machineId 永远返回同一组值——
 * 这是「设备有个性」的建模方式，也是数据集可复现的前提。
 *
 * 各字段的物理含义与影响路径：
 *   hotendFouling  热端积碳/内壁粗糙度 0..1 → 挤出阻力↑ → 堵料
 *   feederGrip     送料齿轮咬合力 1..0.6  → 咬合不足 → 打滑 → 断料
 *   spoolDrag      料架转动阻力 0..1     → 抽料力↑   → 断料
 *   heaterHealth   加热器有效功率 0.7..1 → 高温材料够不到目标 → 热失控保护
 *   heaterTauMul   热时间常数倍率        → 升温慢、抗扰动差
 *   beltWear       皮带磨损 0..1         → 尺寸精度（不直接致故障）
 *   ambientC       环境温度              → 翘边
 *   draft          环境风扰 0..1         → 翘边
 */
export function of(machineId: unknown, overrides?: Record<string, unknown> | null): MachineProfile {
  const id = String(machineId || "UNKNOWN-01");
  if (!overrides && cache[id]) return cache[id]!;

  const tag = modelTagOf(id);
  const traits = MODEL_TRAITS[tag] || DEFAULT_TRAITS;
  const seed = hashSeed(id);
  const rnd = mulberry32(seed);

  // 每台机器抽一次「出厂 + 使用史」，之后终身不变
  const prof: MachineProfile = {
    id,
    modelTag: tag,
    seed,
    enclosed: traits.enclosed,
    buildMm: traits.buildMm,

    hotendFouling: round3(Math.pow(rnd(), 1.7)), // 偏向健康，少数机器积碳重
    feederGrip: round3(1 - Math.pow(rnd(), 2) * 0.4), // 0.6..1
    spoolDrag: round3(Math.pow(rnd(), 1.5)),
    // 0.80..1.00 → 稳态上限约 245..300°C：
    // PLA(210)/TPU(225) 全机群都跑得动，PETG(240) 少数机器吃力，ABS(255) 只有健康机器能稳住。
    heaterHealth: round3(0.8 + rnd() * 0.2),
    beltWear: round3(rnd()),

    // 封闭腔体温度更高更稳；开放式受车间环境影响大
    ambientC: round1(traits.enclosed ? 30 + rnd() * 8 : 18 + rnd() * 8),
    draft: round3(traits.enclosed ? rnd() * 0.25 : 0.25 + rnd() * 0.75),
    heaterTauMul: 0,
  };
  prof.heaterTauMul = round3(1 + (1 - prof.heaterHealth) * 2.2);

  if (overrides) {
    for (const k in overrides) prof[k] = overrides[k];
    return prof; // 覆盖版本不入缓存，避免污染
  }
  cache[id] = prof;
  return prof;
}

/** 清空缓存（测试用） */
export function resetCache(): void {
  cache = {};
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/* ══ 故障机理模型 ══════════════════════════════════
   每个函数返回一个无量纲的「负载/风险」值，1.0 = 该机制的报警阈值。
   所有输入都是仿真过程中真实存在的量，没有任何概率抽样。 */

export interface HotendState {
  nozzleTarget: number;
  nozzleNow: number;
  materialNominalC: number;
  flowMm3s: number;
  materialFlowMm3s: number;
  extrudedMm3: number;
}

/**
 * 热端挤出阻力。返回值 1.0 = 报警阈值，持续超过即判堵料。
 * 标定原则（重要）：磨损本身不制造故障，它只让机器易感。
 */
export function hotendLoad(prof: MachineProfile, s: HotendState): number {
  const base = 0.3 + prof.hotendFouling * 0.3;

  const tempDef = Math.max(0, s.nozzleTarget - s.nozzleNow); // 够不到设定值
  const below = Math.max(0, s.materialNominalC - s.nozzleNow); // 设定值本身就偏低
  const tempFactor = 1 + Math.pow(Math.max(tempDef, below) / 10, 1.6) * 0.42;

  const flowRatio = s.flowMm3s / Math.max(1e-6, s.materialFlowMm3s);
  const flowFactor = 1 + Math.max(0, flowRatio - 1) * 0.85;

  const progressive = 1 + (s.extrudedMm3 / 250000) * prof.hotendFouling;

  return base * tempFactor * flowFactor * progressive;
}

export interface FeedState {
  flowMm3s: number;
  materialFlowMm3s: number;
  spoolRemainFrac: number;
}

/**
 * 送料侧打滑风险。返回值 1.0 = 报警阈值，持续超过即判断料。
 */
export function feedSlipRisk(prof: MachineProfile, s: FeedState): number {
  const base = 0.3 + (1 - prof.feederGrip) * 0.9 + prof.spoolDrag * 0.35;

  const flowRatio = s.flowMm3s / Math.max(1e-6, s.materialFlowMm3s);
  const demand = 1 + Math.max(0, flowRatio - 0.6) * 0.5;

  // 料盘越空，料卷半径越小、弯折半径越小，抽料阻力越大（真实现象）
  const nearEmpty = 1 + Math.max(0, 1 - s.spoolRemainFrac / 0.15) * 0.6;

  return base * demand * nearEmpty;
}

/**
 * 加热器能达到的稳态上限。健康度低的加热器够不到高温材料的目标温度，
 * 持续偏差会被既有的热失控监测器发现——这就是「热失控」的涌现路径。
 */
export function heaterCeilingC(prof: MachineProfile, ambientC?: number | null): number {
  const amb = ambientC == null ? 26 : ambientC;
  return amb + (300 - amb) * prof.heaterHealth;
}

export interface WarpState {
  bedMinC: number;
  bedNow: number;
  shrinkage: number;
  firstLayerAreaMm2: number;
  firstLayerUnevenMm: number;
  fanFrac: number;
}

/**
 * 翘边风险（打印结束时评估，>1 判为翘边报废）。
 * 真实成因：床温不足、环境冷/有风、材料收缩率高、大平面、首层不均。
 */
export function warpRisk(prof: MachineProfile, s: WarpState): number {
  const bedDef = Math.max(0, s.bedMinC - s.bedNow); // 床温低于材料下限多少度
  // 指数放缓：床温差 12°C 时约为 1.0，差 35°C 时约为 4——判废结论不变，
  // 但风险指数落在可读区间，报告里给出的数字才有比较意义。
  const bedTerm = Math.pow(bedDef / 12, 1.35);

  // 环境：开放式机器 + 低室温 + 有风，对高收缩材料是致命组合
  const coldness = Math.max(0, 28 - prof.ambientC) / 20;
  const envTerm = (coldness + prof.draft * 0.7) * s.shrinkage * (prof.enclosed ? 0.45 : 1);

  // 大平面翘得厉害：用首层面积的等效半径衡量
  const sizeTerm = Math.min(1.4, Math.sqrt(Math.max(0, s.firstLayerAreaMm2) / 3600));

  // 首层不均 → 附着面积不足
  const adhesion = Math.min(1.2, s.firstLayerUnevenMm / 0.18);

  // 高风扇对 ABS 是雪上加霜，对 PLA 无害
  const fanTerm = s.fanFrac * s.shrinkage * 0.55;

  const risk = (bedTerm + envTerm * 1.25 + fanTerm) * (0.55 + sizeTerm * 0.45) * (1 + adhesion * 0.35);
  return Math.min(risk, 5); // 封顶：超过这个量级只是「必然翘边」的不同说法，无需继续放大
}

export interface OverhangState {
  needSupport: boolean;
  supportEnabled: boolean;
  fanFrac: number;
  layerHeightMm: number;
  speedMmS: number;
}

/**
 * 悬垂塌陷风险（打印结束时评估，>1 判为塌陷报废）。
 * 无支撑的大悬垂是确定性失败；有支撑时看冷却是否跟得上。
 */
export function overhangRisk(_prof: MachineProfile, s: OverhangState): number {
  if (!s.needSupport) return 0;
  if (!s.supportEnabled) return 2.0; // 需要支撑却不开 → 必然塌陷，不是概率问题
  // 有支撑：冷却不足 + 层高大 + 速度快 → 桥接段下垂
  const cooling = Math.max(0, 0.75 - s.fanFrac) * 1.6;
  const layerTerm = Math.max(0, s.layerHeightMm - 0.2) * 2.2;
  const speedTerm = Math.max(0, s.speedMmS / 200 - 0.6) * 0.8;
  return cooling + layerTerm + speedTerm;
}

/** 材料收缩倾向（翘边模型输入）。数量级参考各材料典型收缩率。 */
export const SHRINKAGE: Record<string, number> = { PLA: 0.25, PETG: 0.45, ABS: 1.0, TPU: 0.35 };
/** 各材料的「舒适体积流量」上限（mm³/s），超过即熔不透 */
export const FLOW_MM3S: Record<string, number> = { PLA: 11, PETG: 9, ABS: 10, TPU: 3.5 };
