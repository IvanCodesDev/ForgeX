import { useEffect, useReducer, useRef } from "react";
import { legacyUtil, type LegacyEventBus, type LegacySim, type LevelMesh } from "../../../legacy/engine";
import { Slider } from "../../controls/Slider";

const CANVAS_W = 460;
const CANVAS_H = 300;
/** 热力图绘制常数，与旧实现一致：4×4 单元格、双线性放大分辨率 46。 */
const GRID_CELL_W = 380 / 4;
const GRID_CELL_H = 232 / 4;
const GRID_OFFSET_X = 40;
const GRID_OFFSET_Y = 20;
const UPSAMPLE_RES = 46;

/** 补偿网格热力图，逻辑与旧 draw() 的画布部分逐行对应。 */
function drawMesh(canvas: HTMLCanvasElement, mesh: LevelMesh | null): void {
  const { lerp, clamp } = legacyUtil();
  const c = canvas.getContext("2d");
  if (!c) return;
  c.fillStyle = "#2c323e";
  c.fillRect(0, 0, CANVAS_W, CANVAS_H);
  if (!mesh) {
    c.fillStyle = "#7c8698";
    c.font = "13px 'Segoe UI', sans-serif";
    c.textAlign = "center";
    c.fillText("尚未执行调平 — 运行后生成热力图", CANVAS_W / 2, 152);
    return;
  }
  const g = mesh.grid;
  for (let j = 0; j < UPSAMPLE_RES; j++) {
    for (let i = 0; i < UPSAMPLE_RES; i++) {
      const gx = (i / (UPSAMPLE_RES - 1)) * 4;
      const gy = (j / (UPSAMPLE_RES - 1)) * 4;
      const i0 = Math.min(3, Math.floor(gx));
      const j0 = Math.min(3, Math.floor(gy));
      const fx = gx - i0;
      const fy = gy - j0;
      const row0 = g[j0] ?? [];
      const row1 = g[j0 + 1] ?? [];
      const v = lerp(lerp(row0[i0] ?? 0, row0[i0 + 1] ?? 0, fx), lerp(row1[i0] ?? 0, row1[i0 + 1] ?? 0, fx), fy);
      const t = clamp((v + 0.15) / 0.3, 0, 1);
      const r = Math.round(lerp(38, 255, Math.max(0, t - 0.5) * 2));
      const b = Math.round(lerp(255, 40, Math.min(1, t * 2) * 0.9));
      const gg = Math.round(90 + Math.sin(t * Math.PI) * 90);
      c.fillStyle = `rgba(${r},${gg},${b},0.85)`;
      c.fillRect(
        GRID_OFFSET_X + (i / UPSAMPLE_RES) * 380,
        GRID_OFFSET_Y + (j / UPSAMPLE_RES) * 232,
        380 / UPSAMPLE_RES + 1,
        232 / UPSAMPLE_RES + 1
      );
    }
  }
  c.strokeStyle = "rgba(255,248,234,0.35)";
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < 5; i++) {
      c.strokeRect(GRID_OFFSET_X + i * GRID_CELL_W - 2, GRID_OFFSET_Y + j * GRID_CELL_H - 2, 4, 4);
      c.fillStyle = "rgba(255,248,234,0.9)";
      c.font = "9px Consolas";
      c.textAlign = "center";
      c.fillText((g[j]?.[i] ?? 0).toFixed(2), GRID_OFFSET_X + i * GRID_CELL_W, GRID_OFFSET_Y + j * GRID_CELL_H + 14);
    }
  }
}

interface CalibPageProps {
  readonly sim: LegacySim;
  readonly bus: LegacyEventBus;
}

export function CalibPage({ sim, bus }: CalibPageProps) {
  /* 调平结果与设置都活在引擎里，事件到达后 bump 驱动回读重渲。 */
  const [, bump] = useReducer((version: number) => version + 1, 0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => bus.on("levelmesh", bump), [bus]);
  useEffect(() => bus.on("settings", bump), [bus]);

  const mesh = sim.levelMesh;
  useEffect(() => {
    if (canvasRef.current) drawMesh(canvasRef.current, mesh);
  });

  const samples = mesh?.samples ?? [];

  return (
    <>
      <div className="sec-label">自动调平</div>
      <button className="btn btn-primary btn-block" type="button" onClick={() => sim.runLeveling()}>
        运行 3×3 自动调平
      </button>
      <div className="note">
        探针依次触碰平台 9 个采样点（实测本机床面误差场），9 点实测值拟合 5×5
        补偿网格；打印时按喷头位置在网格上双线性插值实时补偿 Z（首层全量、6mm
        内渐隐）。同一机台重复调平结果稳定一致，切换机型后需重新调平。
      </div>

      <div className="sec-label">补偿网格热力图</div>
      <div className="bedmesh-wrap">
        <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} />
      </div>
      <div>
        {mesh ? (
          <>
            <div className="kv">
              <span className="k">最大偏差</span>
              <span className={Math.abs(mesh.max) > 0.15 ? "v warn" : "v hl"}>
                {`${mesh.max >= 0 ? "+" : ""}${mesh.max.toFixed(3)} mm`}
              </span>
            </div>
            <div className="kv">
              <span className="k">探测样本</span>
              <span className="v mono" style={{ fontSize: "11px" }}>
                {samples.map((v) => (v >= 0 ? "+" : "") + v.toFixed(2)).join(" ")}
              </span>
            </div>
            <div className="kv">
              <span className="k">校准时间</span>
              <span className="v">{mesh.at.toLocaleTimeString()}</span>
            </div>
            <div className="kv">
              <span className="k">打印补偿</span>
              <span className="v hl">首层全量 · 6mm 内渐隐</span>
            </div>
          </>
        ) : null}
      </div>

      <div className="sec-label">Z 轴微调</div>
      <Slider
        label="Z 偏移"
        min={-0.3}
        max={0.3}
        step={0.01}
        unit="mm"
        dec={2}
        value={sim.settings.zOffset}
        onInput={(value) => {
          sim.updateSettings({ zOffset: value });
          bump();
        }}
      />
      <div className="note">负值使喷嘴贴近平台（增强附着），正值抬升喷嘴（防刮擦）。</div>
    </>
  );
}
