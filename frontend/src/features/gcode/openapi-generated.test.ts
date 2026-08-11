import { describe, expect, it } from "vitest";
import {
  forgeXApiOperations,
  forgeXApiPath,
  type GCodeAnalysisResponse,
  type GCodeJobAcceptedResponse,
} from "../../generated/forgex-api";

describe("generated ForgeX OpenAPI client", () => {
  it("exposes stable G-code routes and encodes path parameters", () => {
    expect(forgeXApiOperations.analyzeGCode).toEqual({ method: "POST", path: "/api/v1/gcode/analyze" });
    expect(forgeXApiOperations.createGCodeAnalysisJob).toEqual({
      method: "POST",
      path: "/api/v1/gcode/analyses",
    });
    expect(forgeXApiPath("getGCodeAnalysisJob", { id: "a/b" })).toBe("/api/v1/jobs/a%2Fb");
    expect(() => forgeXApiPath("getGCodeAnalysisJob")).toThrow("Missing OpenAPI path parameter: id");
  });

  it("keeps authority and accepted-job DTOs connected to generated schemas", () => {
    const result: GCodeAnalysisResponse = {
      schemaVersion: "1.0",
      engine: { version: "1.0.0", source: "gcode-import" },
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
    const accepted: GCodeJobAcceptedResponse = {
      schemaVersion: "1.0",
      jobId: "1".repeat(32),
      status: "queued",
      input: result.input,
      links: {
        status: `/api/v1/jobs/${"1".repeat(32)}`,
        events: `/api/v1/jobs/${"1".repeat(32)}/events`,
        cancel: `/api/v1/jobs/${"1".repeat(32)}/cancel`,
      },
    };

    expect(accepted.input).toBe(result.input);
  });
});
