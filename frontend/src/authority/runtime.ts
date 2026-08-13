/* Node API 边界的运行模式与请求装配（自旧 app/runtime 与 app/api 收拢至此）。 */

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

/**
 * 只用于 Node API 边界：浏览器凭据保持同源，显式配置的服务凭据以
 * Node 认可的请求头附加。不得用于 sidecar 或第三方 URL。
 */
export function createNodeRequestInit(env: ImportMetaEnv, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.delete("Authorization");
  headers.delete("X-API-Key");

  const bearer = env.VITE_NODE_BEARER?.trim();
  const apiKey = env.VITE_NODE_API_KEY?.trim();
  if (bearer) {
    headers.set("Authorization", /^Bearer\s+/i.test(bearer) ? bearer : `Bearer ${bearer}`);
  } else if (apiKey) {
    headers.set("X-API-Key", apiKey);
  }

  return { ...init, headers, credentials: "same-origin" };
}

export function resolveNodeApiBase(env: ImportMetaEnv): string {
  const configured = env.VITE_API_BASE?.trim();
  if (!configured) return "";
  if (configured === "offline") throw new Error("离线模式不发起 Node API 请求");
  return configured.replace(/\/+$/, "");
}
