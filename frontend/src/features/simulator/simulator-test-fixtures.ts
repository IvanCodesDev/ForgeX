import type { MachineProfile, MaterialProfile } from "../profiles/profile-types";
import { IDENTITY_SIMULATION_TRANSFORM, STANDARD_SIMULATION_SETTINGS } from "./simulator-schema";
import type { QuickSimulationInput } from "./simulator-types";

export const TEST_MACHINE: MachineProfile = Object.freeze({
  id: "corexy",
  name: "FX-256 睿造",
  tag: "FX-256",
  kinematics: "corexy",
  description: "CoreXY · 封闭腔体",
  buildVolume: { x: 256, y: 256, z: 256 },
  enclosed: true,
  source: "FORGE·X built-in profile",
  community: false,
});

export const TEST_MATERIAL: MaterialProfile = Object.freeze({
  id: "PLA",
  name: "PLA",
  nozzle: { default: 210, min: 195, max: 225 },
  bed: { default: 60, min: 55 },
  fan: 100,
  densityG: 1.24,
  maxSpeed: 300,
  flowMm3s: 11,
  shrinkage: 0.25,
  priceCnyKg: 69,
  source: "FORGE·X engineering baseline",
  community: false,
  nozzleTemp: 210,
  nozzleRange: [195, 225] as const,
  bedTemp: 60,
  bedMin: 55,
});

export function standardSimulationInput(changes: Partial<QuickSimulationInput["settings"]> = {}): QuickSimulationInput {
  return {
    modelId: "gear",
    machine: TEST_MACHINE,
    material: TEST_MATERIAL,
    settings: { ...STANDARD_SIMULATION_SETTINGS, ...changes },
    tf: IDENTITY_SIMULATION_TRANSFORM,
  };
}
