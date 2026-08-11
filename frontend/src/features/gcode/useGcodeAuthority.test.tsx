// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorityAnalysisResponse } from "./gcode-authority";
import type { GcodePreviewResult } from "./gcode-types";

const requestAuthorityAnalysis = vi.hoisted(() => vi.fn());
const requestAuthorityJobAnalysis = vi.hoisted(() => vi.fn());
const cancelAuthorityJob = vi.hoisted(() => vi.fn());

vi.mock("./gcode-authority", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gcode-authority")>();
  return { ...actual, requestAuthorityAnalysis };
});

vi.mock("./gcode-job-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gcode-job-client")>();
  return { ...actual, requestAuthorityJobAnalysis, cancelAuthorityJob };
});

import { AUTHORITY_TIMEOUT_MS, useGcodeAuthority } from "./useGcodeAuthority";

const OPTIONS = { densityG: 1.24, bedSize: 256, origin: "corner" as const };
const PREVIEW: GcodePreviewResult = {
  fileName: "fixture.gcode",
  byteLength: 20,
  sha256: "a".repeat(64),
  totalLayers: 2,
  height: 0.4,
  stats: { extLenMm: 10, travelMm: 3, timeSec: 2, volumeCm3: 0.1, filamentM: 0.4, filamentG: 0.124 },
  bounds: { minX: 0, maxX: 10, minY: 1, maxY: 11 },
  coordinateOrigin: "corner",
  warnings: [],
  claims: {},
  layers: [],
  layerSegmentOffsets: [0],
  sourceSegments: 0,
  previewSegments: 0,
  previewTruncated: false,
};
const AUTHORITY: AuthorityAnalysisResponse = {
  schemaVersion: "1.0",
  engine: { version: "forgex-gcode-csharp/1", source: "gcode-import" },
  input: { sha256: PREVIEW.sha256, bytesRead: 20, linesRead: 2 },
  parameters: { bedSizeMm: 256, coordinateOrigin: "corner", filamentDensityGPerCm3: 1.24 },
  summary: {
    totalLayers: 2,
    heightMm: 0.4,
    extrusionLengthMm: 10,
    travelLengthMm: 3,
    estimatedTimeSeconds: 2,
    volumeCm3: 0.1,
    filamentLengthM: 0.4,
    filamentMassG: 0.124,
  },
  bounds: PREVIEW.bounds,
  claims: {},
  pathTypeCounts: {},
  warnings: [],
};

describe("useGcodeAuthority", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_GCODE_AUTHORITY", "dotnet");
    vi.stubEnv("VITE_GCODE_JOB_API", "0");
    requestAuthorityAnalysis.mockReset();
    requestAuthorityJobAnalysis.mockReset();
    cancelAuthorityJob.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("starts the C# request as soon as a file exists and computes diff when preview arrives later", async () => {
    let resolveRequest: ((value: AuthorityAnalysisResponse) => void) | undefined;
    requestAuthorityAnalysis.mockImplementation(
      () => new Promise<AuthorityAnalysisResponse>((resolve) => (resolveRequest = resolve))
    );
    const file = new File(["x".repeat(20)], "fixture.gcode");
    const { result, rerender, unmount } = renderHook(
      ({ preview }: { preview: GcodePreviewResult | null }) => useGcodeAuthority(file, OPTIONS, preview),
      { initialProps: { preview: null as GcodePreviewResult | null } }
    );

    expect(requestAuthorityAnalysis).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({ status: "running", result: null, diff: null });

    await act(async () => resolveRequest?.(AUTHORITY));
    expect(result.current).toMatchObject({ status: "done", result: AUTHORITY, diff: null });

    rerender({ preview: PREVIEW });
    expect(result.current.diff).toMatchObject({ pass: true, sha256Matches: true });
    unmount();
  });

  it("exposes hard cancellation for an in-flight authority request", () => {
    let requestSignal: AbortSignal | undefined;
    requestAuthorityAnalysis.mockImplementation(
      (_file: File, _options: unknown, _env: ImportMetaEnv, signal: AbortSignal) => {
        requestSignal = signal;
        return new Promise<AuthorityAnalysisResponse>(() => undefined);
      }
    );
    const file = new File(["x".repeat(20)], "fixture.gcode");
    const { result, unmount } = renderHook(() => useGcodeAuthority(file, OPTIONS, null));

    act(() => result.current.cancel());

    expect(requestSignal?.aborted).toBe(true);
    expect(result.current).toMatchObject({ status: "error", result: null, diff: null });
    expect(result.current.error).toContain("已取消");
    unmount();
  });

  it("tracks an async job lifecycle and exposes SSE progress without waiting for browser preview", async () => {
    vi.stubEnv("VITE_GCODE_JOB_API", "1");
    let resolveRequest: ((value: AuthorityAnalysisResponse) => void) | undefined;
    requestAuthorityJobAnalysis.mockImplementation(
      (
        _file: File,
        _options: unknown,
        _env: ImportMetaEnv,
        _signal: AbortSignal,
        callbacks: {
          onAccepted?: (jobId: string) => void;
          onProgress?: (value: {
            jobId: string;
            status: "running";
            progress: number;
            phase: string;
            sequence: number;
            transport: "sse";
          }) => void;
        }
      ) => {
        callbacks.onAccepted?.("1".repeat(32));
        callbacks.onProgress?.({
          jobId: "1".repeat(32),
          status: "running",
          progress: 0.6,
          phase: "parse",
          sequence: 2,
          transport: "sse",
        });
        return new Promise<AuthorityAnalysisResponse>((resolve) => (resolveRequest = resolve));
      }
    );
    const file = new File(["x".repeat(20)], "fixture.gcode");
    const { result, unmount } = renderHook(() => useGcodeAuthority(file, OPTIONS, null));

    expect(requestAuthorityJobAnalysis).toHaveBeenCalledOnce();
    expect(requestAuthorityAnalysis).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      status: "running",
      jobId: "1".repeat(32),
      progress: 0.6,
      phase: "parse",
      transport: "sse",
    });

    await act(async () => resolveRequest?.(AUTHORITY));
    expect(result.current).toMatchObject({ status: "done", result: AUTHORITY, progress: 1, phase: "succeeded" });
    unmount();
    expect(cancelAuthorityJob).not.toHaveBeenCalled();
  });

  it("cancels the accepted server job as well as the browser request", async () => {
    vi.stubEnv("VITE_GCODE_JOB_API", "1");
    let requestSignal: AbortSignal | undefined;
    requestAuthorityJobAnalysis.mockImplementation(
      (
        _file: File,
        _options: unknown,
        _env: ImportMetaEnv,
        signal: AbortSignal,
        callbacks: { onAccepted?: (jobId: string) => void }
      ) => {
        requestSignal = signal;
        callbacks.onAccepted?.("2".repeat(32));
        return new Promise<AuthorityAnalysisResponse>(() => undefined);
      }
    );
    const file = new File(["x".repeat(20)], "fixture.gcode");
    const { result, unmount } = renderHook(() => useGcodeAuthority(file, OPTIONS, null));

    act(() => result.current.cancel());

    expect(requestSignal?.aborted).toBe(true);
    expect(cancelAuthorityJob).toHaveBeenCalledWith("2".repeat(32), expect.any(Object));
    expect(result.current).toMatchObject({ status: "error", jobId: "2".repeat(32), phase: "cancelled" });
    unmount();
  });

  it("aborts an authority request after the configured timeout", () => {
    expect(AUTHORITY_TIMEOUT_MS).toBe(120_000);
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    requestAuthorityAnalysis.mockImplementation(
      (_file: File, _options: unknown, _env: ImportMetaEnv, signal: AbortSignal) => {
        requestSignal = signal;
        return new Promise<AuthorityAnalysisResponse>(() => undefined);
      }
    );
    const file = new File(["x".repeat(20)], "fixture.gcode");
    const { result, unmount } = renderHook(() => useGcodeAuthority(file, OPTIONS, null, 50));

    act(() => vi.advanceTimersByTime(50));

    expect(requestSignal?.aborted).toBe(true);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("1 秒");
    unmount();
  });
});
