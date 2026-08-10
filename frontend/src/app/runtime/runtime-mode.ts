export type RuntimeMode =
  | { kind: "offline"; apiBase: null; reason: "file-protocol" | "forced-offline" }
  | { kind: "remote"; apiBase: string; reason: "configured-api" | "same-origin" };

export function detectRuntimeMode(location: Pick<Location, "protocol">, env: ImportMetaEnv): RuntimeMode {
  const configured = env.VITE_API_BASE?.trim();
  if (configured === "offline") return { kind: "offline", apiBase: null, reason: "forced-offline" };
  if (location.protocol === "file:") return { kind: "offline", apiBase: null, reason: "file-protocol" };
  if (configured) return { kind: "remote", apiBase: configured.replace(/\/+$/, ""), reason: "configured-api" };
  return { kind: "remote", apiBase: "", reason: "same-origin" };
}
