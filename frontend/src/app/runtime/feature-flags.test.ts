import { describe, expect, it } from "vitest";
import { readFeatureFlags } from "./feature-flags";

function env(value?: "0" | "1"): ImportMetaEnv {
  return {
    BASE_URL: "/",
    MODE: "test",
    DEV: false,
    PROD: false,
    SSR: false,
    ...(value === undefined ? {} : { VITE_REACT_GCODE_ENABLED: value }),
  };
}

describe("readFeatureFlags", () => {
  it("enables the migrated slice by default", () => {
    expect(readFeatureFlags(env()).gcodeReact).toBe(true);
  });

  it("uses an explicit zero as the rollback switch", () => {
    expect(readFeatureFlags(env("0")).gcodeReact).toBe(false);
  });
});
