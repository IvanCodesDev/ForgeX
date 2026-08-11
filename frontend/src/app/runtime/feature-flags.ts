export interface FeatureFlags {
  readonly simulatorReact: boolean;
  readonly gcodeReact: boolean;
  readonly machineLogReact: boolean;
  readonly profileSelectorReact: boolean;
  readonly analyticsReact: boolean;
  readonly analyticsAuthority: "browser" | "shadow";
  readonly governanceReact: boolean;
}

export function readFeatureFlags(env: ImportMetaEnv): FeatureFlags {
  return {
    simulatorReact: env.VITE_REACT_SIMULATOR_ENABLED !== "0",
    gcodeReact: env.VITE_REACT_GCODE_ENABLED !== "0",
    machineLogReact: env.VITE_REACT_MACHINE_LOG_ENABLED !== "0",
    profileSelectorReact: env.VITE_REACT_PROFILE_SELECTOR_ENABLED !== "0",
    analyticsReact: env.VITE_REACT_ANALYTICS_ENABLED !== "0",
    analyticsAuthority: env.VITE_ANALYTICS_AUTHORITY === "shadow" ? "shadow" : "browser",
    governanceReact: env.VITE_REACT_GOVERNANCE_ENABLED !== "0",
  };
}
