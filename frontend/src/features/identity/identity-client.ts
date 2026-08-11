import { createNodeRequestInit } from "../../app/api/api-adapter";
import type { RuntimeMode } from "../../app/runtime/runtime-mode";

export type IdentityMode = "offline" | "anonymous" | "api" | "sso";
export type IdentityPhase = "loading" | "ready" | "error";
export type AiCapabilityScope = "none" | "system" | "current-user";

export interface IdentityUser {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

export interface IdentityState {
  readonly phase: IdentityPhase;
  readonly mode: IdentityMode;
  readonly user: IdentityUser | null;
  readonly ssoEnabled: boolean;
  readonly authRequired: boolean;
  readonly canUseAi: boolean;
  readonly aiScope: AiCapabilityScope;
  readonly message: string;
}

export interface IdentityService {
  readonly initialState: IdentityState;
  readonly loginHref: string | null;
  load(signal?: AbortSignal): Promise<IdentityState>;
  logout(signal?: AbortSignal): Promise<void>;
}

interface MeResponse {
  readonly enabled: boolean;
  readonly authenticated: boolean;
  readonly user: IdentityUser | null;
  readonly canUseAi: boolean;
}

interface HealthResponse {
  readonly ok: boolean;
  readonly ai: boolean;
  readonly scope: "system" | "current-user";
  readonly authRequired: boolean;
}

const IDENTITY_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredBoolean(record: Record<string, unknown>, field: string, source: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw new Error(`${source} 字段 ${field} 类型无效`);
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`身份字段 ${field} 类型无效`);
  return value;
}

function parseMeResponse(value: unknown): MeResponse {
  if (!isRecord(value)) throw new Error("身份接口返回了无效 JSON 结构");
  const enabled = requiredBoolean(value, "enabled", "身份接口");
  const authenticated = requiredBoolean(value, "authenticated", "身份接口");
  const canUseAi = requiredBoolean(value, "canUseAi", "身份接口");
  let user: IdentityUser | null = null;
  if (authenticated) {
    if (!isRecord(value.user)) throw new Error("已登录身份缺少用户资料");
    const id = optionalString(value.user, "id").trim();
    if (!id) throw new Error("已登录身份缺少用户 ID");
    const nickname = optionalString(value.user, "nickname").trim();
    const email = optionalString(value.user, "email").trim();
    user = { id, displayName: nickname || email || "SSO 用户", email };
  } else if (value.user !== null && value.user !== undefined) {
    throw new Error("匿名身份不应包含用户资料");
  }
  return { enabled, authenticated, user, canUseAi };
}

function parseHealthResponse(value: unknown): HealthResponse {
  if (!isRecord(value)) throw new Error("健康接口返回了无效 JSON 结构");
  const ok = requiredBoolean(value, "ok", "健康接口");
  const capabilities = value.capabilities;
  if (!isRecord(capabilities)) throw new Error("健康接口字段 capabilities 类型无效");
  const ai = requiredBoolean(capabilities, "ai", "健康接口 capabilities");
  const scope = value.capabilityScope;
  if (scope !== "system" && scope !== "current-user") throw new Error("健康接口字段 capabilityScope 无效");
  const auth = value.auth;
  if (!isRecord(auth)) throw new Error("健康接口字段 auth 类型无效");
  const authRequired = requiredBoolean(auth, "required", "健康接口 auth");
  return { ok, ai, scope, authRequired };
}

function hasConfiguredNodeCredential(env: ImportMetaEnv): boolean {
  return Boolean(env.VITE_NODE_BEARER?.trim() || env.VITE_NODE_API_KEY?.trim());
}

function offlineState(): IdentityState {
  return {
    phase: "ready",
    mode: "offline",
    user: null,
    ssoEnabled: false,
    authRequired: false,
    canUseAi: false,
    aiScope: "none",
    message: "离线预览不会连接身份服务。",
  };
}

function loadingState(): IdentityState {
  return {
    phase: "loading",
    mode: "anonymous",
    user: null,
    ssoEnabled: false,
    authRequired: false,
    canUseAi: false,
    aiScope: "none",
    message: "正在核验当前身份与服务能力。",
  };
}

export function identityErrorState(message: string): IdentityState {
  return {
    phase: "error",
    mode: "anonymous",
    user: null,
    ssoEnabled: false,
    authRequired: false,
    canUseAi: false,
    aiScope: "none",
    message,
  };
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(new Error("身份服务响应超时")), IDENTITY_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error("身份服务响应超时", { cause: error });
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function createIdentityService(runtimeMode: RuntimeMode, env: ImportMetaEnv = import.meta.env): IdentityService {
  if (runtimeMode.kind === "offline") {
    return {
      initialState: offlineState(),
      loginHref: null,
      async load() {
        return offlineState();
      },
      async logout() {
        return Promise.resolve();
      },
    };
  }

  const base = runtimeMode.apiBase;
  const requestJson = async (path: string, signal: AbortSignal): Promise<unknown> => {
    const response = await fetch(
      base + path,
      createNodeRequestInit(env, {
        signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
    );
    if (!response.ok) throw new Error(`身份服务请求失败（HTTP ${response.status}）`);
    return response.json();
  };

  return {
    initialState: loadingState(),
    loginHref: base + "/api/auth/infini/login?returnTo=%2Freact%2F",
    async load(signal) {
      return withTimeout(async (requestSignal) => {
        const [me, health] = await Promise.all([
          requestJson("/api/auth/infini/me", requestSignal).then(parseMeResponse),
          requestJson("/healthz", requestSignal).then(parseHealthResponse),
        ]);
        if (!health.ok) throw new Error("服务尚未就绪");

        const hasCredential = hasConfiguredNodeCredential(env);
        const mode: IdentityMode = me.authenticated ? "sso" : hasCredential ? "api" : "anonymous";
        const canUseAi = me.canUseAi || health.ai;
        const aiScope: AiCapabilityScope = me.canUseAi ? "current-user" : health.ai ? health.scope : "none";
        return {
          phase: "ready",
          mode,
          user: me.user,
          ssoEnabled: me.enabled,
          authRequired: health.authRequired,
          canUseAi,
          aiScope,
          message:
            mode === "sso"
              ? "SSO 会话已验证。"
              : mode === "api"
                ? "API 请求凭据已配置，敏感值不会进入界面状态。"
                : "当前使用匿名访问能力。",
        };
      }, signal);
    },
    async logout(signal) {
      return withTimeout(async (requestSignal) => {
        const response = await fetch(
          base + "/api/auth/infini/logout",
          createNodeRequestInit(env, {
            method: "POST",
            signal: requestSignal,
            cache: "no-store",
            headers: { Accept: "application/json" },
          })
        );
        if (!response.ok) throw new Error(`退出登录失败（HTTP ${response.status}）`);
      }, signal);
    },
  };
}
