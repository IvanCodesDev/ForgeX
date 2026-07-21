/* FORGE·X — 通用工具库（无三方依赖，可在 node 中直接冒烟测试） */
(function (root) {
  "use strict";

  const U = {};

  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.deg2rad = (d) => (d * Math.PI) / 180;

  /** 秒 → HH:MM:SS */
  U.fmtDuration = function (sec) {
    if (!isFinite(sec) || sec < 0) return "—";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, "0");
    return `${p(h)}:${p(m)}:${p(s)}`;
  };

  /** 秒 → 人性化「2 小时 18 分」 */
  U.fmtHuman = function (sec) {
    if (!isFinite(sec) || sec < 0) return "—";
    sec = Math.round(sec);
    if (sec < 60) return sec + " 秒";
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    if (h <= 0) return m + " 分钟";
    return `${h} 小时 ${String(m).padStart(2, "0")} 分`;
  };

  /** 当前墙钟 + 偏移秒 → HH:MM */
  U.fmtClockAfter = function (sec) {
    if (!isFinite(sec) || sec < 0) return "—";
    const d = new Date(Date.now() + sec * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  U.nowHMS = function () {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  U.fmt = function (v, digits) {
    if (!isFinite(v)) return "—";
    return v.toFixed(digits == null ? 1 : digits);
  };

  /** 轻量事件总线 */
  U.EventBus = class {
    constructor() { this._m = new Map(); }
    on(ev, fn) {
      if (!this._m.has(ev)) this._m.set(ev, new Set());
      this._m.get(ev).add(fn);
      return () => this._m.get(ev).delete(fn);
    }
    emit(ev, data) {
      const s = this._m.get(ev);
      if (s) for (const fn of s) { try { fn(data); } catch (e) { console.error("[bus]", ev, e); } }
    }
  };

  /** 确定性伪随机（可复现的调平网格等） */
  U.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /** 2D 值噪声（平滑），用于热床调平网格与表面扰动 */
  U.valueNoise2D = function (seed) {
    const rnd = U.mulberry32(seed);
    const g = {};
    const at = (ix, iy) => {
      const k = ix + "_" + iy;
      if (!(k in g)) g[k] = rnd();
      return g[k];
    };
    const fade = (t) => t * t * (3 - 2 * t);
    return function (x, y) {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = fade(x - ix), fy = fade(y - iy);
      const a = U.lerp(at(ix, iy), at(ix + 1, iy), fx);
      const b = U.lerp(at(ix, iy + 1), at(ix + 1, iy + 1), fx);
      return U.lerp(a, b, fy);
    };
  };

  /** 一阶热惯性模拟：向目标温度收敛，带过冲与噪声 */
  U.ThermalSim = class {
    constructor(ambient, tau, overshoot) {
      this.ambient = ambient;
      this.value = ambient;
      this.target = ambient;
      this.tau = tau;               // 时间常数（秒）
      this.overshoot = overshoot;   // 过冲幅度（°C）
      this._phase = Math.random() * 10;
      this._osLeft = 0;             // 剩余过冲能量
      this._lastTarget = ambient;
    }
    setTarget(t) {
      if (t > this._lastTarget + 5) this._osLeft = this.overshoot; // 大幅升温才有过冲
      this._lastTarget = t;
      this.target = t;
    }
    step(dt) {
      // heaterBroken：加热器失效（故障演练注入的物理扰动）——目标不变，实际温度向室温跌落，
      // 由 sim 的热失控监测器按「实际 vs 目标」偏差自行发现，检测链路真实
      const goal = this.heaterBroken ? this.ambient : Math.max(this.target, this.ambient);
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
    reached(tol) { return Math.abs(this.value - this.target) <= (tol || 2); }
  };

  /** HTML 转义（日志/文件名等不可信文本） */
  U.esc = function (s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  };

  /** DOM 快捷方式 */
  U.$ = (sel, el) => (el || document).querySelector(sel);
  U.$$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  U.el = function (tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  /** 多边形面积（鞋带公式，mm²），带符号 */
  U.polyArea = function (pts) {
    let s = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  };

  /** 多边形质心 */
  U.polyCentroid = function (pts) {
    let cx = 0, cy = 0, s = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const cr = a.x * b.y - b.x * a.y;
      s += cr; cx += (a.x + b.x) * cr; cy += (a.y + b.y) * cr;
    }
    if (Math.abs(s) < 1e-9) { // 退化为均值
      for (const p of pts) { cx += p.x; cy += p.y; }
      return { x: cx / pts.length, y: cy / pts.length };
    }
    s *= 3;
    return { x: cx / s, y: cy / s };
  };

  /** 折线总长 */
  U.pathLen = function (pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      L += Math.hypot(dx, dy);
    }
    return L;
  };

  root.FXU = U;
})(typeof window !== "undefined" ? window : globalThis);
