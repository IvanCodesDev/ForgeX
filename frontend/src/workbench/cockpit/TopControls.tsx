import { useState } from "react";
import type { LegacyScene, LegacySim, LegacyUi, SimState } from "../../legacy/engine";
import { STATE_LABEL, STATE_TONE } from "./sim-presentation";

/* 全屏 API 前缀兼容：Chromium <71 / 老 Safari 仅有 webkit 前缀版本（口径与旧 ui.js 一致）。 */
function toggleFullscreen(ui: LegacyUi | null): void {
  const doc = document as Document & {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void> | void;
  };
  const rootEl = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  const swallow = (value: Promise<void> | void) => {
    if (value && typeof (value as Promise<void>).catch === "function") (value as Promise<void>).catch(() => {});
  };
  const active = doc.fullscreenElement ?? doc.webkitFullscreenElement;
  if (active) {
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    if (exit) {
      try {
        swallow(exit.call(doc));
      } catch {
        /* 忽略 */
      }
    }
    return;
  }
  const request = rootEl.requestFullscreen ?? rootEl.webkitRequestFullscreen;
  if (request) {
    try {
      swallow(request.call(rootEl));
    } catch {
      /* 忽略 */
    }
  } else {
    ui?.toast("当前浏览器不支持网页全屏", "warn");
  }
}

export function FullscreenButton({ ui }: { readonly ui: LegacyUi | null }) {
  return (
    <button className="icon-btn pill-card" id="btn-fullscreen" title="全屏" onClick={() => toggleFullscreen(ui)} />
  );
}

const SPEED_OPTIONS = [1, 2, 4, 8] as const;
const DEFAULT_SPEED_MULTIPLIER = 4;

const CAMERA_PRESETS = [
  { id: "overview", label: "总览" },
  { id: "nozzle", label: "喷头" },
  { id: "top", label: "俯视" },
] as const;

export function StatusPill({ state }: { readonly state: SimState }) {
  return (
    <div className={`status-pill pill-card st-${STATE_TONE[state]}`} id="status-pill">
      <span className="sp-dot" />
      <span className="sp-text">{STATE_LABEL[state]}</span>
    </div>
  );
}

interface SpeedControlProps {
  readonly sim: LegacySim | null;
  readonly ui: LegacyUi | null;
}

export function SpeedControl({ sim, ui }: SpeedControlProps) {
  const [multiplier, setMultiplier] = useState<number>(DEFAULT_SPEED_MULTIPLIER);

  const select = (value: number) => {
    setMultiplier(value);
    if (sim) sim.simMult = value;
    ui?.toast(`仿真时间倍率 ${value}×`, "info");
  };

  return (
    <div className="seg-ctrl pill-card" id="speed-seg" title="仿真时间倍率">
      {SPEED_OPTIONS.map((value) => (
        <button
          key={value}
          type="button"
          data-v={value}
          className={value === multiplier ? "on" : undefined}
          onClick={() => select(value)}
        >
          {value}×
        </button>
      ))}
    </div>
  );
}

export function CameraControl({ fx }: { readonly fx: LegacyScene | null }) {
  const [preset, setPreset] = useState<string>(CAMERA_PRESETS[0].id);

  const select = (id: string) => {
    setPreset(id);
    fx?.setCameraPreset(id);
  };

  return (
    <div className="seg-ctrl pill-card" id="hud-cam">
      {CAMERA_PRESETS.map((item) => (
        <button
          key={item.id}
          type="button"
          data-v={item.id}
          className={item.id === preset ? "on" : undefined}
          onClick={() => select(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
