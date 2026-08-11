// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulatorWorkerRequest, SimulatorWorkerResponse } from "./simulator-types";

interface FakeWorkerInstance {
  onmessage: ((event: MessageEvent<SimulatorWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminated: boolean;
  posted: SimulatorWorkerRequest[];
  terminate(): void;
  postMessage(message: SimulatorWorkerRequest): void;
  emit(message: SimulatorWorkerResponse): void;
}

const workerInstances = vi.hoisted(() => [] as FakeWorkerInstance[]);

vi.mock("../../workers/simulator.worker?worker&inline", () => ({
  default: class FakeWorker implements FakeWorkerInstance {
    public onmessage: FakeWorkerInstance["onmessage"] = null;
    public onerror: FakeWorkerInstance["onerror"] = null;
    public terminated = false;
    public posted: SimulatorWorkerRequest[] = [];

    public constructor() {
      workerInstances.push(this);
    }

    public terminate(): void {
      this.terminated = true;
    }

    public postMessage(message: SimulatorWorkerRequest): void {
      this.posted.push(message);
    }

    public emit(message: SimulatorWorkerResponse): void {
      this.onmessage?.({ data: message } as MessageEvent<SimulatorWorkerResponse>);
    }
  },
}));

import { legacyQuickSimulator } from "../../legacy/simulator-adapter.js";
import { standardSimulationInput } from "./simulator-test-fixtures";
import { useQuickSimulation } from "./useQuickSimulation";

describe("useQuickSimulation", () => {
  beforeEach(() => {
    workerInstances.length = 0;
  });

  afterEach(cleanup);

  it("accepts progress and result only from the active job", () => {
    const { result } = renderHook(() => useQuickSimulation());
    act(() => result.current.run(standardSimulationInput()));
    const worker = workerInstances[0]!;
    const request = worker.posted[0]!;
    expect(request.type).toBe("simulate");
    const jobId = request.jobId;

    act(() => worker.emit({ type: "progress", jobId: "stale-job", phase: "simulate", progress: 0.9, stage: "旧" }));
    expect(result.current.state.progress).toBe(0.03);

    act(() => worker.emit({ type: "progress", jobId, phase: "simulate", progress: 0.5, stage: "切片中" }));
    expect(result.current.state).toMatchObject({ status: "running", progress: 0.5, stage: "切片中" });

    const preview = legacyQuickSimulator.simulate(standardSimulationInput());
    act(() => worker.emit({ type: "result", jobId, result: preview }));
    expect(worker.terminated).toBe(true);
    expect(result.current.state).toMatchObject({ status: "success", progress: 1, result: preview });
  });

  it("terminates the previous Worker and ignores its late response", () => {
    const { result } = renderHook(() => useQuickSimulation());
    act(() => result.current.run(standardSimulationInput()));
    const first = workerInstances[0]!;
    const firstRequest = first.posted[0]!;
    act(() => result.current.run(standardSimulationInput({ layerHeight: 0.28 })));
    const second = workerInstances[1]!;
    expect(first.terminated).toBe(true);

    act(() =>
      first.emit({
        type: "result",
        jobId: firstRequest.jobId,
        result: legacyQuickSimulator.simulate(standardSimulationInput()),
      })
    );
    expect(result.current.state.status).toBe("running");
    expect(second.terminated).toBe(false);
  });

  it("cancels, retains the last result when stale, and terminates on unmount", () => {
    const { result, unmount } = renderHook(() => useQuickSimulation());
    act(() => result.current.run(standardSimulationInput()));
    const worker = workerInstances[0]!;
    const request = worker.posted[0]!;
    const preview = legacyQuickSimulator.simulate(standardSimulationInput());
    act(() => worker.emit({ type: "result", jobId: request.jobId, result: preview }));
    act(() => result.current.markStale());
    expect(result.current.state).toMatchObject({ status: "stale", result: preview });

    act(() => result.current.run(standardSimulationInput()));
    const active = workerInstances[1]!;
    act(() => result.current.cancel());
    expect(active.terminated).toBe(true);
    expect(result.current.state).toMatchObject({ status: "cancelled", result: preview });

    act(() => result.current.run(standardSimulationInput()));
    const onUnmount = workerInstances[2]!;
    unmount();
    expect(onUnmount.terminated).toBe(true);
  });

  it("fails invalid input before creating a Worker", () => {
    const { result } = renderHook(() => useQuickSimulation());
    const invalid = {
      ...standardSimulationInput(),
      settings: { ...standardSimulationInput().settings, speed: Number.NaN },
    };
    act(() => result.current.run(invalid));
    expect(workerInstances).toHaveLength(0);
    expect(result.current.state).toMatchObject({ status: "error", errorCode: "INVALID_INPUT" });
  });
});
