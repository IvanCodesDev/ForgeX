export interface FeatureFlags {
  readonly gcodeReact: boolean;
}

export function readFeatureFlags(env: ImportMetaEnv): FeatureFlags {
  return { gcodeReact: env.VITE_REACT_GCODE_ENABLED !== "0" };
}
