import { describe, expect, it } from "vitest";
import { legacyQuickSimulator } from "../../legacy/simulator-adapter.js";
import { standardSimulationInput } from "./simulator-test-fixtures";

describe("legacy quick simulator adapter", () => {
  it("matches the Stage 0 gear/standard golden without exposing layers", () => {
    const result = legacyQuickSimulator.simulate(standardSimulationInput());
    expect(result.authority).toEqual({
      kind: "instant-preview",
      authoritative: false,
      label: "浏览器即时预览（非权威）",
    });
    expect(result.engine).toMatchObject({ source: "legacy-js-adapter", version: "legacy-js-preview/1" });
    expect(result.input).toMatchObject({
      modelId: "gear",
      machineProfile: { id: "corexy" },
      materialProfile: { id: "PLA" },
      settings: { layerHeight: 0.2, infillDensity: 0.18, speed: 120 },
    });
    expect(result.summary.totalLayers).toBe(80);
    expect(result.summary.pathCount).toBe(2781);
    expect(result.summary.heightMm).toBe(16);
    expect(result.summary.extrusionLengthMm).toBeCloseTo(92052.26526, 6);
    expect(result.summary.travelLengthMm).toBeCloseTo(25280.717698, 6);
    expect(result.summary.pathTimeSeconds).toBeCloseTo(1515.673755, 6);
    expect(result.summary.estimatedTimeSeconds).toBeCloseTo(1610.673755, 6);
    expect(result.summary.volumeCm3).toBeCloseTo(8.284704, 6);
    expect(result.summary.filamentLengthM).toBeCloseTo(3.44438, 6);
    expect(result.summary.filamentMassG).toBeCloseTo(10.273033, 6);
    expect(result.summary.materialCostCny).toBeCloseTo(0.708839, 6);
    expect(result.quality).toHaveLength(6);
    expect(result.evidence[0]).toMatchObject({ code: "FIXED_PROCESS_OVERHEAD", value: 95, unit: "s" });
    expect(result).not.toHaveProperty("layers");
  });

  it("keeps parameter sensitivity visible in the preview", () => {
    const standard = legacyQuickSimulator.simulate(standardSimulationInput());
    const coarse = legacyQuickSimulator.simulate(standardSimulationInput({ layerHeight: 0.28 }));
    const dense = legacyQuickSimulator.simulate(standardSimulationInput({ infillDensity: 0.45 }));
    const fast = legacyQuickSimulator.simulate(standardSimulationInput({ speed: 220 }));
    expect(coarse.summary.totalLayers).toBeLessThan(standard.summary.totalLayers);
    expect(dense.summary.filamentMassG).toBeGreaterThan(standard.summary.filamentMassG);
    expect(fast.summary.pathTimeSeconds).toBeLessThan(standard.summary.pathTimeSeconds);
  });

  it("uses the submitted community material density and price without leaking it globally", () => {
    const input = standardSimulationInput({ material: "custom-pla" });
    const custom = {
      ...input,
      material: {
        ...input.material,
        id: "custom-pla",
        densityG: 1.5,
        priceCnyKg: 200,
        community: true,
      },
    };
    const result = legacyQuickSimulator.simulate(custom);
    expect(result.profiles.materialId).toBe("custom-pla");
    expect(result.summary.filamentMassG).toBeCloseTo(result.summary.volumeCm3 * 1.5, 6);
    expect(result.summary.materialCostCny).toBeCloseTo((result.summary.filamentMassG * 200) / 1000, 6);
  });
});
