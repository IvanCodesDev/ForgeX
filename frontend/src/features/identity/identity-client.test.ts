import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMode } from "../../app/runtime/runtime-mode";
import { createIdentityService } from "./identity-client";

const REMOTE: RuntimeMode = { kind: "remote", apiBase: "https://api.example.test", reason: "configured-api" };
const OFFLINE: RuntimeMode = { kind: "offline", apiBase: null, reason: "file-protocol" };

function env(credentials: { apiKey?: string; bearer?: string } = {}): ImportMetaEnv {
  return {
    BASE_URL: "/",
    MODE: "test",
    DEV: false,
    PROD: false,
    SSR: false,
    ...(credentials.apiKey ? { VITE_NODE_API_KEY: credentials.apiKey } : {}),
    ...(credentials.bearer ? { VITE_NODE_BEARER: credentials.bearer } : {}),
  };
}

function responseFor(url: string, me: unknown, health: unknown): Response {
  if (url.endsWith("/api/auth/infini/me")) return Response.json(me);
  if (url.endsWith("/healthz")) return Response.json(health);
  if (url.endsWith("/api/auth/infini/logout")) return Response.json({ ok: true });
  return Response.json({ error: "not found" }, { status: 404 });
}

const ANONYMOUS_ME = {
  enabled: true,
  authenticated: false,
  user: null,
  canUseAi: false,
};
const HEALTH = {
  ok: true,
  capabilities: { ai: false },
  capabilityScope: "system",
  auth: { enabled: true, required: false },
};

afterEach(() => vi.unstubAllGlobals());

describe("createIdentityService", () => {
  it("keeps file mode fully offline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = createIdentityService(OFFLINE, env());

    expect(service.initialState).toMatchObject({ phase: "ready", mode: "offline", canUseAi: false });
    expect(service.loginHref).toBeNull();
    await expect(service.load()).resolves.toEqual(service.initialState);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives a verified SSO session priority and combines user/system capability safely", async () => {
    const me = {
      enabled: true,
      authenticated: true,
      user: { id: "user-7", nickname: "Operator", email: "operator@example.test", avatar: "https://cdn.test/a" },
      canUseAi: true,
      integration: "fixture",
    };
    const health = {
      ...HEALTH,
      capabilities: { ai: true },
      capabilityScope: "current-user",
      auth: { enabled: true, required: true },
    };
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(responseFor(String(input), me, health))
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createIdentityService(REMOTE, env({ apiKey: "secondary-key" })).load()).resolves.toMatchObject({
      phase: "ready",
      mode: "sso",
      user: { id: "user-7", displayName: "Operator", email: "operator@example.test" },
      authRequired: true,
      canUseAi: true,
      aiScope: "current-user",
    });
  });

  it("reports configured API capability without retaining or exposing the credential", async () => {
    const secret = "fixture-super-secret-api-key";
    const health = { ...HEALTH, capabilities: { ai: true } };
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(responseFor(String(input), ANONYMOUS_ME, health))
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createIdentityService(REMOTE, env({ apiKey: secret }));

    const state = await service.load();

    expect(state).toMatchObject({ phase: "ready", mode: "api", canUseAi: true, aiScope: "system" });
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(service.loginHref).toBe("https://api.example.test/api/auth/infini/login?returnTo=%2Freact%2F");
    for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toContain(secret);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-API-Key")).toBe(secret);
  });

  it("represents an uncredentialed session as anonymous", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => Promise.resolve(responseFor(String(input), ANONYMOUS_ME, HEALTH)))
    );

    await expect(createIdentityService(REMOTE, env()).load()).resolves.toMatchObject({
      phase: "ready",
      mode: "anonymous",
      ssoEnabled: true,
      canUseAi: false,
    });
  });

  it("rejects malformed identity contracts instead of trusting server data", async () => {
    const malformedMe = { ...ANONYMOUS_ME, authenticated: true, user: null };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => Promise.resolve(responseFor(String(input), malformedMe, HEALTH)))
    );

    await expect(createIdentityService(REMOTE, env()).load()).rejects.toThrow("缺少用户资料");
  });

  it("logs out through a credentialed same-origin request", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(responseFor(String(input), ANONYMOUS_ME, HEALTH))
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createIdentityService(REMOTE, env({ bearer: "node-token" }));

    await expect(service.logout()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.test/api/auth/infini/logout");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer node-token");
  });
});
