import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorityAnalysisResponse } from "./gcode-authority";
import {
  cancelAuthorityJob,
  requestAuthorityJobAnalysis,
  resolveAuthorityJobApi,
  type AuthorityJobProgress,
} from "./gcode-job-client";

const JOB_ID = "1".repeat(32);
const OPTIONS = { densityG: 1.24, bedSize: 256, origin: "corner" as const };
const AUTHORITY: AuthorityAnalysisResponse = {
  schemaVersion: "1.0",
  engine: { version: "forgex-gcode-csharp/1", source: "gcode-import" },
  input: { sha256: "a".repeat(64), bytesRead: 20, linesRead: 2 },
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
  bounds: { minX: 0, maxX: 10, minY: 1, maxY: 11 },
  claims: {},
  pathTypeCounts: {},
  warnings: [],
};

function env(overrides: Partial<ImportMetaEnv> = {}): ImportMetaEnv {
  return {
    BASE_URL: "/",
    MODE: "test",
    DEV: false,
    PROD: false,
    SSR: false,
    VITE_API_BASE: "https://node.example.test/",
    VITE_NODE_API_KEY: "distributed-key",
    ...overrides,
  };
}

function accepted(links = true) {
  const base = `/api/v1/jobs/${JOB_ID}`;
  return {
    schemaVersion: "1.0",
    jobId: JOB_ID,
    status: "queued",
    input: { sha256: "a".repeat(64), bytesRead: 20, linesRead: 0 },
    links: {
      status: links ? base : "/api/v1/jobs/2/status",
      events: `${base}/events`,
      cancel: `${base}/cancel`,
    },
  };
}

function snapshot(status: "running" | "succeeded", progress: number, sequence: number) {
  return {
    schemaVersion: "1.0",
    id: JOB_ID,
    kind: "gcode-analysis",
    status,
    progress,
    phase: status === "succeeded" ? "completed" : "parse",
    sequence,
    createdAtUtc: "2026-08-11T00:00:00Z",
    startedAtUtc: "2026-08-11T00:00:01Z",
    finishedAtUtc: status === "succeeded" ? "2026-08-11T00:00:02Z" : null,
    input: { sha256: "a".repeat(64), bytesRead: 20, linesRead: 2 },
    engineVersion: "forgex-gcode-csharp/1",
    result: status === "succeeded" ? AUTHORITY : null,
    error: null,
    links: accepted().links,
  };
}

function sse(...frames: Array<{ id: number; status: string; progress: number; phase: string }>): Response {
  const body = frames
    .map(
      (frame) =>
        `id: ${frame.id}\nevent: ${frame.status === "succeeded" ? "terminal" : "progress"}\ndata: ${JSON.stringify({
          status: frame.status,
          progress: frame.progress,
          phase: frame.phase,
        })}\n\n`
    )
    .join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("G-code async authority job client", () => {
  it("enables jobs only for online dotnet mode", () => {
    expect(resolveAuthorityJobApi("dotnet", env())).toBe(true);
    expect(resolveAuthorityJobApi("dotnet", env({ VITE_GCODE_JOB_API: "0" }))).toBe(false);
    expect(resolveAuthorityJobApi("shadow", env())).toBe(false);
    expect(resolveAuthorityJobApi("browser", env())).toBe(false);
  });

  it("creates one raw-body job, consumes SSE, and validates the terminal snapshot", async () => {
    const progress: AuthorityJobProgress[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(accepted()), { status: 202 }))
      .mockResolvedValueOnce(
        sse(
          { id: 1, status: "running", progress: 0.5, phase: "parse" },
          { id: 2, status: "succeeded", progress: 1, phase: "completed" }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot("succeeded", 1, 2)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x".repeat(20)], "fixture.gcode");

    await expect(
      requestAuthorityJobAnalysis(file, OPTIONS, env(), new AbortController().signal, {
        onProgress: (value) => progress.push(value),
      })
    ).resolves.toEqual(AUTHORITY);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://node.example.test/api/v1/gcode/analyses?bedSizeMm=256&coordinateOrigin=corner&filamentDensityGPerCm3=1.24"
    );
    const creation = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(creation.headers);
    expect(creation).toMatchObject({ method: "POST", body: file, credentials: "same-origin" });
    expect(headers.get("Idempotency-Key")).toMatch(/^gcode-/);
    expect(headers.get("X-API-Key")).toBe("distributed-key");
    expect(progress.at(-1)).toMatchObject({ status: "succeeded", progress: 1, sequence: 2, transport: "sse" });
  });

  it("reconnects with Last-Event-ID and never creates a second job", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(accepted()), { status: 202 }))
      .mockResolvedValueOnce(sse({ id: 1, status: "running", progress: 0.25, phase: "parse" }))
      .mockResolvedValueOnce(sse({ id: 2, status: "succeeded", progress: 1, phase: "completed" }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot("succeeded", 1, 2)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await requestAuthorityJobAnalysis(
      new File(["x".repeat(20)], "fixture.gcode"),
      OPTIONS,
      env(),
      new AbortController().signal
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const reconnectHeaders = new Headers((fetchMock.mock.calls[2]?.[1] as RequestInit).headers);
    expect(reconnectHeaders.get("Last-Event-ID")).toBe("1");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/gcode/analyses?"))).toHaveLength(1);
  });

  it("polls the same job after SSE exhaustion", async () => {
    const progress: AuthorityJobProgress[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(accepted()), { status: 202 }))
      .mockRejectedValueOnce(new TypeError("stream disconnected"))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot("running", 0.75, 3)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot("succeeded", 1, 4)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await requestAuthorityJobAnalysis(
      new File(["x".repeat(20)], "fixture.gcode"),
      OPTIONS,
      env(),
      new AbortController().signal,
      { onProgress: (value) => progress.push(value) },
      { reconnectAttempts: 0, pollIntervalMs: 0 }
    );

    expect(progress.some((value) => value.transport === "poll" && value.progress === 0.75)).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/gcode/analyses?"))).toHaveLength(1);
  });

  it("retries a transport-failed creation with the same idempotency key", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(new Response(JSON.stringify(accepted()), { status: 202 }))
      .mockResolvedValueOnce(sse({ id: 1, status: "succeeded", progress: 1, phase: "completed" }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot("succeeded", 1, 1)), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await requestAuthorityJobAnalysis(
      new File(["x".repeat(20)], "fixture.gcode"),
      OPTIONS,
      env(),
      new AbortController().signal,
      {},
      { creationRetryDelayMs: 0 }
    );

    const first = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("Idempotency-Key");
    const second = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).get("Idempotency-Key");
    expect(first).toBe(second);
  });

  it("rejects server-controlled links and sends cancellation through Node credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(accepted(false)), { status: 202 })));
    await expect(
      requestAuthorityJobAnalysis(
        new File(["x".repeat(20)], "fixture.gcode"),
        OPTIONS,
        env(),
        new AbortController().signal,
        {},
        { creationRetryDelayMs: 0 }
      )
    ).rejects.toThrow("链接与 jobId 不一致");

    const cancelFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", cancelFetch);
    await cancelAuthorityJob(JOB_ID, env());
    expect(cancelFetch).toHaveBeenCalledWith(
      `https://node.example.test/api/v1/jobs/${JOB_ID}/cancel`,
      expect.objectContaining({ method: "POST", credentials: "same-origin" })
    );
    expect(new Headers((cancelFetch.mock.calls[0]?.[1] as RequestInit).headers).get("X-API-Key")).toBe(
      "distributed-key"
    );
  });
});
