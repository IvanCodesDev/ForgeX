import { useEffect, useState } from "react";
import type { LegacyEventBus, LegacySim, SimState } from "../../legacy/engine";

/** 仿真状态机由引擎推进，UI 只订阅 `state` 事件后回读，不自行推导状态。 */
export function useSimState(sim: LegacySim | null, bus: LegacyEventBus | null): SimState {
  const [state, setState] = useState<SimState>("idle");

  useEffect(() => {
    if (!sim || !bus) return;
    const sync = () => setState(sim.state);
    sync();
    return bus.on("state", sync);
  }, [sim, bus]);

  return state;
}
