// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GcodePreviewResult, GcodeWorkerRequest, GcodeWorkerResponse } from "./gcode-types";
import { useGcodeWorker } from "./useGcodeWorker";

const OPTIONS = { densityG: 1.24, bedSize: 256, origin: "corner" as const };

class FakeWorker {
  public static instances: FakeWorker[] = [];
  public onmessage: ((event: MessageEvent<GcodeWorkerResponse>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly postMessage = vi.fn();
  public readonly terminate = vi.fn();

  public constructor() {
    FakeWorker.instances.push(this);
  }
}

const RESULT: GcodePreviewResult = {
  fileName: "fixture.gcode",
  byteLength: 64,
  sha256: "a".repeat(64),
  totalLayers: 1,
  height: 0.2,
  stats: { extLenMm: 10, travelMm: 2, timeSec: 1, volumeCm3: 0.01, filamentM: 0.02, filamentG: 0.0124 },
  bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
  coordinateOrigin: "corner",
  warnings: [],
  claims: {},
  layerSummaries: [
    {
      index: 0,
      zMm: 0.2,
      pathCount: 1,
      extrusionLengthMm: 10,
      travelLengthMm: 2,
      timeSeconds: 1,
      filamentLengthMm: 20,
      pathTypeCounts: { perimeter: 1 },
    },
  ],
  layers: [{ index: 0, z: 0.2, sourcePathCount: 1, sourcePointCount: 2, paths: [] }],
  layerSegmentOffsets: [0, 0],
  sourceSegments: 1,
  previewSegments: 0,
  previewTruncated: true,
};

function activeWorker(): FakeWorker {
  const worker = FakeWorker.instances.at(-1);
  if (!worker) throw new Error("Fake Worker was not created");
  return worker;
}

describe("useGcodeWorker", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unsupported extensions before starting a worker", async () => {
    const { result, unmount } = renderHook(() => useGcodeWorker());

    await act(() => result.current.parseFile(new File(["fixture"], "fixture.txt"), OPTIONS));

    expect(result.current.state).toMatchObject({ status: "error", errorCode: "INVALID_EXTENSION" });
    expect(FakeWorker.instances).toHaveLength(0);
    unmount();
  });

  it("rejects files over the byte limit without reading them", async () => {
    const file = new File([], "large.gcode");
    Object.defineProperty(file, "size", { value: 64 * 1024 * 1024 + 1 });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    const { result, unmount } = renderHook(() => useGcodeWorker());

    await act(() => result.current.parseFile(file, OPTIONS));

    expect(result.current.state).toMatchObject({ status: "error", errorCode: "FILE_TOO_LARGE" });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
    unmount();
  });

  it("posts the File itself, filters stale events, clamps progress and supports hard cancellation", async () => {
    const file = new File(["G1 X1 Y1 E1"], "fixture.gcode");
    const { result, unmount } = renderHook(() => useGcodeWorker());

    await act(() => result.current.parseFile(file, OPTIONS));
    const worker = activeWorker();
    const request = worker.postMessage.mock.calls[0]?.[0] as GcodeWorkerRequest;
    expect(request.file).toBe(file);
    expect(request.limits.maxPreviewSegments).toBe(400_000);

    act(() => {
      worker.onmessage?.(
        new MessageEvent("message", {
          data: { type: "progress", requestId: "stale", phase: "parse", progress: 0.5, stage: "stale" },
        })
      );
    });
    expect(result.current.state.status).toBe("reading");

    act(() => {
      worker.onmessage?.(
        new MessageEvent("message", {
          data: { type: "progress", requestId: request.requestId, phase: "parse", progress: 4, stage: "parse" },
        })
      );
    });
    expect(result.current.state).toMatchObject({ status: "parsing", progress: 1, stage: "parse" });

    act(() => result.current.cancel());
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe("cancelled");
    unmount();
  });

  it("accepts only the active result and terminates the completed worker", async () => {
    const { result, unmount } = renderHook(() => useGcodeWorker());

    await act(() => result.current.parseFile(new File(["G1 X1 Y1 E1"], "fixture.gcode"), OPTIONS));
    const worker = activeWorker();
    const request = worker.postMessage.mock.calls[0]?.[0] as GcodeWorkerRequest;
    act(() => {
      worker.onmessage?.(
        new MessageEvent("message", {
          data: { type: "result", requestId: request.requestId, result: RESULT },
        })
      );
    });

    expect(result.current.state).toMatchObject({ status: "done", result: RESULT, progress: 1 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    unmount();
  });
});
