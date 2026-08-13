/* FORGE·X — 通用工具库（无三方依赖）。
   自 js/util.js 机械迁移：算法逐行保留，仅换模块壳并加类型。 */

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const deg2rad = (d: number): number => (d * Math.PI) / 180;

/** 秒 → HH:MM:SS */
export function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "—";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/** 秒 → 人性化「2 小时 18 分」 */
export function fmtHuman(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "—";
  sec = Math.round(sec);
  if (sec < 60) return sec + " 秒";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h <= 0) return m + " 分钟";
  return `${h} 小时 ${String(m).padStart(2, "0")} 分`;
}

/** 当前墙钟 + 偏移秒 → HH:MM */
export function fmtClockAfter(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "—";
  const d = new Date(Date.now() + sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function nowHMS(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmt(v: number, digits?: number | null): string {
  if (!isFinite(v)) return "—";
  return v.toFixed(digits == null ? 1 : digits);
}

type BusHandler = (data?: unknown) => void;

/** 轻量事件总线 */
export class EventBus {
  private _m = new Map<string, Set<BusHandler>>();
  on(ev: string, fn: BusHandler): () => void {
    if (!this._m.has(ev)) this._m.set(ev, new Set());
    this._m.get(ev)!.add(fn);
    return () => this._m.get(ev)!.delete(fn);
  }
  emit(ev: string, data?: unknown): void {
    const s = this._m.get(ev);
    if (s)
      for (const fn of s) {
        try {
          fn(data);
        } catch (e) {
          console.error("[bus]", ev, e);
        }
      }
  }
}

/** 确定性伪随机（可复现的调平网格等） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D 值噪声（平滑），用于热床调平网格与表面扰动 */
export function valueNoise2D(seed: number): (x: number, y: number) => number {
  const rnd = mulberry32(seed);
  const g: Record<string, number> = {};
  const at = (ix: number, iy: number): number => {
    const k = ix + "_" + iy;
    if (!(k in g)) g[k] = rnd();
    return g[k]!;
  };
  const fade = (t: number) => t * t * (3 - 2 * t);
  return function (x: number, y: number) {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    const fx = fade(x - ix),
      fy = fade(y - iy);
    const a = lerp(at(ix, iy), at(ix + 1, iy), fx);
    const b = lerp(at(ix, iy + 1), at(ix + 1, iy + 1), fx);
    return lerp(a, b, fy);
  };
}

/** 一阶热惯性模拟：向目标温度收敛，带过冲与噪声 */
export class ThermalSim {
  ambient: number;
  value: number;
  target: number;
  tau: number;
  overshoot: number;
  /** 加热器失效（故障演练注入的物理扰动），由仿真器动态设置。 */
  heaterBroken?: boolean;
  /** 加热器能达到的稳态上限（机台加热器健康度决定），由仿真器动态设置。 */
  ceilingC?: number | null;
  private _phase: number;
  private _osLeft: number;
  private _lastTarget: number;

  /** phase：噪声相位。必须可指定且默认确定性——本模型是数据生成链的一环，
      用 Math.random 会让「同一台机器跑同样的活」得到不同结果，破坏数据集可复现性。
      不同热区传入不同相位即可解耦各自的噪声。 */
  constructor(ambient: number, tau: number, overshoot: number, phase?: number | null) {
    this.ambient = ambient;
    this.value = ambient;
    this.target = ambient;
    this.tau = tau; // 时间常数（秒）
    this.overshoot = overshoot; // 过冲幅度（°C）
    this._phase = phase == null ? 0 : phase;
    this._osLeft = 0; // 剩余过冲能量
    this._lastTarget = ambient;
  }
  setTarget(t: number): void {
    if (t > this._lastTarget + 5) this._osLeft = this.overshoot; // 大幅升温才有过冲
    this._lastTarget = t;
    this.target = t;
  }
  step(dt: number): number {
    // heaterBroken：目标不变，实际温度向室温跌落，由 sim 的热失控监测器按
    // 「实际 vs 目标」偏差自行发现，检测链路真实。
    // ceilingC：老化加热器功率不足够不到高温材料目标——持续偏差被同一监测器
    // 发现，这是「热失控」故障的涌现路径，不需要任何概率抽样。
    let goal = this.heaterBroken ? this.ambient : Math.max(this.target, this.ambient);
    if (!this.heaterBroken && this.ceilingC != null) goal = Math.min(goal, this.ceilingC);
    const k = 1 - Math.exp(-dt / this.tau);
    this.value += (goal - this.value) * k;
    // 到达目标附近时释放过冲
    if (this._osLeft > 0.05 && Math.abs(this.value - goal) < 3 && this.target > this.ambient) {
      this.value += this._osLeft * k * 2;
      this._osLeft *= Math.exp(-dt / 6);
    }
    this._phase += dt;
    const noise = (Math.sin(this._phase * 1.7) + Math.sin(this._phase * 3.1 + 1.3)) * 0.18;
    return this.value + (this.target > this.ambient ? noise : noise * 0.4);
  }
  reached(tol?: number): boolean {
    return Math.abs(this.value - this.target) <= (tol || 2);
  }
}

/** HTML 转义（日志/文件名等不可信文本） */
export function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

/** DOM 快捷方式（仅浏览器环境调用） */
export const $ = (sel: string, el?: ParentNode): Element | null => (el || document).querySelector(sel);
export const $$ = (sel: string, el?: ParentNode): Element[] => Array.from((el || document).querySelectorAll(sel));
export function el(tag: string, cls?: string, html?: string | null): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

/** 多边形面积（鞋带公式，mm²），带符号 */
export function polyArea(pts: readonly Point2[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i]!,
      b = pts[(i + 1) % n]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** 多边形质心 */
export function polyCentroid(pts: readonly Point2[]): Point2 {
  let cx = 0,
    cy = 0,
    s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i]!,
      b = pts[(i + 1) % n]!;
    const cr = a.x * b.y - b.x * a.y;
    s += cr;
    cx += (a.x + b.x) * cr;
    cy += (a.y + b.y) * cr;
  }
  if (Math.abs(s) < 1e-9) {
    // 退化为均值
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    return { x: cx / pts.length, y: cy / pts.length };
  }
  s *= 3;
  return { x: cx / s, y: cy / s };
}

/** 折线总长 */
export function pathLen(pts: readonly Point2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]!.x - pts[i - 1]!.x,
      dy = pts[i]!.y - pts[i - 1]!.y;
    L += Math.hypot(dx, dy);
  }
  return L;
}
