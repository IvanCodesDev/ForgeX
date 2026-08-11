// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parseFile =
  vi.fn<
    (
      ...args: [
        File,
        { bedSize: number; densityG: number; origin: string; machineProfileId: string; materialProfileId: string },
      ]
    ) => Promise<void>
  >();
const cancel = vi.fn();
const reset = vi.fn();

vi.mock("./useGcodeWorker", () => ({
  useGcodeWorker: () => ({
    state: {
      status: "done",
      stage: "解析完成",
      progress: 1,
      error: "",
      errorCode: null,
      result: {
        fileName: "fixture.gcode",
        byteLength: 18,
        sha256: "a".repeat(64),
        totalLayers: 1,
        height: 0.2,
        stats: {
          extLenMm: 10,
          travelMm: 2,
          timeSec: 3,
          volumeCm3: 0.02,
          filamentM: 0.01,
          filamentG: 0.02,
        },
        bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
        coordinateOrigin: "corner",
        warnings: [],
        claims: {},
        layers: [],
        layerSegmentOffsets: [0],
        sourceSegments: 0,
        previewSegments: 0,
        previewTruncated: false,
      },
    },
    parseFile,
    cancel,
    reset,
  }),
}));

vi.mock("./useGcodeAuthority", () => ({
  useGcodeAuthority: () => ({
    mode: "browser",
    status: "idle",
    result: null,
    diff: null,
    error: "",
    jobId: null,
    progress: 0,
    phase: "idle",
    transport: "sync",
    cancel: vi.fn(),
  }),
}));

vi.mock("./GcodeViewer", () => ({ GcodeViewer: () => <div data-testid="gcode-viewer" /> }));
vi.mock("../machine-logs/MachineLogPanel", () => ({ MachineLogPanel: () => <div data-testid="machine-log" /> }));

import { GcodePage } from "./GcodePage";

function gcodeInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[accept*=".gcode"]');
  if (!input) throw new Error("G-code file input missing");
  return input;
}

describe("GcodePage Profile integration", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    parseFile.mockReset().mockResolvedValue(undefined);
    cancel.mockReset();
    reset.mockReset();
    localStorage.clear();
  });

  it("submits immutable options derived from the selected machine and material Profiles", async () => {
    render(<GcodePage featureFlags={{ profileSelectorReact: true, machineLogReact: true }} />);

    fireEvent.change(screen.getByLabelText("机器 Profile"), { target: { value: "delta" } });
    fireEvent.change(screen.getByLabelText("材料 Profile"), { target: { value: "PETG" } });
    const file = new File(["G90\nG1 X1 Y1 E1"], "part.gcode", { type: "text/plain" });
    fireEvent.change(gcodeInput(), { target: { files: [file] } });

    await waitFor(() =>
      expect(parseFile).toHaveBeenCalledWith(file, {
        bedSize: 260,
        densityG: 1.27,
        origin: "center",
        machineProfileId: "delta",
        materialProfileId: "PETG",
      })
    );

    fireEvent.change(screen.getByLabelText("材料 Profile"), { target: { value: "ABS" } });
    expect(parseFile).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/当前结果仍使用上次提交的参数/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "按当前参数重新解析" }));
    await waitFor(() =>
      expect(parseFile).toHaveBeenLastCalledWith(file, {
        bedSize: 260,
        densityG: 1.05,
        origin: "center",
        machineProfileId: "delta",
        materialProfileId: "ABS",
      })
    );
  });

  it("keeps the narrow rollback path with the original three parameter controls", () => {
    render(<GcodePage featureFlags={{ profileSelectorReact: false, machineLogReact: true }} />);

    expect(screen.queryByLabelText("机器 Profile")).not.toBeInTheDocument();
    expect(screen.getByLabelText("平台尺寸（mm）")).toHaveValue(256);
    expect(screen.getByLabelText("材料密度（g/cm³）")).toHaveValue(1.24);
    expect(screen.getByLabelText("坐标原点")).toHaveValue("corner");
  });
});
