import type { LegacySim, LegacyUi, SimState } from "../../legacy/engine";
import { canPause, canStart, canStop, isResuming, pauseTitle } from "./sim-presentation";
import type { Telemetry } from "./telemetry";

interface DockProps {
  readonly sim: LegacySim | null;
  readonly ui: LegacyUi | null;
  readonly state: SimState;
  readonly telemetry: Telemetry;
  readonly monitorOpen: boolean;
  onToggleMonitor(): void;
}

export function Dock({ sim, ui, state, telemetry, monitorOpen, onToggleMonitor }: DockProps) {
  const resuming = isResuming(state);

  const requestStop = () => {
    if (!sim) return;
    const confirmStop = () => sim.stop();
    if (ui)
      ui.confirmAction("确认停止当前任务？", "打印进程将中止，平台复位，已成形部分将被清除（模拟）。", confirmStop);
    else confirmStop();
  };

  return (
    <footer id="dock" className="pill-card boot-item">
      <div className="ring-wrap" title="打印进度">
        <svg viewBox="0 0 96 96" className="ring">
          <defs>
            <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#f0561a" />
              <stop offset="100%" stopColor="#ff8a52" />
            </linearGradient>
          </defs>
          <circle className="ring-bg" cx="48" cy="48" r="41" />
          <circle
            className="ring-fg"
            id="ring-fg"
            cx="48"
            cy="48"
            r="41"
            style={{ strokeDashoffset: telemetry.ringDashOffset }}
          />
        </svg>
        <div className="ring-center">
          <div className="ring-val mono" id="ring-val">
            {Math.round(telemetry.progress * 100)}
            <span>%</span>
          </div>
          <div className="ring-lab" id="ring-lab" hidden>
            就绪
          </div>
        </div>
      </div>

      <button
        className="btn btn-primary"
        id="btn-start"
        type="button"
        disabled={!canStart(state)}
        onClick={() => sim?.start()}
      >
        <span className="bi bi-play" />
        {state === "done" ? "再次打印" : "开始打印"}
      </button>
      <button
        className="dock-icon"
        id="btn-pause"
        type="button"
        disabled={!canPause(state)}
        title={pauseTitle(state)}
        onClick={() => (resuming ? sim?.resume() : sim?.pause())}
      >
        <span className={`bi ${resuming ? "bi-play" : "bi-pause"}`} />
      </button>
      <button
        className="dock-icon danger"
        id="btn-stop"
        type="button"
        disabled={!canStop(state)}
        title="停止"
        onClick={requestStop}
      >
        <span className="bi bi-stop" />
      </button>

      <span className="dock-sep" />

      <div className="dock-stat">
        <span className="ds-lab">层</span>
        <b className="mono" id="stat-layer">
          {telemetry.layerText}
        </b>
      </div>
      <div className="dock-stat">
        <span className="ds-lab">剩余</span>
        <b className="mono" id="stat-remain">
          {telemetry.remainText}
        </b>
      </div>
      <div className="dock-stat hide-sm">
        <span className="ds-lab dot-noz">喷嘴</span>
        <b className="mono" id="noz-now">
          {telemetry.nozzleText}
        </b>
      </div>
      <div className="dock-stat hide-sm">
        <span className="ds-lab dot-bed">热床</span>
        <b className="mono" id="bed-now">
          {telemetry.bedText}
        </b>
      </div>

      <span className="dock-sep" />

      <button
        className={monitorOpen ? "dock-icon on" : "dock-icon"}
        id="btn-monitor"
        title="监控详情"
        onClick={onToggleMonitor}
      >
        <span className="bi bi-wave" />
      </button>
    </footer>
  );
}
