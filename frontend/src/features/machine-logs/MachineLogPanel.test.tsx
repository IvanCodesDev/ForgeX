// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GcodeReconciliationPlan, MachineLogImportResult } from "./machine-log-types";
import { MachineLogPanel } from "./MachineLogPanel";
import { useMachineLogWorker } from "./useMachineLogWorker";

vi.mock("./useMachineLogWorker", () => ({ useMachineLogWorker: vi.fn() }));

const PLAN: GcodeReconciliationPlan = {
  gcodeSha256: "a".repeat(64),
  provenance: "dotnet-authority",
  engineVersion: "1.0.0",
  totalLayers: 2,
  estimatedTimeSec: 120,
  filamentMm: 300,
  filamentG: 0.9,
};

function imported(status: "verified" | "missing" | "mismatch"): MachineLogImportResult {
  const verified = status === "verified";
  return {
    file: { name: "fixture.json", byteLength: 120, sha256: "c".repeat(64) },
    log: {
      name: "fixture.json",
      format: "forgex-machine-log",
      jobId: "JOB-1",
      machineId: "FX-01",
      firmware: "Klipper",
      slicer: "OrcaSlicer",
      gcodeSha256: status === "missing" ? "" : status === "mismatch" ? "b".repeat(64) : PLAN.gcodeSha256,
      actualTimeSec: 120,
      filamentMm: 300,
      filamentG: 0.9,
      completedLayers: 2,
      status: "success",
      samples: [],
      warnings: [],
      source: "machine-log",
    },
    binding: {
      verified,
      status,
      expected: status === "missing" ? "" : status === "mismatch" ? "b".repeat(64) : PLAN.gcodeSha256,
      actual: PLAN.gcodeSha256,
      message: verified ? "摘要已验证" : "摘要未建立强绑定",
    },
    comparisons: verified
      ? [
          {
            metric: "durationSec",
            name: "任务时长",
            planned: 120,
            actual: 120,
            unit: "秒",
            relDiff: 0,
            agrees: true,
            note: "legacy note",
          },
        ]
      : [],
    plan: PLAN,
  };
}

function workerState(result: MachineLogImportResult | null) {
  return {
    state: {
      status: result ? ("done" as const) : ("idle" as const),
      progress: result ? 1 : 0,
      stage: result ? "日志解析完成" : "等待真机日志",
      result,
      error: "",
      errorCode: "",
    },
    parseFile: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
  };
}

describe("MachineLogPanel", () => {
  beforeEach(() => {
    vi.mocked(useMachineLogWorker).mockReturnValue(workerState(null));
  });

  afterEach(cleanup);

  it("keeps log import disabled until a SHA-backed G-code plan is ready", () => {
    render(<MachineLogPanel plan={null} gcodeRevision={1} disabledReason="等待 G-code 摘要" />);

    expect((screen.getByLabelText("选择真机日志") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("等待 G-code 摘要")).toBeTruthy();
  });

  it("renders reconciliation only for a verified binding", () => {
    vi.mocked(useMachineLogWorker).mockReturnValue(workerState(imported("verified")));
    render(<MachineLogPanel plan={PLAN} gcodeRevision={1} disabledReason="" />);

    expect(screen.getByRole("table", { name: "真机日志计划与实测对账" })).toBeTruthy();
    expect(screen.getByText("任务时长")).toBeTruthy();
    expect(screen.getByText(/C# 权威/)).toBeTruthy();
  });

  it.each(["missing", "mismatch"] as const)("shows %s binding evidence without a reconciliation table", (status) => {
    vi.mocked(useMachineLogWorker).mockReturnValue(workerState(imported(status)));
    render(<MachineLogPanel plan={PLAN} gcodeRevision={1} disabledReason="" />);

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("未生成计划/实测对账");
  });
});
