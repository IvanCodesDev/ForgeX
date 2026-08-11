import { describe, expect, it } from "vitest";
import { readFeatureFlags } from "./feature-flags";

function env(
  gcode?: "0" | "1",
  machineLog?: "0" | "1",
  profileSelector?: "0" | "1",
  analytics?: "0" | "1",
  governance?: "0" | "1",
  simulator?: "0" | "1"
): ImportMetaEnv {
  return {
    BASE_URL: "/",
    MODE: "test",
    DEV: false,
    PROD: false,
    SSR: false,
    ...(gcode === undefined ? {} : { VITE_REACT_GCODE_ENABLED: gcode }),
    ...(machineLog === undefined ? {} : { VITE_REACT_MACHINE_LOG_ENABLED: machineLog }),
    ...(profileSelector === undefined ? {} : { VITE_REACT_PROFILE_SELECTOR_ENABLED: profileSelector }),
    ...(analytics === undefined ? {} : { VITE_REACT_ANALYTICS_ENABLED: analytics }),
    ...(governance === undefined ? {} : { VITE_REACT_GOVERNANCE_ENABLED: governance }),
    ...(simulator === undefined ? {} : { VITE_REACT_SIMULATOR_ENABLED: simulator }),
  };
}

describe("readFeatureFlags", () => {
  it("enables the migrated slice by default", () => {
    expect(readFeatureFlags(env()).simulatorReact).toBe(true);
    expect(readFeatureFlags(env()).gcodeReact).toBe(true);
    expect(readFeatureFlags(env()).machineLogReact).toBe(true);
    expect(readFeatureFlags(env()).profileSelectorReact).toBe(true);
    expect(readFeatureFlags(env()).analyticsReact).toBe(true);
    expect(readFeatureFlags(env()).governanceReact).toBe(true);
  });

  it("uses an explicit zero as the rollback switch", () => {
    expect(readFeatureFlags(env("0")).gcodeReact).toBe(false);
  });

  it("rolls back only the React machine-log slice with its independent switch", () => {
    const flags = readFeatureFlags(env("1", "0"));
    expect(flags.gcodeReact).toBe(true);
    expect(flags.machineLogReact).toBe(false);
  });

  it("rolls back only the Profile selector with its independent switch", () => {
    const flags = readFeatureFlags(env("1", "1", "0"));
    expect(flags.gcodeReact).toBe(true);
    expect(flags.machineLogReact).toBe(true);
    expect(flags.profileSelectorReact).toBe(false);
  });

  it("rolls back only the analytics page with its independent switch", () => {
    const flags = readFeatureFlags(env("1", "1", "1", "0"));
    expect(flags.gcodeReact).toBe(true);
    expect(flags.analyticsReact).toBe(false);
  });

  it("rolls back only the governance page with its independent switch", () => {
    const flags = readFeatureFlags(env("1", "1", "1", "1", "0"));
    expect(flags.analyticsReact).toBe(true);
    expect(flags.governanceReact).toBe(false);
  });

  it("rolls back only the simulator page with its independent switch", () => {
    const flags = readFeatureFlags(env("1", "1", "1", "1", "1", "0"));
    expect(flags.gcodeReact).toBe(true);
    expect(flags.governanceReact).toBe(true);
    expect(flags.simulatorReact).toBe(false);
  });
});
