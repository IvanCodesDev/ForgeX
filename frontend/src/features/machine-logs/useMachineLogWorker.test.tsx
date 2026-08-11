// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GcodeReconciliationPlan,
  MachineLogImportResult,
  MachineLogWorkerRequest,
  MachineLogWorkerResponse,
} from "./machine-log-types";
import { useMachineLogWorker } from "./useMachineLogWorker";

const PLAN: GcodeReconciliationPlan = {
  gcodeSha256: "a".repeat(64),
  provenance: "browser-preview",
  engineVersion: "legacy-browser-preview",
  totalLayers: 2,
  estimatedTimeSec: 120,
  filamentMm: 300,
  filamentG: 0.9,
};

const IMPORT_RESULT: MachineLogImportResult = {
  file: { name: "fixture.json", byteLength: 100, sha256: "c".repeat(64) },
  log: {
    name: "fixture.json",
    format: "forgex-machine-log",
    jobId: "JOB-1",
    machineId: "FX-01",
    firmware: "Klipper",
    slicer: "OrcaSlicer",
    gcodeSha256: PLAN.gcodeSha256,
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
    verified: true,
    status: "verified",
    expected: PLAN.gcodeSha256,
    actual: PLAN.gcodeSha256,
    message: "verified",
  },
  comparisons: [],
  plan: PLAN,
};

class FakeWorker {
  public static instances: FakeWorker[] = [];
  public onmessage: ((event: MessageEvent<MachineLogWorkerResponse>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly postMessage = vi.fn();
  public readonly terminate = vi.fn();

  public constructor() {
    FakeWorker.instances.push(this);
  }
}

function activeWorker(): FakeWorker {
  const worker = FakeWorker.instances.at(-1);
  if (!worker) throw new Error("Fake Worker was not created");
  return worker;
}

function emit(worker: FakeWorker, message: MachineLogWorkerResponse): void {
  worker.onmessage?.(new MessageEvent("message", { data: message }));
}

describe("useMachineLogWorker", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  it("posts the original File, ignores stale jobs and supports hard cancellation", () => {
    const file = new File(["{}"], "fixture.json", { type: "application/json" });
    const { result, unmount } = renderHook(() => useMachineLogWorker(1));

    act(() => result.current.parseFile(file, PLAN));
    const worker = activeWorker();
    const request = worker.postMessage.mock.calls[0]?.[0] as MachineLogWorkerRequest;
    expect(request.file).toBe(file);
    expect(request.plan).toBe(PLAN);

    act(() =>
      emit(worker, {
        type: "progress",
        requestId: "stale-job",
        phase: "parse",
        progress: 0.8,
        stage: "stale",
      })
    );
    expect(result.current.state).toMatchObject({ status: "reading", stage: "读取真机日志" });

    act(() => result.current.cancel());
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe("cancelled");
    unmount();
  });

  it("clears a completed log when the G-code revision changes", () => {
    const { result, rerender, unmount } = renderHook(
      ({ revision }: { revision: number }) => useMachineLogWorker(revision),
      { initialProps: { revision: 1 } }
    );

    act(() => result.current.parseFile(new File(["{}"], "fixture.json"), PLAN));
    const worker = activeWorker();
    const request = worker.postMessage.mock.calls[0]?.[0] as MachineLogWorkerRequest;
    act(() => emit(worker, { type: "result", requestId: request.requestId, result: IMPORT_RESULT }));
    expect(result.current.state).toMatchObject({ status: "done", result: IMPORT_RESULT });

    rerender({ revision: 2 });
    expect(result.current.state).toMatchObject({ status: "idle", result: null });
    unmount();
  });

  it("rejects unsupported extensions and raw files over 20 MiB before worker startup", () => {
    const { result, unmount } = renderHook(() => useMachineLogWorker(1));

    act(() => result.current.parseFile(new File(["x"], "fixture.txt"), PLAN));
    expect(result.current.state).toMatchObject({ status: "error", errorCode: "INVALID_EXTENSION" });

    const large = new File([], "large.json");
    Object.defineProperty(large, "size", { value: 20 * 1024 * 1024 + 1 });
    act(() => result.current.parseFile(large, PLAN));
    expect(result.current.state).toMatchObject({ status: "error", errorCode: "FILE_TOO_LARGE" });
    expect(FakeWorker.instances).toHaveLength(0);
    unmount();
  });
});
