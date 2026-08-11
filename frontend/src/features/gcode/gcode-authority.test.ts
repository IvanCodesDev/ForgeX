import { describe, expect, it, vi } from "vitest";
import type { GcodePreviewResult } from "./gcode-types";
import {
  compareAuthority,
  requestAuthorityAnalysis,
  resolveAuthorityMode,
  selectEffectiveSummary,
  type AuthorityAnalysisResponse,
} from "./gcode-authority";

function env(
  authority?: string,
  apiBase?: string,
  auth: { apiKey?: string; bearer?: string } = {},
  deprecatedAuthorityBase?: string
): ImportMetaEnv {
  return {
    BASE_URL: "/",
    MODE: "test",
    DEV: false,
    PROD: false,
    SSR: false,
    ...(authority ? { VITE_GCODE_AUTHORITY: authority as "browser" | "shadow" | "dotnet" } : {}),
    ...(apiBase ? { VITE_API_BASE: apiBase } : {}),
    ...(auth.apiKey ? { VITE_NODE_API_KEY: auth.apiKey } : {}),
    ...(auth.bearer ? { VITE_NODE_BEARER: auth.bearer } : {}),
    ...(deprecatedAuthorityBase ? { VITE_AUTHORITY_API_BASE: deprecatedAuthorityBase } : {}),
  };
}

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
  pathTypeCounts: { perimeter: 1 },
  warnings: [],
};

describe("G-code authority adapter", () => {
  it("defaults invalid or absent authority values to browser rollback mode", () => {
    expect(resolveAuthorityMode(env())).toBe("browser");
    expect(resolveAuthorityMode(env("unexpected"))).toBe("browser");
    expect(resolveAuthorityMode(env("shadow"))).toBe("shadow");
    expect(resolveAuthorityMode(env("dotnet"))).toBe("dotnet");
    expect(resolveAuthorityMode(env("dotnet"), { protocol: "file:" })).toBe("browser");
    expect(resolveAuthorityMode(env("dotnet", "offline"), { protocol: "https:" })).toBe("browser");
  });

  it("accepts an exact shadow result and exposes field-level mismatches", () => {
    expect(compareAuthority(PREVIEW, AUTHORITY)).toMatchObject({
      pass: true,
      engineMatches: true,
      contractMatches: true,
      inputMatches: true,
      parametersMatch: true,
      sha256Matches: true,
    });
    const changed: AuthorityAnalysisResponse = {
      ...AUTHORITY,
      input: { ...AUTHORITY.input, sha256: "b".repeat(64) },
      summary: { ...AUTHORITY.summary, totalLayers: 3 },
    };
    const diff = compareAuthority(PREVIEW, changed);
    expect(diff.pass).toBe(false);
    expect(diff.sha256Matches).toBe(false);
    expect(diff.fields.find((field) => field.field === "totalLayers")?.pass).toBe(false);
  });

  it("fails comparison when the contract, byte count, or submitted parameters drift", () => {
    const changed = {
      ...AUTHORITY,
      schemaVersion: "2.0",
      input: { ...AUTHORITY.input, bytesRead: PREVIEW.byteLength + 1 },
      parameters: { ...AUTHORITY.parameters, bedSizeMm: 300 },
    } as unknown as AuthorityAnalysisResponse;

    expect(compareAuthority(PREVIEW, changed, { bedSize: 256, densityG: 1.24, origin: "corner" })).toMatchObject({
      pass: false,
      contractMatches: false,
      inputMatches: false,
      parametersMatch: false,
    });
  });

  it("rejects an unexpected authority engine identity before switching primary values", () => {
    const wrongEngine: AuthorityAnalysisResponse = {
      ...AUTHORITY,
      engine: { version: "1.0.0", source: "unexpected-route" },
    };

    expect(compareAuthority(PREVIEW, wrongEngine, { bedSize: 256, densityG: 1.24, origin: "corner" })).toMatchObject({
      pass: false,
      engineMatches: false,
    });
    expect(selectEffectiveSummary("dotnet", "done", PREVIEW, wrongEngine)).toMatchObject({
      provenance: "browser-preview",
    });
  });

  it("keeps browser and shadow primary summaries on the Worker preview", () => {
    const changedAuthority: AuthorityAnalysisResponse = {
      ...AUTHORITY,
      summary: { ...AUTHORITY.summary, totalLayers: 99, heightMm: 9.9 },
      bounds: { minX: -9, maxX: 99, minY: -8, maxY: 98 },
    };

    expect(selectEffectiveSummary("browser", "idle", PREVIEW, null)).toMatchObject({
      provenance: "browser-preview",
      totalLayers: PREVIEW.totalLayers,
      heightMm: PREVIEW.height,
      bounds: PREVIEW.bounds,
    });
    expect(selectEffectiveSummary("shadow", "done", PREVIEW, changedAuthority)).toMatchObject({
      provenance: "browser-preview",
      totalLayers: PREVIEW.totalLayers,
      heightMm: PREVIEW.height,
      bounds: PREVIEW.bounds,
    });
  });

  it("switches dotnet primary values only after a successful authority response", () => {
    const changedAuthority: AuthorityAnalysisResponse = {
      ...AUTHORITY,
      input: { ...AUTHORITY.input, sha256: "c".repeat(64) },
      summary: { ...AUTHORITY.summary, totalLayers: 9, heightMm: 1.8 },
      bounds: { minX: -1, maxX: 12, minY: -2, maxY: 13 },
    };

    expect(selectEffectiveSummary("dotnet", "done", PREVIEW, changedAuthority)).toMatchObject({
      provenance: "dotnet-authority",
      totalLayers: 9,
      heightMm: 1.8,
      bounds: changedAuthority.bounds,
      sha256: changedAuthority.input.sha256,
    });
    expect(selectEffectiveSummary("dotnet", "done", null, changedAuthority)).toMatchObject({
      provenance: "dotnet-authority",
      totalLayers: 9,
      bounds: changedAuthority.bounds,
    });
    expect(selectEffectiveSummary("dotnet", "running", PREVIEW, changedAuthority)).toMatchObject({
      provenance: "browser-preview",
      totalLayers: PREVIEW.totalLayers,
      bounds: PREVIEW.bounds,
    });
    expect(selectEffectiveSummary("dotnet", "error", PREVIEW, changedAuthority)).toMatchObject({
      provenance: "browser-preview",
      totalLayers: PREVIEW.totalLayers,
      bounds: PREVIEW.bounds,
    });
  });

  it("posts the raw File with invariant query parameters and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(AUTHORITY), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x".repeat(20)], "fixture.gcode");
    const controller = new AbortController();

    await expect(
      requestAuthorityAnalysis(
        file,
        { bedSize: 256, densityG: 1.24, origin: "corner" },
        env("shadow", "https://node.example.test/", { apiKey: "node-key" }, "https://csharp.example.test/"),
        controller.signal
      )
    ).resolves.toEqual(AUTHORITY);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://node.example.test/api/v1/gcode/analyze?bedSizeMm=256&coordinateOrigin=corner&filamentDensityGPerCm3=1.24",
      expect.objectContaining({ method: "POST", body: file, credentials: "same-origin", signal: controller.signal })
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("Content-Type")).toBe("application/x-gcode");
    expect(new Headers(request.headers).get("X-API-Key")).toBe("node-key");
    expect(new Headers(request.headers).has("Authorization")).toBe(false);
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("csharp.example.test");
  });

  it.each([
    ["schema", { ...AUTHORITY, schemaVersion: "2.0" }],
    ["byte count", { ...AUTHORITY, input: { ...AUTHORITY.input, bytesRead: 19 } }],
    ["bed size", { ...AUTHORITY, parameters: { ...AUTHORITY.parameters, bedSizeMm: 300 } }],
    ["origin", { ...AUTHORITY, parameters: { ...AUTHORITY.parameters, coordinateOrigin: "center" } }],
    ["density", { ...AUTHORITY, parameters: { ...AUTHORITY.parameters, filamentDensityGPerCm3: 1.25 } }],
    ["engine version", { ...AUTHORITY, engine: { ...AUTHORITY.engine, version: "" } }],
    ["engine source", { ...AUTHORITY, engine: { ...AUTHORITY.engine, source: "unexpected-route" } }],
  ])("rejects a %s contract mismatch", async (_label, responseBody) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), { status: 200 })));
    const file = new File(["x".repeat(20)], "fixture.gcode");

    await expect(
      requestAuthorityAnalysis(
        file,
        { bedSize: 256, densityG: 1.24, origin: "corner" },
        env("dotnet"),
        new AbortController().signal
      )
    ).rejects.toThrow("C# 权威结果契约不一致");
  });
});
