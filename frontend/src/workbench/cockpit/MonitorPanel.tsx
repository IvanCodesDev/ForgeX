import { useEffect, useReducer, useRef, useState } from "react";
import type { WorkbenchHandles } from "../useLegacyWorkbench";
import type { Overlays } from "../overlays/useOverlays";
import type { Telemetry } from "./telemetry";

/** 温度采样节奏与窗口沿用旧实现：600ms 一采，保留 150 点。 */
const SAMPLE_INTERVAL_MS = 600;
const SAMPLE_WINDOW = 150;

const FAULT_DRILLS = [
  ["runout", "断料", "料架传感器直报：耗材中断"],
  ["jam", "堵料", "挤出机负载异常直报"],
  ["thermal", "热失控", "物理注入：加热器失效 → 温度真实下跌 → 由热失控监测器凭实测偏差发现（约 3–10s）"],
] as const;

interface TemperatureSample {
  n: number;
  b: number;
  nt: number;
  bt: number;
}

/** 温度曲线绘制，与旧 _drawChart 逐行对应（DPR、刻度、目标虚线、双曲线与渐变填充）。 */
function drawChart(canvas: HTMLCanvasElement, data: ReadonlyArray<TemperatureSample>): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== w * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const c = canvas.getContext("2d");
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  let max = 80;
  for (const p of data) max = Math.max(max, p.n, p.b, p.nt, p.bt);
  max *= 1.15;
  const X = (i: number) => (i / (SAMPLE_WINDOW - 1)) * w;
  const Y = (v: number) => h - (v / max) * (h - 6) - 3;
  c.strokeStyle = "rgba(238,241,246,0.07)";
  c.lineWidth = 1;
  for (const t of [100, 200]) {
    if (t > max) continue;
    c.beginPath();
    c.moveTo(0, Y(t));
    c.lineTo(w, Y(t));
    c.stroke();
  }
  const last = data[data.length - 1];
  if (last) {
    c.setLineDash([4, 4]);
    if (last.nt > 30) {
      c.strokeStyle = "rgba(255,106,43,0.45)";
      c.beginPath();
      c.moveTo(0, Y(last.nt));
      c.lineTo(w, Y(last.nt));
      c.stroke();
    }
    if (last.bt > 30) {
      c.strokeStyle = "rgba(79,131,224,0.45)";
      c.beginPath();
      c.moveTo(0, Y(last.bt));
      c.lineTo(w, Y(last.bt));
      c.stroke();
    }
    c.setLineDash([]);
  }
  const off = SAMPLE_WINDOW - data.length;
  const grad = c.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(255,106,43,0.22)");
  grad.addColorStop(1, "rgba(255,106,43,0)");
  c.beginPath();
  data.forEach((p, i) => (i ? c.lineTo(X(off + i), Y(p.n)) : c.moveTo(X(off + i), Y(p.n))));
  c.strokeStyle = "#ff6a2b";
  c.lineWidth = 1.6;
  c.stroke();
  c.lineTo(X(SAMPLE_WINDOW - 1), h);
  c.lineTo(X(off), h);
  c.closePath();
  c.fillStyle = grad;
  c.fill();
  c.beginPath();
  data.forEach((p, i) => (i ? c.lineTo(X(off + i), Y(p.b)) : c.moveTo(X(off + i), Y(p.b))));
  c.strokeStyle = "#4f83e0";
  c.lineWidth = 1.4;
  c.stroke();
}

interface MonitorPanelProps {
  readonly telemetry: Telemetry;
  readonly handles: WorkbenchHandles | null;
  readonly overlays: Overlays;
}

export function MonitorPanel({ telemetry, handles, overlays }: MonitorPanelProps) {
  /* 日志数据源是启动引导里的常驻缓冲（不会错过装配期的启动日志），这里只订阅增量驱动重渲。 */
  const [, bumpLog] = useReducer((version: number) => version + 1, 0);
  const [autoscroll, setAutoscroll] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const samplesRef = useRef<TemperatureSample[]>([]);
  const open = overlays.monitor.open;
  const logs = handles?.logFeed.rows ?? [];

  useEffect(() => {
    if (!handles) return;
    return handles.bus.on("log", bumpLog);
  }, [handles]);

  // 温度采样常驻（与旧实现一致，与面板开合无关），绘制只在面板可见时进行
  useEffect(() => {
    if (!handles) return;
    const sim = handles.sim;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const samples = samplesRef.current;
      samples.push({
        n: sim.nozzleNow || 26,
        b: sim.bedNow || 26,
        nt: sim.nozzleT.target,
        bt: sim.bedT.target,
      });
      if (samples.length > SAMPLE_WINDOW) samples.shift();
      if (canvasRef.current && !canvasRef.current.closest("aside")?.hidden) {
        drawChart(canvasRef.current, samples);
      }
    }, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [handles]);

  useEffect(() => {
    if (autoscroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  });

  return (
    <aside id="monitor-pop" className={overlays.monitor.entering ? "float-card entering" : "float-card"} hidden={!open}>
      <header className="panel-head">
        <h2>实时监控</h2>
        <span className="ph-tag mono">
          <span id="stat-elapsed">{telemetry.elapsedText}</span> · 完成 <span id="stat-eta">{telemetry.etaText}</span>
        </span>
        <button className="close-btn" id="mon-close" title="收起面板" onClick={() => overlays.toggleMonitor()} />
      </header>
      <div className="panel-body mon-body">
        <div className="chart-head">
          <span className="ch-lab">温度曲线</span>
          <span className="ch-leg">
            <i className="dot dot-n" />
            喷嘴
          </span>
          <span className="ch-leg">
            <i className="dot dot-b" />
            热床
          </span>
        </div>
        <canvas id="chart-canvas" ref={canvasRef} />

        <div className="res-grid">
          <div className="res-block">
            <div className="rb-head">
              <span>耗材余量</span>
              <b className="mono" id="mat-grams">
                {telemetry.spoolRemainText}
              </b>
            </div>
            <div className="hbar">
              <div className="hbar-fill fill-ink" id="mat-bar" style={{ width: telemetry.spoolBarWidth }} />
            </div>
            <div className="rb-sub mono" id="mat-len">
              {telemetry.spoolUsedText}
            </div>
          </div>
          <div className="res-block">
            <div className="rb-head">
              <span>设备负载</span>
              <b className="mono" id="load-psu">
                {telemetry.powerText}
              </b>
            </div>
            <div className="load-row">
              <span>电机</span>
              <div className="hbar">
                <div className="hbar-fill fill-ink" id="load-motor" style={{ width: telemetry.motorWidth }} />
              </div>
            </div>
            <div className="load-row">
              <span>主控</span>
              <div className="hbar">
                <div className="hbar-fill fill-soft" id="load-mcu" style={{ width: telemetry.mcuWidth }} />
              </div>
            </div>
          </div>
        </div>

        <div className="log-head">
          <span className="ch-lab">事件日志</span>
          <label className="mini-check">
            <input
              type="checkbox"
              id="log-autoscroll"
              checked={autoscroll}
              onChange={(event) => setAutoscroll(event.target.checked)}
            />
            <span>自动滚动</span>
          </label>
          <button
            className="mini-btn"
            id="log-clear"
            onClick={() => {
              handles?.logFeed.clear();
              bumpLog();
            }}
          >
            清空
          </button>
        </div>
        <div className="log-list" id="log-list" ref={listRef}>
          {logs.map((row) => (
            <div key={row.id} className={`log-item lv-${row.lv}`}>
              <span className="lt">{row.time}</span>
              <span>{row.msg}</span>
            </div>
          ))}
        </div>

        <div className="log-head">
          <span className="ch-lab">故障演练</span>
        </div>
        <div className="chip-row">
          {FAULT_DRILLS.map(([kind, label, tip]) => (
            <div key={kind} className="chip sm" title={tip} onClick={() => handles?.sim.injectFault(kind)}>
              {label}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
