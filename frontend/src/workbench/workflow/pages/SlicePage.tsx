import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import {
  legacyUtil,
  type LegacyEventBus,
  type LegacySim,
  type SliceLayer,
  type ToolpathType,
} from "../../../legacy/engine";

/* 与旧 _ctx_slice 相同的路径配色：2D 画布 / 3D 视口各一套。 */
const PATH_COLORS_2D: Readonly<Record<ToolpathType, string>> = {
  perimeter: "#eef1f6",
  solid: "#ff6a2b",
  infill: "#7c8698",
  support: "#4f83e0",
  skirt: "#4a5261",
};
const PATH_COLORS_3D: Readonly<Record<ToolpathType, number>> = {
  perimeter: 0xeef1f6,
  solid: 0xff6a2b,
  infill: 0x7c8698,
  support: 0x4f83e0,
  skirt: 0x4a5261,
};
/* 图例展示色沿用旧实现：周界图例刻意用比画布路径更柔和的灰。 */
const LEGEND: ReadonlyArray<readonly [string, string]> = [
  ["周界", "#aeb6c4"],
  ["实心", "#ff6a2b"],
  ["填充", "#7c8698"],
  ["支撑", "#4f83e0"],
  ["裙边", "#4a5261"],
];

const CANVAS_SIZE = 480;
const BED_MARGIN = 24;
const DEFAULT_BED_SIZE_MM = 256;

/** 逐层 2D 俯视绘制，逻辑与旧实现逐行对应：网格底纹 → 打印床边框 → 分型着色路径。 */
function drawLayer(canvas: HTMLCanvasElement, layer: SliceLayer, bedSizeMm: number): void {
  const c = canvas.getContext("2d");
  if (!c) return;
  c.fillStyle = "#2c323e";
  c.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  c.strokeStyle = "rgba(196,210,232,0.06)";
  c.lineWidth = 1;
  for (let g = BED_MARGIN; g < CANVAS_SIZE; g += 54) {
    c.beginPath();
    c.moveTo(g, 0);
    c.lineTo(g, CANVAS_SIZE);
    c.stroke();
    c.beginPath();
    c.moveTo(0, g);
    c.lineTo(CANVAS_SIZE, g);
    c.stroke();
  }
  c.strokeStyle = "rgba(238,241,246,0.22)";
  c.lineWidth = 1.5;
  c.strokeRect(BED_MARGIN, BED_MARGIN, CANVAS_SIZE - 2 * BED_MARGIN, CANVAS_SIZE - 2 * BED_MARGIN);

  const scale = (CANVAS_SIZE - 2 * BED_MARGIN) / bedSizeMm;
  const toX = (x: number) => CANVAS_SIZE / 2 + x * scale;
  const toY = (y: number) => CANVAS_SIZE / 2 - y * scale;
  for (const path of layer.paths) {
    c.strokeStyle = PATH_COLORS_2D[path.type] ?? "#888";
    c.lineWidth = path.type === "perimeter" ? 1.7 : 1.1;
    c.globalAlpha = path.type === "support" ? 0.75 : 1;
    c.beginPath();
    path.pts.forEach((q, i) => (i ? c.lineTo(toX(q.x), toY(q.y)) : c.moveTo(toX(q.x), toY(q.y))));
    c.stroke();
  }
  c.globalAlpha = 1;
}

interface SlicePageProps {
  readonly sim: LegacySim;
  readonly bus: LegacyEventBus;
}

export function SlicePage({ sim, bus }: SlicePageProps) {
  const { clamp, fmtHuman } = legacyUtil();
  /* 重新切片后 slice 引用整体更换，靠版本号驱动重渲染（旧实现靠整页重建）。 */
  const [, bumpSliceVersion] = useReducer((version: number) => version + 1, 0);
  const [layerNo, setLayerNo] = useState(() => Math.max(1, Math.min(sim.slice?.totalLayers ?? 1, sim.layerIdx + 1)));
  const [link3d, setLink3d] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const slice = sim.slice;
  const total = slice?.totalLayers ?? 1;
  const layerIndex = clamp(layerNo - 1, 0, total - 1);
  const layer = slice?.layers[layerIndex] ?? null;

  useEffect(() => {
    return bus.on("sliced", () => {
      bumpSliceVersion();
      setLayerNo(Math.max(1, Math.min(sim.slice?.totalLayers ?? 1, sim.layerIdx + 1)));
    });
  }, [bus, sim]);

  // 打印推进时预览层跟随当前层（挂载即处于切片页，无需再判断 currentNav）
  useEffect(() => {
    return bus.on("layer", (payload) => {
      const idx = Number((payload as { idx?: number })?.idx);
      if (Number.isFinite(idx)) setLayerNo(idx);
    });
  }, [bus]);

  useEffect(() => {
    if (canvasRef.current && layer) drawLayer(canvasRef.current, layer, sim.printer.BED_SIZE ?? DEFAULT_BED_SIZE_MM);
  }, [layer, sim]);

  useEffect(() => {
    if (!layer) return;
    if (link3d) sim.printer.showSlicePreview(layer, PATH_COLORS_3D);
    else sim.printer.hideSlicePreview();
  }, [layer, link3d, sim]);

  // 切页 / 收起面板即清掉视口中的路径预览，与旧 disposer 一致
  useEffect(() => () => sim.printer.hideSlicePreview(), [sim]);

  if (!slice || !layer) return <div className="note">请先在「模型」中载入模型。</div>;

  const fillPercent = ((layerIndex / Math.max(1, total - 1)) * 100).toFixed(1);

  return (
    <>
      <div className="sec-label">逐层路径预览</div>
      <div className="layer-canvas-wrap">
        <canvas ref={canvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE} />
        <div className="lc-tag mono">{`LAYER ${layerIndex + 1} · Z ${layer.z.toFixed(2)} mm · ${layer.paths.length} paths`}</div>
      </div>

      <div className="prow">
        <span className="p-lab">预览层</span>
        <input
          className="range"
          type="range"
          min={1}
          max={total}
          step={1}
          value={Math.min(layerNo, total)}
          style={{ "--fill": `${fillPercent}%` } as CSSProperties}
          onChange={(event) => setLayerNo(Number(event.target.value))}
        />
        <span className="p-val mono">
          {layerIndex + 1}
          <small>/{total}</small>
        </span>
      </div>

      <div className="legend-row">
        {LEGEND.map(([label, color]) => (
          <span key={label}>
            <i style={{ background: color }} />
            {label}
          </span>
        ))}
        <label className="mini-check" title="在 3D 视口中按真实切片数据绘制当前预览层的挤出路径">
          <input type="checkbox" checked={link3d} onChange={(event) => setLink3d(event.target.checked)} />
          <span>3D 视口联动</span>
        </label>
      </div>

      <div className="sec-label">切片统计</div>
      <div>
        <div className="kv">
          <span className="k">总层数</span>
          <span className="v hl">{total}</span>
        </div>
        <div className="kv">
          <span className="k">层高</span>
          <span className="v">{sim.settings.layerHeight.toFixed(2)} mm</span>
        </div>
        <div className="kv">
          <span className="k">挤出路径总长</span>
          <span className="v">{(slice.stats.extLenMm / 1000).toFixed(1)} m</span>
        </div>
        <div className="kv">
          <span className="k">空驶总长</span>
          <span className="v">{(slice.stats.travelMm / 1000).toFixed(1)} m</span>
        </div>
        <div className="kv">
          <span className="k">材料体积</span>
          <span className="v">{slice.stats.volumeCm3.toFixed(1)} cm³</span>
        </div>
        <div className="kv">
          <span className="k">预估时长</span>
          <span className="v hl">{fmtHuman(sim.estimateTotal())}</span>
        </div>
      </div>

      {sim.model?.needSupport && !sim.settings.supportEnabled ? (
        <div className="note">⚠ 该模型存在 &gt;60° 悬垂面，当前未启用支撑，顶部法兰将无法成形。</div>
      ) : null}
    </>
  );
}
