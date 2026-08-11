import { describe, expect, it } from "vitest";
import { validateQuickSimulationInput } from "./simulator-schema";
import { standardSimulationInput } from "./simulator-test-fixtures";

describe("quick simulation input boundary", () => {
  it("accepts the immutable legacy standard contract", () => {
    const result = validateQuickSimulationInput(standardSimulationInput());
    expect(result.ok).toBe(true);
  });

  it.each([
    ["NaN layer height", { settings: { layerHeight: Number.NaN } }],
    ["unknown model", { modelId: "unknown" }],
    ["non identity transform", { tf: { scale: 2, rotZ: 0, offX: 0, offY: 0 } }],
    ["unknown field", { extra: true }],
  ])("rejects %s without coercing it", (_name, patch) => {
    const input = standardSimulationInput() as unknown as Record<string, unknown>;
    const patchRecord = patch as Record<string, unknown> & { readonly settings?: object };
    const candidate = {
      ...input,
      ...patchRecord,
      settings: { ...(input.settings as Record<string, unknown>), ...(patchRecord.settings ?? {}) },
    };
    const result = validateQuickSimulationInput(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("requires the settings material to match the Profile snapshot", () => {
    const result = validateQuickSimulationInput(standardSimulationInput({ material: "PETG" }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors.join(" ")).toContain("必须与 input.material.id 一致");
  });
});
