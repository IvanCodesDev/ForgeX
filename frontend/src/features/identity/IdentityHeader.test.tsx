// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../app/AppShell";
import type { RuntimeMode } from "../../app/runtime/runtime-mode";
import type { IdentityService, IdentityState } from "./identity-client";
import { IdentityProvider } from "./IdentityProvider";

const REMOTE: RuntimeMode = { kind: "remote", apiBase: "", reason: "same-origin" };
const OFFLINE: RuntimeMode = { kind: "offline", apiBase: null, reason: "file-protocol" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function readyState(overrides: Partial<IdentityState>): IdentityState {
  return {
    phase: "ready",
    mode: "anonymous",
    user: null,
    ssoEnabled: true,
    authRequired: false,
    canUseAi: false,
    aiScope: "none",
    message: "fixture",
    ...overrides,
  };
}

function serviceFor(state: IdentityState): IdentityService & {
  load: ReturnType<typeof vi.fn<IdentityService["load"]>>;
  logout: ReturnType<typeof vi.fn<IdentityService["logout"]>>;
} {
  return {
    initialState:
      state.mode === "offline"
        ? state
        : readyState({ phase: "loading", mode: "anonymous", ssoEnabled: false, message: "loading" }),
    loginHref: state.mode === "offline" ? null : "/api/auth/infini/login",
    load: vi.fn<IdentityService["load"]>().mockResolvedValue(state),
    logout: vi.fn<IdentityService["logout"]>().mockResolvedValue(undefined),
  };
}

function renderShell(service: IdentityService, runtimeMode: RuntimeMode = REMOTE) {
  return render(
    <MemoryRouter>
      <IdentityProvider runtimeMode={runtimeMode} service={service}>
        <Routes>
          <Route element={<AppShell runtimeMode={runtimeMode} />}>
            <Route index element={<p>工作区内容</p>} />
          </Route>
        </Routes>
      </IdentityProvider>
    </MemoryRouter>
  );
}

describe("IdentityHeader", () => {
  it("keeps the default build environment stable after identity state updates", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/auth/infini/me")) {
        return Promise.resolve(Response.json({ enabled: false, authenticated: false, user: null, canUseAi: false }));
      }
      return Promise.resolve(
        Response.json({
          ok: true,
          capabilities: { ai: false },
          capabilityScope: "system",
          auth: { required: false },
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <IdentityProvider runtimeMode={REMOTE}>
        <span>identity child</span>
      </IdentityProvider>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("renders offline state without starting a network identity load", () => {
    const service = serviceFor(readyState({ mode: "offline", ssoEnabled: false, message: "offline" }));
    renderShell(service, OFFLINE);

    expect(screen.getByText("离线访客")).toBeInTheDocument();
    expect(screen.getByText("仅浏览器能力")).toBeInTheDocument();
    expect(service.load).not.toHaveBeenCalled();
  });

  it("shows anonymous login and an accessible notification center", async () => {
    const service = serviceFor(readyState({ mode: "anonymous", ssoEnabled: true }));
    renderShell(service);

    expect(await screen.findByText("匿名访客")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "登录" })).toHaveAttribute("href", "/api/auth/infini/login");
    expect(screen.getByLabelText("通知，1 条")).toBeInTheDocument();
    expect(screen.getByText("匿名体验")).toBeInTheDocument();
  });

  it("shows SSO identity and refreshes after logout", async () => {
    const sso = readyState({
      mode: "sso",
      user: { id: "u-1", displayName: "生产操作员", email: "operator@example.test" },
      canUseAi: true,
      aiScope: "current-user",
    });
    const service = serviceFor(sso);
    renderShell(service);

    expect(await screen.findByText("生产操作员")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出" }));

    await waitFor(() => expect(service.logout).toHaveBeenCalledOnce());
    await waitFor(() => expect(service.load).toHaveBeenCalledTimes(2));
  });

  it("renders API capability without placing a configured secret in the DOM", async () => {
    const service = serviceFor(readyState({ mode: "api", canUseAi: true, aiScope: "system" }));
    const view = renderShell(service);

    expect(await screen.findByText("API 客户端")).toBeInTheDocument();
    expect(screen.getByText("API · AI 可用")).toBeInTheDocument();
    expect(view.container.textContent).not.toContain("fixture-super-secret-api-key");
  });

  it("exposes error and retry states", async () => {
    const anonymous = readyState({ mode: "anonymous" });
    const service = serviceFor(anonymous);
    service.load.mockRejectedValueOnce(new Error("fixture connection failed")).mockResolvedValue(anonymous);
    renderShell(service);

    expect(await screen.findByText("连接异常")).toBeInTheDocument();
    expect(screen.getAllByText("fixture connection failed")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("匿名访客")).toBeInTheDocument();
    expect(service.load).toHaveBeenCalledTimes(2);
  });
});
