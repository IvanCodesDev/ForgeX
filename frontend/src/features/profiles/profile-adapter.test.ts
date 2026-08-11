// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  PROFILE_FILE_MAX_BYTES,
  ProfileImportError,
  deriveProfileOptions,
  importProfileBundle,
  importProfileFile,
  listProfileCatalog,
  validateProfileBundle,
  validateProfileOptionDraft,
} from "./profile-adapter";
import type { ProfileBundle } from "./profile-types";

function bundle(suffix: string): ProfileBundle {
  return {
    format: "forgex-profile-bundle",
    version: 1,
    machines: [
      {
        id: `test-corexy-${suffix}`,
        name: `Test CoreXY ${suffix}`,
        tag: `TEST-${suffix}`,
        kinematics: "corexy",
        description: "Rectangular test profile",
        buildVolume: { x: 300, y: 250, z: 320 },
        enclosed: true,
        source: "Vitest fixture",
      },
    ],
    materials: [
      {
        id: `test-material-${suffix}`,
        name: `Test Material ${suffix}`,
        nozzle: { default: 260, min: 250, max: 275 },
        bed: { default: 90, min: 80 },
        fan: 30,
        densityG: 1.36,
        maxSpeed: 120,
        flowMm3s: 8,
        shrinkage: 0.6,
        priceCnyKg: 120,
        source: "Vitest fixture",
      },
    ],
  };
}

describe("profile adapter", () => {
  beforeEach(() => localStorage.clear());

  it("exposes cloned built-ins and maps their authoritative preview inputs", () => {
    const catalog = listProfileCatalog();
    const machines = catalog.machines.filter((profile) => !profile.community);
    const materials = catalog.materials.filter((profile) => !profile.community);
    expect(machines).toHaveLength(4);
    expect(materials).toHaveLength(4);

    const corexy = machines.find((profile) => profile.id === "corexy");
    const delta = machines.find((profile) => profile.id === "delta");
    const pla = materials.find((profile) => profile.id === "PLA");
    const petg = materials.find((profile) => profile.id === "PETG");
    expect(corexy && pla ? deriveProfileOptions(corexy, pla) : null).toEqual({
      bedSize: 256,
      densityG: 1.24,
      origin: "corner",
      machineProfileId: "corexy",
      materialProfileId: "PLA",
    });
    expect(delta && petg ? deriveProfileOptions(delta, petg) : null).toEqual({
      bedSize: 260,
      densityG: 1.27,
      origin: "center",
      machineProfileId: "delta",
      materialProfileId: "PETG",
    });
    expect(Object.isFrozen(catalog.machines)).toBe(true);
    expect(Object.isFrozen(catalog.machines[0]?.buildVolume)).toBe(true);
  });

  it("returns stable validation errors for malformed arrays and unsafe fields", () => {
    expect(validateProfileBundle({ format: "forgex-profile-bundle", version: 1, machines: {}, materials: [] })).toEqual(
      { ok: false, errors: ["machines 必须是数组"] }
    );

    const unsafe = bundle("unsafe") as unknown as {
      machines: Array<Record<string, unknown>>;
      materials: Array<Record<string, unknown>>;
      format: string;
      version: number;
    };
    unsafe.materials[0]!.script = "alert(1)";
    const result = validateProfileBundle(unsafe);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("script"))).toBe(true);
  });

  it("validates manual overrides against the shared Profile range", () => {
    expect(validateProfileOptionDraft({ bedSize: "300", densityG: "1.18", origin: "corner" })).toEqual({
      ok: true,
      options: { bedSize: 300, densityG: 1.18, origin: "corner" },
      errors: {},
    });
    const invalid = validateProfileOptionDraft({ bedSize: "49", densityG: "NaN", origin: "center" });
    expect(invalid.ok).toBe(false);
    expect(invalid.options).toBeNull();
    expect(invalid.errors).toHaveProperty("bedSize");
    expect(invalid.errors).toHaveProperty("densityG");
  });

  it("rejects a built-in override before registering any earlier entry", () => {
    const attempted = bundle("atomic");
    const invalid: ProfileBundle = { ...attempted, materials: [{ ...attempted.materials[0]!, id: "PLA" }] };
    expect(() => importProfileBundle(invalid)).toThrowError(ProfileImportError);
    try {
      importProfileBundle(invalid);
    } catch (error) {
      expect(error).toMatchObject({ code: "BUILTIN_OVERRIDE" });
    }
    expect(listProfileCatalog().machines.some((profile) => profile.id === "test-corexy-atomic")).toBe(false);
  });

  it("imports, normalizes and persists a valid community bundle", () => {
    const imported = importProfileBundle(bundle("valid"));
    expect(imported).toMatchObject({ persisted: true });
    expect(imported.machines[0]).toMatchObject({ id: "test-corexy-valid", community: true });
    expect(imported.materials[0]).toMatchObject({
      id: "test-material-valid",
      community: true,
      nozzleTemp: 260,
      bedTemp: 90,
    });
    expect(localStorage.getItem("forgex-community-profiles-v1")).toContain("test-material-valid");
  });

  it("enforces extension, byte limit and JSON parsing before registry import", async () => {
    await expect(importProfileFile(new File(["{}"], "profile.txt"))).rejects.toMatchObject({
      code: "INVALID_EXTENSION",
    });

    const oversized = new File([], "profile.json");
    Object.defineProperty(oversized, "size", { value: PROFILE_FILE_MAX_BYTES + 1 });
    await expect(importProfileFile(oversized)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(importProfileFile(new File(["{"], "profile.json"))).rejects.toMatchObject({ code: "INVALID_JSON" });
  });
});
