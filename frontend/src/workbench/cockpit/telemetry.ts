import { useEffect, useState } from "react";
import { legacyUtil, type LegacySim, type SimState } from "../../legacy/engine";

/** 与旧 UI 循环同频：240ms 一次低频文本刷新，页面隐藏时跳过。 */
const SAMPLE_INTERVAL_MS = 240;
/** 进度环周长，r=41 → 2πr。数值沿用旧实现，保证描边推进完全一致。 */
const RING_CIRCUMFERENCE = 257.6;
const DEFAULT_TEMPERATURE_C = 26;
const DEFAULT_BED_SIZE_MM = 256;

const REMAIN_STATES: readonly SimState[] = ["print", "heat", "level", "pause", "fault"];
const ETA_STATES: readonly SimState[] = ["print", "heat", "level"];

export interface Telemetry {
  readonly progress: number;
  readonly ringDashOffset: string;
  readonly layerText: string;
  readonly elapsedText: string;
  readonly remainText: string;
  readonly etaText: string;
  readonly nozzleText: string;
  readonly bedText: string;
  readonly spoolRemainText: string;
  readonly spoolBarWidth: string;
  readonly spoolUsedText: string;
  readonly motorWidth: string;
  readonly mcuWidth: string;
  readonly powerText: string;
  readonly action: string;
  readonly coordsText: string;
}

export const IDLE_TELEMETRY: Telemetry = {
  progress: 0,
  ringDashOffset: RING_CIRCUMFERENCE.toFixed(1),
  layerText: "— / —",
  elapsedText: "00:00:00",
  remainText: "—",
  etaText: "—",
  nozzleText: "—",
  bedText: "—",
  spoolRemainText: "1000 g",
  spoolBarWidth: "100%",
  spoolUsedText: "已用 0.00 m · 0.0 g",
  motorWidth: "0%",
  mcuWidth: "0%",
  powerText: "45 W",
  action: "待机",
  coordsText: "X — · Y — · Z —",
};

function layerText(sim: LegacySim): string {
  const slice = sim.slice;
  if (!slice) return "— / —";
  if (sim.state === "idle") return `— / ${slice.totalLayers}`;
  return `${Math.min(sim.layerIdx + 1, slice.totalLayers)} / ${slice.totalLayers}`;
}

function currentLayerZ(sim: LegacySim): number {
  const slice = sim.slice;
  if (!slice || sim.state === "idle" || sim.layerIdx >= slice.totalLayers) return 0;
  return slice.layers[Math.min(sim.layerIdx, slice.totalLayers - 1)]?.z ?? 0;
}

/* 负载读数带随机抖动，与旧实现一致：这是仿真的展示噪声，不是测量值。 */
function sampleLoad(sim: LegacySim): { motor: number; mcu: number; heatW: number } {
  const printing = sim.state === "print";
  const motor = printing
    ? 42 + (sim.settings.speed / 300) * 40 + Math.random() * 6
    : sim.state === "level" || sim.state === "heat"
      ? 25
      : 4;
  const mcu = 18 + (printing ? 26 : 6) + Math.random() * 5;
  const nozzleHeat =
    sim.nozzleT.target > 50 ? 42 * (1 - Math.min(1, Math.abs(sim.nozzleNow - sim.nozzleT.target) < 4 ? 0.5 : 0)) : 0;
  const bedHeat = sim.bedT.target > 40 ? (sim.bedNow < sim.bedT.target - 4 ? 210 : 65) : 0;
  return { motor, mcu, heatW: nozzleHeat + bedHeat };
}

export function readTelemetry(sim: LegacySim): Telemetry {
  const { fmtDuration, fmtClockAfter } = legacyUtil();
  const remaining = sim.estimateRemaining();
  const spoolRemainG = Math.max(0, sim.spoolTotalG - sim.usedG);
  const { motor, mcu, heatW } = sampleLoad(sim);
  const halfBed = (sim.printer.BED_SIZE ?? DEFAULT_BED_SIZE_MM) / 2;

  return {
    progress: sim.progress,
    ringDashOffset: (RING_CIRCUMFERENCE * (1 - sim.progress)).toFixed(1),
    layerText: layerText(sim),
    elapsedText: fmtDuration(sim.machineElapsed),
    remainText: REMAIN_STATES.includes(sim.state)
      ? fmtDuration(remaining)
      : sim.slice
        ? fmtDuration(sim.estimateTotal())
        : "—",
    etaText: ETA_STATES.includes(sim.state) ? fmtClockAfter(remaining / sim.simMult) : "—",
    nozzleText: `${(sim.nozzleNow || DEFAULT_TEMPERATURE_C).toFixed(0)}°/${sim.nozzleT.target.toFixed(0)}°`,
    bedText: `${(sim.bedNow || DEFAULT_TEMPERATURE_C).toFixed(0)}°/${sim.bedT.target.toFixed(0)}°`,
    spoolRemainText: `${spoolRemainG.toFixed(0)} g`,
    spoolBarWidth: `${((spoolRemainG / sim.spoolTotalG) * 100).toFixed(1)}%`,
    spoolUsedText: `已用 ${(sim.usedLenMm / 1000).toFixed(2)} m · ${sim.usedG.toFixed(1)} g`,
    motorWidth: `${Math.min(100, motor).toFixed(0)}%`,
    mcuWidth: `${Math.min(100, mcu).toFixed(0)}%`,
    powerText: `${Math.round(38 + heatW + motor * 1.4)} W`,
    action: sim.currentAction,
    coordsText: `X ${(sim.headPos.x + halfBed).toFixed(1)} · Y ${(sim.headPos.y + halfBed).toFixed(1)} · Z ${currentLayerZ(sim).toFixed(2)}`,
  };
}

export function useTelemetry(sim: LegacySim | null): Telemetry {
  const [telemetry, setTelemetry] = useState<Telemetry>(IDLE_TELEMETRY);

  useEffect(() => {
    if (!sim) return;
    const sample = () => {
      if (document.hidden) return;
      setTelemetry(readTelemetry(sim));
    };
    sample();
    const timer = window.setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [sim]);

  return telemetry;
}
