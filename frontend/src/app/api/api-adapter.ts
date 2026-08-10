import type { RuntimeMode } from "../runtime/runtime-mode";

export interface Capabilities {
  readonly mode: RuntimeMode["kind"];
  readonly available: boolean;
  readonly engine: string;
  readonly ai: boolean;
  readonly scope: "offline" | "system" | "current-user";
  readonly detail: string;
}

export interface ApiAdapter {
  capabilities(signal?: AbortSignal): Promise<Capabilities>;
}

interface HealthResponse {
  readonly ok?: boolean;
  readonly engine?: string;
  readonly capabilityScope?: "system" | "current-user";
  readonly capabilities?: { readonly ai?: boolean };
  readonly reason?: string;
}

const CAPABILITY_TIMEOUT_MS = 5000;

/**
 * Builds request options exclusively for the Node API boundary. Browser
 * credentials stay same-origin, while an explicitly configured service
 * credential is attached as a Node-recognized header. Callers must not use
 * this helper for sidecar or third-party URLs.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHealthResponse(value: unknown): HealthResponse {
  if (!isRecord(value)) throw new Error("能力探测返回了无效 JSON 结构");
  if (value.ok !== undefined && typeof value.ok !== "boolean") throw new Error("能力探测字段 ok 类型无效");
  if (value.engine !== undefined && typeof value.engine !== "string") throw new Error("能力探测字段 engine 类型无效");
  if (value.reason !== undefined && typeof value.reason !== "string") throw new Error("能力探测字段 reason 类型无效");
  const capabilityScope = value.capabilityScope;
  if (capabilityScope !== undefined && capabilityScope !== "system" && capabilityScope !== "current-user") {
    throw new Error("能力探测字段 capabilityScope 无效");
  }
  const capabilities = value.capabilities;
  if (capabilities !== undefined && !isRecord(capabilities)) throw new Error("能力探测字段 capabilities 类型无效");
  const ai = isRecord(capabilities) && typeof capabilities.ai === "boolean" ? capabilities.ai : undefined;
  return {
    ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
    ...(typeof value.engine === "string" ? { engine: value.engine } : {}),
    ...(capabilityScope === "system" || capabilityScope === "current-user" ? { capabilityScope } : {}),
    ...(ai === undefined ? {} : { capabilities: { ai } }),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

class RemoteApiAdapter implements ApiAdapter {
  public constructor(
    private readonly base: string,
    private readonly env: ImportMetaEnv
  ) {}

  public async capabilities(signal?: AbortSignal): Promise<Capabilities> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = globalThis.setTimeout(() => controller.abort(new Error("能力探测超时")), CAPABILITY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(this.base + "/healthz", createNodeRequestInit(this.env, { signal: controller.signal }));
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error("能力探测超时", { cause: error });
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!response.ok) throw new Error(`能力探测失败（HTTP ${response.status}）`);
    const health = parseHealthResponse(await response.json());
    return {
      mode: "remote",
      available: health.ok === true,
      engine: health.engine ?? "unknown",
      ai: health.capabilities?.ai === true,
      scope: health.capabilityScope ?? "system",
      detail: health.reason ?? "服务端已连接",
    };
  }
}

class OfflineApiAdapter implements ApiAdapter {
  public async capabilities(): Promise<Capabilities> {
    return {
      mode: "offline",
      available: true,
      engine: "browser-preview",
      ai: false,
      scope: "offline",
      detail: "离线演示模式：仅运行浏览器预览，不请求认证或后端 API。",
    };
  }
}

export function createApiAdapter(mode: RuntimeMode, env: ImportMetaEnv = import.meta.env): ApiAdapter {
  return mode.kind === "remote" ? new RemoteApiAdapter(mode.apiBase, env) : new OfflineApiAdapter();
}
