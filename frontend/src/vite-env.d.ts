/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_NODE_API_KEY?: string;
  readonly VITE_NODE_BEARER?: string;
  readonly VITE_REACT_SIMULATOR_ENABLED?: "0" | "1";
  readonly VITE_REACT_GCODE_ENABLED?: "0" | "1";
  readonly VITE_REACT_MACHINE_LOG_ENABLED?: "0" | "1";
  readonly VITE_REACT_PROFILE_SELECTOR_ENABLED?: "0" | "1";
  readonly VITE_REACT_ANALYTICS_ENABLED?: "0" | "1";
  readonly VITE_REACT_GOVERNANCE_ENABLED?: "0" | "1";
  readonly VITE_GCODE_AUTHORITY?: "browser" | "shadow" | "dotnet";
  /** @deprecated G-code authority traffic always enters through VITE_API_BASE / Node. */
  readonly VITE_AUTHORITY_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
