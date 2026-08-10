import { describe, expect, it, vi } from "vitest";
import { createApiAdapter, createNodeRequestInit } from "./api-adapter";

function env(auth: { apiKey?: string; bearer?: string } = {}): ImportMetaEnv {
  return {
    BASE_URL: "/",
    MODE: "test",
    DEV: false,
    PROD: false,
    SSR: false,
    ...(auth.apiKey ? { VITE_NODE_API_KEY: auth.apiKey } : {}),
    ...(auth.bearer ? { VITE_NODE_BEARER: auth.bearer } : {}),
  };
}

describe("createApiAdapter", () => {
  it("keeps offline capability detection local", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createApiAdapter({ kind: "offline", apiBase: null, reason: "file-protocol" });

    await expect(adapter.capabilities()).resolves.toMatchObject({
      mode: "offline",
      available: true,
      engine: "browser-preview",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the shared Node auth initializer for health probing and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engine: "server-rules",
          capabilityScope: "current-user",
          capabilities: { ai: false },
          reason: "fixture",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createApiAdapter(
      { kind: "remote", apiBase: "https://api.example.test", reason: "configured-api" },
      env({ bearer: "node-bearer" })
    );

    await expect(adapter.capabilities()).resolves.toEqual({
      mode: "remote",
      available: true,
      engine: "server-rules",
      ai: false,
      scope: "current-user",
      detail: "fixture",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/healthz",
      expect.objectContaining({ credentials: "same-origin", signal: expect.any(AbortSignal) })
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("Authorization")).toBe("Bearer node-bearer");
    expect(new Headers(request.headers).has("X-API-Key")).toBe(false);
  });

  it("supports an X-API-Key and gives an explicitly configured Bearer token precedence", () => {
    const keyed = createNodeRequestInit(env({ apiKey: " node-key " }), {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    expect(keyed.credentials).toBe("same-origin");
    expect(keyed.headers).toBeInstanceOf(Headers);
    expect(new Headers(keyed.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(keyed.headers).get("X-API-Key")).toBe("node-key");

    const bearer = createNodeRequestInit(env({ apiKey: "node-key", bearer: "Bearer node-token" }));
    expect(new Headers(bearer.headers).get("Authorization")).toBe("Bearer node-token");
    expect(new Headers(bearer.headers).has("X-API-Key")).toBe(false);
  });

  it("rejects malformed health payloads instead of trusting a type assertion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: "yes" }), { status: 200 })));
    const adapter = createApiAdapter({ kind: "remote", apiBase: "", reason: "same-origin" });

    await expect(adapter.capabilities()).rejects.toThrow("字段 ok 类型无效");
  });
});
