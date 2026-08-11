// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useProfileSelection } from "./useProfileSelection";

function communityBundle() {
  return {
    format: "forgex-profile-bundle",
    version: 1,
    machines: [
      {
        id: "hook-machine-300",
        name: "Hook Machine 300",
        tag: "HOOK-300",
        kinematics: "corexy",
        description: "Hook test machine",
        buildVolume: { x: 300, y: 280, z: 310 },
        enclosed: true,
        source: "Vitest hook fixture",
      },
    ],
    materials: [
      {
        id: "hook-material",
        name: "Hook Material",
        nozzle: { default: 250, min: 240, max: 265 },
        bed: { default: 80, min: 70 },
        fan: 40,
        densityG: 1.42,
        maxSpeed: 100,
        flowMm3s: 7,
        shrinkage: 0.5,
        priceCnyKg: 100,
        source: "Vitest hook fixture",
      },
    ],
  };
}

describe("useProfileSelection", () => {
  beforeEach(() => localStorage.clear());

  it("starts at the behavior-compatible corexy and PLA defaults", () => {
    const { result, unmount } = renderHook(() => useProfileSelection());
    expect(result.current.value).toMatchObject({
      selection: { machineId: "corexy", materialId: "PLA" },
      options: { bedSize: 256, densityG: 1.24, origin: "corner" },
      dirty: false,
    });
    unmount();
  });

  it("derives Delta and material options, preserves manual overrides and restores them", () => {
    const { result, unmount } = renderHook(() => useProfileSelection());
    act(() => result.current.actions.selectMachine("delta"));
    act(() => result.current.actions.selectMaterial("PETG"));
    expect(result.current.value.options).toEqual({ bedSize: 260, densityG: 1.27, origin: "center" });
    expect(result.current.value.dirty).toBe(false);

    act(() => result.current.actions.setBedSize("275"));
    expect(result.current.value.options).toEqual({ bedSize: 275, densityG: 1.27, origin: "center" });
    expect(result.current.value.dirty).toBe(true);

    act(() => result.current.actions.restoreProfileOptions());
    expect(result.current.value.options).toEqual({ bedSize: 260, densityG: 1.27, origin: "center" });
    expect(result.current.value.dirty).toBe(false);
    unmount();
  });

  it("returns no parse options while a manual draft is invalid", () => {
    const { result, unmount } = renderHook(() => useProfileSelection());
    act(() => result.current.actions.setDensityG("9"));
    expect(result.current.value.options).toBeNull();
    expect(result.current.value.errors.densityG).toContain("0.2–5");
    expect(result.current.value.dirty).toBe(true);
    unmount();
  });

  it("imports a local bundle, refreshes the catalog and keeps the active selection", async () => {
    const { result, unmount } = renderHook(() => useProfileSelection());
    const original = result.current.value.selection;
    const file = new File([JSON.stringify(communityBundle())], "hook-profile.json", { type: "application/json" });

    await act(() => result.current.actions.importFile(file));

    expect(result.current.value.importStatus).toBe("success");
    expect(result.current.value.importMessage).toContain("1 个机型 · 1 种材料");
    expect(result.current.value.catalog.machines.some((profile) => profile.id === "hook-machine-300")).toBe(true);
    expect(result.current.value.catalog.materials.some((profile) => profile.id === "hook-material")).toBe(true);
    expect(result.current.value.selection).toEqual(original);
    unmount();
  });
});
