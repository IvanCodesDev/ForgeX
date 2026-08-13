/* FORGE·X — 统计核（纯逻辑；不得引用 DOM 或 THREE）。
   自 js/stats-kernel.js 机械迁移：算法逐行保留，仅换模块壳并加类型。

   这个模块存在的理由：让「A 比 B 差」这句话有依据。
     - 比例给 Wilson 置信区间（小样本下比正态近似可靠得多）
     - 两组比较用 Fisher 精确检验（不依赖大样本近似，2×2 下是精确的）
     - 相关性支持控制混杂变量的偏相关（组内中心化，等价于 ANCOVA 口径）
     - 趋势用 Mann-Kendall（非参数，不假设线性、不受异常值支配）
   诚实性约定：所有近似都在注释里写明适用范围。 */

/** 参与排名/比较所需的最小样本量。低于此值只展示、不下结论。 */
export const MIN_SAMPLE = 5;

/** 显著性水平（双侧） */
export const ALPHA = 0.05;

export interface WilsonInterval {
  p: number;
  lo: number;
  hi: number;
  n: number;
  k: number;
  width: number;
}

export interface FisherResult {
  pValue: number;
  oddsRatio: number | null;
  a: number;
  b: number;
  c: number;
  d: number;
  n: number;
}

export interface RankedGroup {
  key: string;
  k: number;
  n: number;
  rate: number;
  ci: WilsonInterval;
  vsRest: { k: number; n: number; rate: number };
  pValue: number;
  oddsRatio: number | null;
  significant: boolean;
}

export interface SkippedGroup {
  key: string;
  k: number;
  n: number;
  ci: WilsonInterval;
  reason: string;
}

export interface PearsonResult {
  r: number;
  n: number;
  ci95: [number, number] | null;
  pValue: number;
  significant: boolean;
  method: string;
  groups?: number;
  dropped?: number;
  controls?: string[];
}

export interface MannKendallResult {
  n: number;
  S: number;
  tau: number;
  z: number;
  pValue: number;
  direction: "up" | "down" | "flat";
  significant: boolean;
  method?: string;
}

/* ══ 数值基础 ══════════════════════════════ */

/** 标准正态 CDF。Abramowitz-Stegun 7.1.26 的 erf 近似，绝对误差 < 1.5e-7。 */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/** lnΓ(x)，Lanczos 近似（g=7, n=9）。相对误差 < 1e-13，n 上万也稳。 */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function lnGamma(x: number): number {
  if (x < 0.5) {
    // 反射公式，避免小参数下的精度损失
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  x -= 1;
  let a = LANCZOS[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** ln C(n, k)。用 lnΓ 而非阶乘连乘，n 大时不会溢出。 */
export function lnChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
}

/* ══ 比例的置信区间 ════════════════════════ */

/**
 * Wilson score 区间。
 * 正态近似在 p̂ 接近 0 或 1 时会给出超出 [0,1] 的荒谬区间，0 次失败时区间宽度为 0——
 * 相当于宣称「这台机器绝不会坏」。Wilson 区间在这两种情形下都表现正常。
 */
export function wilson(k: number, n: number, conf?: number | null): WilsonInterval {
  if (!(n > 0)) return { p: 0, lo: 0, hi: 1, n: 0, k: 0, width: 1 };
  const z = zFor(conf == null ? 0.95 : conf);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lo = Math.max(0, center - margin);
  const hi = Math.min(1, center + margin);
  return { p, lo, hi, n, k, width: hi - lo };
}

function zFor(conf: number): number {
  // 常用置信度直接查表，避免实现分位数反函数
  if (conf >= 0.99) return 2.5758293035489004;
  if (conf >= 0.98) return 2.3263478740408408;
  if (conf >= 0.95) return 1.959963984540054;
  if (conf >= 0.9) return 1.6448536269514722;
  return 1.959963984540054;
}

/* ══ 两组比例的比较 ════════════════════════ */

/**
 * Fisher 精确检验（2×2，双侧）。
 * 卡方依赖大样本近似，任一格期望频数 <5 时不可靠——而「某台机器只跑了 8 单、
 * 失败 3 次」正是最常遇到的情形。Fisher 在固定边缘和下枚举全部可能表格。
 * 双侧 p 值口径：所有「出现概率不高于观测表」的表格概率之和（Fisher/Irwin 约定）。
 */
export function fisherExact(a: number, b: number, c: number, d: number): FisherResult {
  a = a | 0;
  b = b | 0;
  c = c | 0;
  d = d | 0;
  const n = a + b + c + d;
  if (n <= 0) return { pValue: 1, oddsRatio: null, a, b, c, d, n: 0 };

  // 固定边缘和：r1/r2 为行和，c1 为第一列和（第二列和由总数推出，无需单独变量）
  const r1 = a + b,
    r2 = c + d,
    c1 = a + c;
  const lnDen = lnChoose(n, c1);
  const pObs = Math.exp(lnChoose(r1, a) + lnChoose(r2, c) - lnDen);

  const lo = Math.max(0, c1 - r2);
  const hi = Math.min(r1, c1);
  let p = 0;
  const EPS = 1e-7;
  for (let x = lo; x <= hi; x++) {
    const px = Math.exp(lnChoose(r1, x) + lnChoose(r2, c1 - x) - lnDen);
    if (px <= pObs * (1 + EPS)) p += px;
  }
  // Haldane-Anscombe 修正：任一格为 0 时 OR 会退化为 0/∞，加 0.5 使其可比
  const or_ = b * c === 0 || a * d === 0 ? ((a + 0.5) * (d + 0.5)) / ((b + 0.5) * (c + 0.5)) : (a * d) / (b * c);

  return { pValue: Math.min(1, p), oddsRatio: or_, a, b, c, d, n };
}

/**
 * 比较两组的失败率：给出各自的 Wilson 区间、差值、以及 Fisher 检验的 p 值。
 */
export function compareRates(
  kA: number,
  nA: number,
  kB: number,
  nB: number,
  opt?: { minSample?: number | null; alpha?: number | null }
) {
  opt = opt || {};
  const minN = opt.minSample == null ? MIN_SAMPLE : opt.minSample;
  const A = wilson(kA, nA),
    B = wilson(kB, nB);
  const f = fisherExact(kA, nA - kA, kB, nB - kB);
  const enough = nA >= minN && nB >= minN;
  return {
    a: A,
    b: B,
    diff: A.p - B.p,
    pValue: f.pValue,
    oddsRatio: f.oddsRatio,
    // 样本量不足时不给显著性结论——p 值算得出来不等于结论可用
    significant: enough && f.pValue < (opt.alpha == null ? ALPHA : opt.alpha),
    enough,
  };
}

/* ══ 分组排名（带证据） ════════════════════ */

/**
 * 按失败率对分组排名，每组带 Wilson 区间，并与「其余各组合并」做 Fisher 检验。
 * 「与其余合并比较」而不是「与总体比较」：后者把被检验组自己也算进对照，
 * 会稀释差异，是常见的统计误用。
 */
export function rankByRate(
  groups: ReadonlyArray<{ key: string; k: number; n: number }>,
  opt?: { minSample?: number | null; alpha?: number | null }
) {
  opt = opt || {};
  const minN = opt.minSample == null ? MIN_SAMPLE : opt.minSample;
  const alpha = opt.alpha == null ? ALPHA : opt.alpha;

  let totalK = 0,
    totalN = 0;
  for (let i = 0; i < groups.length; i++) {
    totalK += groups[i]!.k;
    totalN += groups[i]!.n;
  }

  const ranked: RankedGroup[] = [];
  const skipped: SkippedGroup[] = [];
  for (let j = 0; j < groups.length; j++) {
    const g = groups[j]!;
    const ci = wilson(g.k, g.n);
    if (g.n < minN) {
      skipped.push({ key: g.key, k: g.k, n: g.n, ci, reason: "样本量 " + g.n + " < " + minN });
      continue;
    }
    // 该组 vs 其余各组合并
    const restK = totalK - g.k,
      restN = totalN - g.n;
    const f: Pick<FisherResult, "pValue" | "oddsRatio"> =
      restN > 0 ? fisherExact(g.k, g.n - g.k, restK, restN - restK) : { pValue: 1, oddsRatio: null };
    ranked.push({
      key: g.key,
      k: g.k,
      n: g.n,
      rate: ci.p,
      ci,
      vsRest: { k: restK, n: restN, rate: restN ? restK / restN : 0 },
      pValue: f.pValue,
      oddsRatio: f.oddsRatio,
      significant: restN >= minN && f.pValue < alpha,
    });
  }
  ranked.sort((a, b) => b.rate - a.rate || b.n - a.n);

  // 「最差」必须同时满足：排第一 + 与其余组的差异统计显著
  const worst = ranked.length && ranked[0]!.significant ? ranked[0]! : null;
  return {
    ranked,
    skipped,
    worst,
    minSample: minN,
    alpha,
    fleet: { k: totalK, n: totalN, rate: totalN ? totalK / totalN : 0 },
  };
}

/* ══ 相关性 ════════════════════════════════ */

/**
 * Pearson 相关系数 + 置信区间 + p 值。
 * 区间与 p 值用 Fisher z 变换（atanh）后的正态近似。
 * 适用范围：n ≳ 10 且二元分布近似正态时可靠；本项目样本量通常在百级，满足。
 */
export function pearson(
  pairs: ReadonlyArray<readonly [number, number]>,
  opt?: { df?: number | null; alpha?: number | null }
): PearsonResult | null {
  opt = opt || {};
  const n = pairs.length;
  if (n < 4) return null; // n<4 时 Fisher z 的 se 无意义
  let sx = 0,
    sy = 0;
  for (let i = 0; i < n; i++) {
    sx += pairs[i]![0];
    sy += pairs[i]![1];
  }
  const mx = sx / n,
    my = sy / n;
  let num = 0,
    dx = 0,
    dy = 0;
  for (let j = 0; j < n; j++) {
    const a = pairs[j]![0] - mx,
      b = pairs[j]![1] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  let r = den < 1e-12 ? 0 : num / den;
  r = Math.max(-0.9999999, Math.min(0.9999999, r));

  const df = opt.df == null ? n - 3 : opt.df; // 偏相关时调用方传入扣除控制变量后的 df
  let ci95: [number, number] | null = null;
  let pValue = 1;
  if (df > 0) {
    const z = Math.atanh(r);
    const se = 1 / Math.sqrt(df);
    ci95 = [Math.tanh(z - 1.959963984540054 * se), Math.tanh(z + 1.959963984540054 * se)];
    pValue = 2 * (1 - normalCdf(Math.abs(z) / se));
  }
  return {
    r,
    n,
    ci95,
    pValue,
    significant: ci95 != null && pValue < (opt.alpha == null ? ALPHA : opt.alpha),
    method: "pearson + fisher-z 正态近似",
  };
}

/**
 * 控制分类混杂变量后的偏相关（组内中心化，等价于 ANCOVA 口径）。
 * 直接算「层高 vs 打印时长」的相关会把材料差异混进去；控制材料与模型后，
 * 比较的才是同类活里层高的影响。df = n - g - 2（g 为有效组数）。
 */
export function partialCorrelation(
  rows: ReadonlyArray<Record<string, unknown>>,
  xKey: string,
  yKey: string,
  controlKeys?: ReadonlyArray<string>
): PearsonResult | null {
  controlKeys = controlKeys || [];
  const buckets: Record<string, Array<[number, number]>> = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const x = Number(row[xKey]),
      y = Number(row[yKey]);
    if (!isFinite(x) || !isFinite(y)) continue;
    let key = "";
    for (let c = 0; c < controlKeys.length; c++) key += "" + String(row[controlKeys[c]!]);
    (buckets[key] = buckets[key] || []).push([x, y]);
  }

  const resid: Array<[number, number]> = [];
  let groups = 0,
    dropped = 0;
  for (const k in buckets) {
    const g = buckets[k]!;
    // 组内只有 1 个样本时中心化后恒为 0，不携带任何信息，直接丢弃
    if (g.length < 2) {
      dropped += g.length;
      continue;
    }
    groups++;
    let sx = 0,
      sy = 0;
    for (let a = 0; a < g.length; a++) {
      sx += g[a]![0];
      sy += g[a]![1];
    }
    const mx = sx / g.length,
      my = sy / g.length;
    for (let b = 0; b < g.length; b++) resid.push([g[b]![0] - mx, g[b]![1] - my]);
  }
  if (resid.length < 4 || groups < 1) return null;

  const df = resid.length - groups - 2;
  if (df <= 0) return null;
  const out = pearson(resid, { df });
  if (!out) return null;
  out.groups = groups;
  out.dropped = dropped;
  out.controls = controlKeys.slice();
  out.method = "组内中心化偏相关（控制：" + (controlKeys.join("、") || "无") + "）+ fisher-z 近似";
  return out;
}

/* ══ 趋势 ══════════════════════════════════ */

/**
 * Mann-Kendall 趋势检验（含并列值修正）。
 * 回归假设线性且对异常值敏感；MK 是非参数的，只看两两先后的大小关系。
 */
export function mannKendall(series: ReadonlyArray<number>, opt?: { alpha?: number | null }): MannKendallResult | null {
  opt = opt || {};
  const n = series.length;
  if (n < 4) return null;

  let Sstat = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = series[j]! - series[i]!;
      Sstat += d > 0 ? 1 : d < 0 ? -1 : 0;
    }
  }

  // 并列值修正：同值的组会降低方差
  const counts: Record<string, number> = {};
  for (let t = 0; t < n; t++) counts[series[t]!] = (counts[series[t]!] || 0) + 1;
  let tieTerm = 0;
  for (const v in counts) {
    const c = counts[v]!;
    if (c > 1) tieTerm += c * (c - 1) * (2 * c + 5);
  }
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  if (varS <= 0) {
    return { n, S: Sstat, tau: 0, z: 0, pValue: 1, direction: "flat", significant: false };
  }

  // 连续性修正
  const z = Sstat > 0 ? (Sstat - 1) / Math.sqrt(varS) : Sstat < 0 ? (Sstat + 1) / Math.sqrt(varS) : 0;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  const tau = (2 * Sstat) / (n * (n - 1));
  const alpha = opt.alpha == null ? ALPHA : opt.alpha;
  const sig = pValue < alpha;
  return {
    n,
    S: Sstat,
    tau,
    z,
    pValue,
    direction: !sig ? "flat" : Sstat > 0 ? "up" : "down",
    significant: sig,
    method: "Mann-Kendall 非参数趋势检验（正态近似 + 并列修正）",
  };
}

/* ══ 表述辅助 ══════════════════════════════ */

/** p 值 → 人类可读（不四舍五入成 0，避免造成「p=0」这种不存在的说法） */
export function fmtP(p: number | null | undefined): string {
  if (p == null || !isFinite(p)) return "—";
  if (p < 0.0001) return "p<0.0001";
  if (p < 0.001) return "p<0.001";
  return "p=" + p.toFixed(p < 0.01 ? 4 : 3);
}

/** 比例区间 → "24.0%（95%CI 15.6–34.9%）" */
export function fmtRateCi(ci: WilsonInterval): string {
  const pc = (x: number) => (x * 100).toFixed(1);
  return pc(ci.p) + "%（95%CI " + pc(ci.lo) + "–" + pc(ci.hi) + "%）";
}

/**
 * 相关强度的定性说法。只描述强度，不暗示因果——
 * 「负相关」是对数据的描述，「层高越大越快」是因果主张，两者不能混用。
 */
export function describeR(r: number): string {
  const a = Math.abs(r);
  const strength = a >= 0.7 ? "强" : a >= 0.4 ? "中等" : a >= 0.2 ? "弱" : "几乎无";
  if (a < 0.2) return "几乎无线性相关";
  return strength + (r < 0 ? "负" : "正") + "相关";
}

/**
 * 证据条目：报告里每条结论都应当能附上一条，说明「这个数是怎么来的」。
 */
export function evidence(
  claim: string,
  method: string,
  stat?: { n?: number | null; statistic?: number | null; ci95?: [number, number] | null; pValue?: number | null } | null
) {
  return {
    claim,
    method,
    n: stat && stat.n != null ? stat.n : null,
    statistic: stat && stat.statistic != null ? stat.statistic : null,
    ci95: stat && stat.ci95 ? stat.ci95 : null,
    pValue: stat && stat.pValue != null ? stat.pValue : null,
  };
}
