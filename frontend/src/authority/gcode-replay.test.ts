import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorityAnalysisResponse } from "./gcode-authority";
import {
  deriveLayerPlan,
  requestLayerTimeline,
  requestReplayCheckpoint,
  validateLayerTimeline,
  validateReplayCheckpoint,
} from "./gcode-replay";

const id = "a".repeat(32);
const source = {
  input: { sha256: "b".repeat(64) },
  profile: { fingerprint: "c".repeat(64) },
  engine: { version: "1.5.0" },
  summary: { totalLayers: 3, estimatedTimeSeconds: 7, filamentLengthM: 0.005, filamentMassG: 0.1 },
  layers: [
    { index: 0, sourceOrder: 1, zMm: 0.2, pathCount: 2, timeSeconds: 2, filamentLengthMm: 2 },
    { index: 1, sourceOrder: 0, zMm: 0.4, pathCount: 1, timeSeconds: 1, filamentLengthMm: 1 },
    { index: 2, sourceOrder: 2, zMm: 0.4, pathCount: 3, timeSeconds: 3, filamentLengthMm: 3 },
  ],
} as unknown as AuthorityAnalysisResponse;
const plan = deriveLayerPlan(source);
const common = {
  schemaVersion: "1.0",
  modelVersion: "forgex-gcode-layer-timeline/1",
  fingerprint: "f".repeat(64),
  basis: {
    jobId: id,
    inputSha256: source.input.sha256,
    profileFingerprint: source.profile.fingerprint,
    analysisEngineVersion: source.engine.version,
    sourceMotionSeconds: 7,
    netFilamentLengthM: 0.005,
    netFilamentMassG: 0.1,
  },
};
const page = () => ({
  ...structuredClone(common),
  leadingMotionSeconds: 1,
  totalSeconds: 7,
  totalPositiveExtrusionMm: 6,
  totalLayers: 3,
  offset: 0,
  limit: 1,
  nextOffset: 1,
  layers: [structuredClone(plan.layers[0]!)],
  warnings: ["运动时间"],
});
const checkpoint = () => ({
  ...structuredClone(common),
  elapsedSeconds: 1.5,
  remainingSeconds: 5.5,
  phase: "layer",
  completedLayerCount: 0,
  completedPositiveExtrusionMm: 0,
  activeLayer: structuredClone(plan.layers[0]!),
  layerElapsedSeconds: 0.5,
  layerFraction: 0.5,
});
const env = {
  BASE_URL: "/",
  MODE: "test",
  DEV: true,
  PROD: false,
  SSR: false,
  VITE_API_BASE: "",
  VITE_NODE_API_KEY: "replay-key",
} as ImportMetaEnv;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("source-bound layer replay", () => {
  it("restores source order across descending and repeated heights", () => {
    expect(plan.layers.map((l) => l.layerIndex)).toEqual([1, 0, 2]);
    expect(plan.layers.map((l) => [l.startSeconds, l.endSeconds])).toEqual([
      [1, 2],
      [2, 4],
      [4, 7],
    ]);
    expect(validateLayerTimeline(page(), id, source, 0, 1).layers[0]?.layerIndex).toBe(1);
    expect(validateReplayCheckpoint(checkpoint(), id, source, 1.5).completedPositiveExtrusionMm).toBe(0);
  });
  it.each([
    "jobId",
    "inputSha256",
    "profileFingerprint",
    "analysisEngineVersion",
    "sourceMotionSeconds",
    "netFilamentLengthM",
    "netFilamentMassG",
  ])("rejects forged basis %s", (key) => {
    const value = page();
    Object.assign(value.basis, { [key]: "forged" });
    expect(() => validateLayerTimeline(value, id, source, 0, 1)).toThrow();
  });
  it.each([
    "sequence",
    "layerIndex",
    "zMm",
    "startSeconds",
    "endSeconds",
    "durationSeconds",
    "pathCount",
    "positiveExtrusionMm",
    "completedPositiveExtrusionMm",
  ])("rejects forged layer %s", (key) => {
    const value = page();
    Object.assign(value.layers[0]!, { [key]: 999 });
    expect(() => validateLayerTimeline(value, id, source, 0, 1)).toThrow();
  });
  it.each([
    "offset",
    "limit",
    "nextOffset",
    "totalLayers",
    "leadingMotionSeconds",
    "totalSeconds",
    "totalPositiveExtrusionMm",
    "schemaVersion",
    "modelVersion",
    "fingerprint",
  ])("rejects forged page %s", (key) => {
    expect(() => validateLayerTimeline({ ...page(), [key]: "bad" }, id, source, 0, 1)).toThrow();
  });
  it.each([
    "elapsedSeconds",
    "remainingSeconds",
    "phase",
    "completedLayerCount",
    "completedPositiveExtrusionMm",
    "layerElapsedSeconds",
    "layerFraction",
    "activeLayer",
  ])("rejects forged checkpoint %s", (key) => {
    expect(() => validateReplayCheckpoint({ ...checkpoint(), [key]: null }, id, source, 1.5)).toThrow();
  });
  it("checks empty active fields, exact boundaries and plan completion", () => {
    expect(
      validateReplayCheckpoint(
        {
          ...common,
          elapsedSeconds: 0,
          remainingSeconds: 7,
          phase: "initial-travel",
          completedLayerCount: 0,
          completedPositiveExtrusionMm: 0,
          activeLayer: null,
          layerElapsedSeconds: null,
          layerFraction: null,
        },
        id,
        source,
        0
      ).phase
    ).toBe("initial-travel");
    expect(
      validateReplayCheckpoint(
        {
          ...checkpoint(),
          elapsedSeconds: 2,
          remainingSeconds: 5,
          completedLayerCount: 1,
          completedPositiveExtrusionMm: 1,
          activeLayer: plan.layers[1],
          layerElapsedSeconds: 0,
          layerFraction: 0,
        },
        id,
        source,
        2
      ).completedLayerCount
    ).toBe(1);
    expect(
      validateReplayCheckpoint(
        {
          ...common,
          elapsedSeconds: 7,
          remainingSeconds: 0,
          phase: "completed",
          completedLayerCount: 3,
          completedPositiveExtrusionMm: 6,
          activeLayer: null,
          layerElapsedSeconds: null,
          layerFraction: null,
        },
        id,
        source,
        7
      ).phase
    ).toBe("completed");
    expect(() => validateReplayCheckpoint(checkpoint(), id, source, 1.5, "e".repeat(64))).toThrow();
  });
  it("rejects old, partial, duplicate chronology and impossible aggregate time", () => {
    for (const order of [null, undefined, 0, -1, 1.5]) {
      const changed = {
        ...source,
        layers: source.layers.map((l) => ({ ...l, sourceOrder: order })),
      } as AuthorityAnalysisResponse;
      expect(() => deriveLayerPlan(changed)).toThrow();
    }
    expect(() => deriveLayerPlan({ ...source, summary: { ...source.summary, estimatedTimeSeconds: 0 } })).toThrow();
  });
  it("uses scoped API credentials and validates the returned page", async () => {
    const value = { ...page(), limit: 50, nextOffset: null, layers: plan.layers };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(value)));
    vi.stubGlobal("fetch", fetcher);
    expect((await requestLayerTimeline(id, source, 0, env, new AbortController().signal)).layers).toHaveLength(3);
    expect(fetcher.mock.calls[0]?.[0]).toContain("/layer-timeline?offset=0&limit=50");
    expect(new Headers(fetcher.mock.calls[0]?.[1].headers).get("x-api-key")).toBe("replay-key");
  });
  it("does not send out-of-range times or already cancelled requests", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      requestReplayCheckpoint(id, source, 8, undefined, env, new AbortController().signal)
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(requestLayerTimeline(id, source, 0, env, controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("propagates cancellation and enforces a request deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          })
      )
    );
    const pending = requestLayerTimeline(id, source, 0, env, new AbortController().signal);
    const failed = expect(pending).rejects.toThrow("层计划请求超时");
    await vi.advanceTimersByTimeAsync(15000);
    await failed;
  });
});
