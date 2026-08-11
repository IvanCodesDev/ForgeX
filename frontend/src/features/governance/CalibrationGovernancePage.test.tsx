// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMode } from "../../app/runtime/runtime-mode";
import { CalibrationGovernancePage } from "./CalibrationGovernancePage";
import { calibrationCatalog } from "./governance-test-fixtures";

const REMOTE: RuntimeMode = { kind: "remote", apiBase: "https://api.example.test", reason: "configured-api" };
const OFFLINE: RuntimeMode = { kind: "offline", apiBase: null, reason: "file-protocol" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CalibrationGovernancePage", () => {
  it("keeps the default build environment stable after catalog state updates", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json(calibrationCatalog())));
    vi.stubGlobal("fetch", fetchMock);

    render(<CalibrationGovernancePage runtimeMode={REMOTE} />);

    expect(await screen.findByRole("heading", { level: 3, name: /^factory-line-a r2$/ })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders an explicit offline read-only boundary with zero network traffic", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<CalibrationGovernancePage runtimeMode={OFFLINE} />);

    expect(await screen.findByRole("heading", { name: "离线预览不连接校准发布服务" })).toBeInTheDocument();
    expect(screen.getByText("离线模式不含服务端发布记录。")).toBeInTheDocument();
    expect(screen.getByLabelText("18 位分享 token")).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows public release evidence and keeps restricted governance visibly read-only", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json(calibrationCatalog())));
    vi.stubGlobal("fetch", fetchMock);

    render(<CalibrationGovernancePage runtimeMode={REMOTE} />);

    expect(await screen.findByRole("heading", { level: 3, name: /^factory-line-a r2$/ })).toBeInTheDocument();
    expect(screen.getByText("10% / 20%")).toBeInTheDocument();
    expect(screen.getByText("浏览器治理页固定为只读；审核队列仅向受信后台的专用身份开放。")).toBeInTheDocument();
    expect(screen.getByText("浏览器只读")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批准并发布" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();

    const token = screen.getByLabelText("18 位分享 token");
    fireEvent.change(token, { target: { value: "bad-token" } });
    expect(screen.getByRole("alert")).toHaveTextContent("18 位十六进制值");
    fireEvent.change(token, { target: { value: "0123456789ABCDEF01" } });
    expect(screen.getByRole("link", { name: "打开服务端分享页" })).toHaveAttribute(
      "href",
      "https://api.example.test/share/0123456789abcdef01"
    );
  });
});
