// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_SIMULATION_TRANSFORM, STANDARD_SIMULATION_SETTINGS } from "./simulator-schema";
import type { QuickSimulationResult, QuickSimulationState } from "./simulator-types";

const simulationMock = vi.hoisted(() => ({
  run: vi.fn(),
  cancel: vi.fn(),
  markStale: vi.fn(),
  reset: vi.fn(),
  state: null as unknown,
}));

vi.mock("./useQuickSimulation", () => ({
  useQuickSimulation: () => ({
    state: simulationMock.state as QuickSimulationState,
    run: simulationMock.run,
    cancel: simulationMock.cancel,
    markStale: simulationMock.markStale,
    reset: simulationMock.reset,
  }),
}));

import { SimulatorPage } from "./SimulatorPage";

const RESULT: QuickSimulationResult = {
  authority: { kind: "instant-preview", authoritative: false, label: "浏览器即时预览（非权威）" },
  engine: { name: "FXSlicer + FXSim.computeQuality", source: "legacy-js-adapter", version: "legacy-js-preview/1" },
  input: {
    modelId: "gear",
    machineProfile: { id: "corexy", source: "FORGE·X built-in profile" },
    materialProfile: { id: "PLA", source: "FORGE·X engineering baseline" },
    settings: STANDARD_SIMULATION_SETTINGS,
    tf: IDENTITY_SIMULATION_TRANSFORM,
  },
  model: { id: "gear", name: "行星齿轮", dimensions: "Ø55 × 16 mm" },
  profiles: { machineId: "corexy", materialId: "PLA" },
  summary: {
    totalLayers: 80,
    pathCount: 123,
    heightMm: 16,
    extrusionLengthMm: 92052.26526,
    travelLengthMm: 25280.717698,
    pathTimeSeconds: 1515.673755,
    fixedOverheadSeconds: 95,
    estimatedTimeSeconds: 1610.673755,
    volumeCm3: 8.284704,
    filamentLengthM: 3.44438,
    filamentMassG: 10.273033,
    materialCostCny: 0.708839,
  },
  quality: [{ name: "层间结合强度", score: 99, level: "good", tip: "温度处于 PLA 理想窗口" }],
  evidence: [{ code: "FIXED_PROCESS_OVERHEAD", value: 95, unit: "s", note: "预热与调平固定开销。" }],
  runtimeMs: 12.5,
  warnings: [
    { code: "SIMPLIFIED_MOTION_MODEL", message: "即时预览未模拟固件加速度。" },
    { code: "BED_BOUNDS_NOT_ENFORCED", message: "本切片未执行平台越界裁剪。" },
    { code: "STATE_MACHINE_NOT_RUN", message: "完整状态机不参与本次摘要。" },
  ],
};

const IDLE: QuickSimulationState = {
  status: "idle",
  jobId: "",
  progress: 0,
  stage: "等待参数",
  result: null,
  error: "",
  errorCode: "",
};

function setState(changes: Partial<QuickSimulationState> = {}): void {
  simulationMock.state = { ...IDLE, ...changes } satisfies QuickSimulationState;
}

describe("SimulatorPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    simulationMock.run.mockReset();
    simulationMock.cancel.mockReset();
    simulationMock.markStale.mockReset();
    simulationMock.reset.mockReset();
    setState();
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("loads the standard model and submits a default preview after 300 ms", () => {
    render(<SimulatorPage />);

    expect(screen.getByLabelText("内置模型")).toHaveValue("gear");
    expect(screen.getByLabelText("机器 Profile")).toHaveValue("corexy");
    expect(screen.getByLabelText("材料 Profile")).toHaveValue("PLA");
    expect(screen.getByLabelText("层高")).toHaveValue(0.2);
    expect(screen.getByRole("button", { name: /标准平衡/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("浏览器即时预览（非权威）").length).toBeGreaterThanOrEqual(2);

    act(() => vi.advanceTimersByTime(299));
    expect(simulationMock.run).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(simulationMock.run).toHaveBeenCalledTimes(1);
    expect(simulationMock.run.mock.calls[0]![0]).toMatchObject({
      modelId: "gear",
      machine: { id: "corexy" },
      material: { id: "PLA" },
      settings: { material: "PLA", layerHeight: 0.2, infillDensity: 0.18 },
      tf: { scale: 1, rotZ: 0, offX: 0, offY: 0 },
    });
  });

  it("resets thermal controls and clamps speed when the material Profile changes", () => {
    render(<SimulatorPage />);
    act(() => vi.advanceTimersByTime(300));
    simulationMock.run.mockClear();

    fireEvent.change(screen.getByLabelText("打印速度"), { target: { value: "300" } });
    fireEvent.change(screen.getByLabelText("材料 Profile"), { target: { value: "TPU" } });

    expect(screen.getByLabelText("喷嘴温度")).toHaveValue(225);
    expect(screen.getByLabelText("热床温度")).toHaveValue(50);
    expect(screen.getByLabelText("风扇转速")).toHaveValue(50);
    expect(screen.getByLabelText("打印速度")).toHaveValue(60);

    act(() => vi.advanceTimersByTime(300));
    expect(simulationMock.run).toHaveBeenCalledTimes(1);
    expect(simulationMock.run.mock.calls[0]![0]).toMatchObject({
      material: { id: "TPU" },
      settings: { material: "TPU", nozzleTemp: 225, bedTemp: 50, fanSpeed: 50, speed: 60 },
    });
  });

  it("reports invalid process parameters and suppresses automatic submission", () => {
    render(<SimulatorPage />);
    fireEvent.change(screen.getByLabelText("层高"), { target: { value: "0.01" } });

    expect(screen.getByLabelText("层高")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("input.settings.layerHeight");
    expect(screen.getByRole("button", { name: "立即重新计算" })).toBeDisabled();

    act(() => vi.advanceTimersByTime(600));
    expect(simulationMock.run).not.toHaveBeenCalled();
  });

  it("marks an existing result stale while retaining its evidence", () => {
    setState({ status: "success", progress: 1, stage: "即时预览完成", result: RESULT });
    const view = render(<SimulatorPage />);
    expect(screen.getByText("预览计算完成。")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("内置模型"), { target: { value: "impeller" } });
    expect(simulationMock.markStale).toHaveBeenCalledTimes(1);

    setState({ status: "stale", stage: "参数已变化", result: RESULT });
    view.rerender(<SimulatorPage />);
    expect(screen.getByText(/以下结果已经过期/)).toBeInTheDocument();
    expect(screen.getByText("80 / 123")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "即时预览计算证据" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "即时预览质量证据" })).toBeInTheDocument();
  });

  it("exposes labelled groups, live progress and an accessible cancel action", () => {
    setState({ status: "running", jobId: "job-1", progress: 0.34, stage: "生成逐层路径" });
    render(<SimulatorPage />);

    expect(screen.getByRole("group", { name: "几何与填充" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "温控与运动" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "支撑与调平" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "模拟计算进度" })).toHaveValue(0.34);
    fireEvent.click(screen.getByRole("button", { name: "取消计算" }));
    expect(simulationMock.cancel).toHaveBeenCalledTimes(1);
  });
});
