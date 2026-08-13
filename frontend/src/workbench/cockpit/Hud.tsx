import type { LegacyScene } from "../../legacy/engine";
import { CameraControl } from "./TopControls";
import type { Telemetry } from "./telemetry";

interface HudProps {
  readonly fx: LegacyScene | null;
  readonly telemetry: Telemetry;
  readonly fleetOn: boolean;
  onExitFleet(): void;
}

export function Hud({ fx, telemetry, fleetOn, onExitFleet }: HudProps) {
  return (
    <div id="hud">
      <div className="hud-corner boot-item">
        <CameraControl fx={fx} />
      </div>
      <button className="btn btn-ghost hud-exit" id="fleet-exit" hidden={!fleetOn} onClick={onExitFleet}>
        ← 退出机群视图
      </button>
      <div className="hud-info mono boot-item">
        <span id="hud-action">{telemetry.action}</span>
        <i />
        <span id="hud-coords">{telemetry.coordsText}</span>
      </div>
    </div>
  );
}
