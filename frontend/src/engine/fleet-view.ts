/* FORGE·X — 机群视图：把分析结论映射到 3D 空间里的具体机台。
   自 js/fleet-view.js 机械迁移：逻辑逐行保留，THREE 改由 npm 包引入（r152 同版）。

   设计取舍：
   - 不渲染 N 台完整打印机。机群用低模机柜表示，细节模型只保留给当前选中的那一台。
   - 颜色编码承载统计信息：色相由失败率决定，而不透明度由置信区间宽度决定——
     区间越宽（证据越弱）越透明。「1 单 1 失败 = 100% 故障率」的机台会显示为
     一个几乎透明的幽灵，一眼就能看出它不该被当真。
   - 纯几何/配色逻辑抽成可测函数（layout / statusOf），THREE 相关的部分只做装配。 */
import * as THREE from "three";

/* ══ 可测的纯逻辑 ══════════════════════════ */

/** 机柜尺寸与间距（世界单位，与打印机模型同一量级） */
export const CELL = 340;
export const BOX = { w: 210, h: 260, d: 210 };

export interface FleetCellPos {
  x: number;
  z: number;
  row: number;
  col: number;
}

/**
 * 机群网格布局：尽量接近正方形，行优先，整体居中于原点。
 */
export function layout(n: number): FleetCellPos[] {
  if (!(n > 0)) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out: FleetCellPos[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    // 最后一行不满时居中摆放，避免整体重心偏移
    const inRow = Math.min(cols, n - r * cols);
    const offset = ((cols - inRow) * CELL) / 2;
    out.push({
      x: (c - (cols - 1) / 2) * CELL + offset,
      z: (r - (rows - 1) / 2) * CELL,
      row: r,
      col: c,
    });
  }
  return out;
}

/** 状态色阶（失败率 → 色相）。绿 → 琥珀 → 红。 */
export const PALETTE = [
  { max: 0.05, hex: 0x2ca878, label: "良好" },
  { max: 0.12, hex: 0x8cb84a, label: "正常" },
  { max: 0.2, hex: 0xe59a3a, label: "偏高" },
  { max: 1.01, hex: 0xe0484d, label: "偏高严重" },
];

export interface FleetStatus {
  hex: number;
  opacity: number;
  label: string;
  trustworthy: boolean;
}

export interface FleetGroupStat {
  rate: number;
  ci?: { lo: number; hi: number } | null;
  n: number;
  significant?: boolean;
}

/**
 * 由统计结果推出机台的视觉状态。
 * 关键点：不透明度由证据强度决定。置信区间越宽的机台越透明——
 * 视觉上就是「这台看不清」，与统计上的「证据不足」对应。
 */
export function statusOf(g: FleetGroupStat | null | undefined): FleetStatus {
  if (!g || !(g.n > 0)) {
    return { hex: 0x8d97a8, opacity: 0.22, label: "无数据", trustworthy: false };
  }
  let hex = PALETTE[PALETTE.length - 1]!.hex;
  let label = PALETTE[PALETTE.length - 1]!.label;
  for (let i = 0; i < PALETTE.length; i++) {
    if (g.rate < PALETTE[i]!.max) {
      hex = PALETTE[i]!.hex;
      label = PALETTE[i]!.label;
      break;
    }
  }
  // 区间宽度 0 → 完全不透明；宽度 ≥0.6（几乎没信息）→ 接近透明
  const width = g.ci ? Math.max(0, Math.min(1, g.ci.hi - g.ci.lo)) : 1;
  const opacity = Math.max(0.2, 1 - width * 1.35);
  return {
    hex,
    opacity,
    label: label + (g.significant ? "（显著）" : width > 0.35 ? "（证据不足）" : ""),
    trustworthy: width <= 0.35,
  };
}

export interface FleetMachineEntry {
  id: string;
  rate: number;
  hint: string;
  status: FleetStatus;
  highlighted: boolean;
}

export interface ChartItemLike {
  label: string;
  value: number;
  hint?: string;
  weak?: boolean;
  ciLo?: number;
  ciHi?: number;
}

/**
 * 从分析报告的图表数据构造机群条目。
 * chart.items 已带 ciLo/ciHi/weak，正是这里需要的。
 */
export function fromChartItems(
  items: ChartItemLike[] | null | undefined,
  highlightId?: string | null
): FleetMachineEntry[] {
  return (items || []).map((it) => {
    const g: FleetGroupStat = {
      rate: it.value,
      n: it.weak ? 1 : 99, // weak 已表示样本不足，具体 n 不影响配色
      ci: { lo: it.ciLo != null ? it.ciLo : 0, hi: it.ciHi != null ? it.ciHi : 1 },
      significant: false,
    };
    const st = statusOf(g);
    return {
      id: it.label,
      rate: it.value,
      hint: it.hint || "",
      status: st,
      highlighted: it.label === highlightId,
    };
  });
}

/* ══ THREE 装配 ════════════════════════════ */

interface CabinetEntry {
  group: THREE.Group;
  box: THREE.Mesh;
  led: THREE.Mesh;
  ledMat: THREE.MeshBasicMaterial;
  machine: FleetMachineEntry;
  highlighted?: boolean;
}

/**
 * 机群视图。挂到 FXScene 上，与详细打印机模型互斥显示。
 */
export class View {
  scene: THREE.Scene;
  group: THREE.Group;
  entries: CabinetEntry[];
  highlightId?: string;
  private _t: number;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);
    this.entries = [];
    this._t = 0;
  }

  build(machines: FleetMachineEntry[]): this {
    this.clear();
    const pos = layout(machines.length);
    for (let i = 0; i < machines.length; i++) {
      const m = machines[i]!;
      const cell = this._buildCabinet(m, pos[i]!);
      this.group.add(cell.group);
      this.entries.push(cell);
    }
    return this;
  }

  private _buildCabinet(m: FleetMachineEntry, p: FleetCellPos): CabinetEntry {
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);

    // 机柜本体：半透明，透明度承载证据强度
    const mat = new THREE.MeshStandardMaterial({
      color: m.status.hex,
      transparent: true,
      opacity: m.status.opacity * 0.55,
      roughness: 0.45,
      metalness: 0.1,
      depthWrite: false,
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(BOX.w, BOX.h, BOX.d), mat);
    box.position.y = BOX.h / 2;
    g.add(box);

    // 线框边：即使很透明也能看清轮廓与位置
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(BOX.w, BOX.h, BOX.d)),
      new THREE.LineBasicMaterial({
        color: m.status.hex,
        transparent: true,
        opacity: Math.min(1, m.status.opacity + 0.25),
      })
    );
    edges.position.y = BOX.h / 2;
    g.add(edges);

    // 状态灯：被高亮的机台会呼吸闪烁
    const ledMat = new THREE.MeshBasicMaterial({ color: m.status.hex });
    const led = new THREE.Mesh(new THREE.SphereGeometry(11, 16, 12), ledMat);
    led.position.set(0, BOX.h + 26, 0);
    g.add(led);

    // 标签：机台编号 + 失败率，画在贴图上（不引入字体依赖）
    const label = this._makeLabel(m);
    label.position.set(0, BOX.h + 74, 0);
    g.add(label);

    return { group: g, box, led, ledMat, machine: m };
  }

  /** 用 canvas 贴图做文字标签：不引入字体加载，也不受 file:// 限制 */
  private _makeLabel(m: FleetMachineEntry): THREE.Sprite {
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 160;
    const c = cv.getContext("2d")!;
    c.clearRect(0, 0, 512, 160);
    c.fillStyle = "rgba(20,24,31,0.82)";
    if (c.roundRect) {
      c.beginPath();
      c.roundRect(6, 6, 500, 148, 18);
      c.fill();
    } else {
      c.fillRect(6, 6, 500, 148);
    }

    c.textAlign = "center";
    c.fillStyle = "#eef1f6";
    c.font = "700 54px Consolas, monospace";
    c.fillText(m.id, 256, 66);
    c.fillStyle = "#" + m.status.hex.toString(16).padStart(6, "0");
    c.font = "600 40px 'Segoe UI', sans-serif";
    c.fillText((m.rate * 100).toFixed(1) + "%  " + m.status.label, 256, 122);

    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(230, 72, 1);
    return spr;
  }

  /** 高亮某台机器：呼吸灯 + 抬升，便于在一堆机柜里一眼找到 */
  highlight(id: string): this {
    this.highlightId = id;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      e.highlighted = e.machine.id === id;
      e.group.position.y = e.highlighted ? 26 : 0;
    }
    return this;
  }

  /** 每帧更新（呼吸动画）。由 FXScene 的 tick 调用。 */
  tick(dt: number): void {
    if (!this.group.visible) return;
    this._t += dt;
    const pulse = 0.55 + 0.45 * Math.sin(this._t * 3.2);
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      e.ledMat.opacity = e.highlighted ? pulse : 1;
      e.ledMat.transparent = !!e.highlighted;
      e.led.scale.setScalar(e.highlighted ? 1 + pulse * 0.35 : 1);
    }
  }

  show(on: boolean): this {
    this.group.visible = !!on;
    return this;
  }

  /** 相机应当看向哪里：整个机群，或某一台 */
  focusTarget(id?: string | null): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const e = id ? this.entries.filter((x) => x.machine.id === id)[0] : undefined;
    if (e) {
      return {
        pos: new THREE.Vector3(e.group.position.x + 260, 300, e.group.position.z + 420),
        target: new THREE.Vector3(e.group.position.x, BOX.h / 2, e.group.position.z),
      };
    }
    const span = Math.max(1, Math.ceil(Math.sqrt(this.entries.length))) * CELL;
    return {
      pos: new THREE.Vector3(span * 0.55, span * 0.75, span * 0.95),
      target: new THREE.Vector3(0, BOX.h / 2, 0),
    };
  }

  clear(): this {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      this.group.remove(e.group);
      e.group.traverse((o) => {
        const obj = o as THREE.Mesh & { material?: THREE.Material & { map?: THREE.Texture | null } };
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      });
    }
    this.entries = [];
    return this;
  }
}
