import type { QuickSimulationInput, QuickSimulationResult } from "../features/simulator/simulator-types";

export const legacyQuickSimulator: {
  simulate(input: QuickSimulationInput): QuickSimulationResult;
};
