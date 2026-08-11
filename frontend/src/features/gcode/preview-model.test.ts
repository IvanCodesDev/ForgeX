import { describe, expect, it } from "vitest";
import type { LegacyGcodeResult, LegacyPath } from "./gcode-types";
import { buildPreview, composePreviewResult } from "./preview-model";

function path(pointCount: number, offset = 0): LegacyPath {
  return {
    type: "perimeter",
    pts: Array.from({ length: pointCount }, (_, index) => ({ x: offset + index, y: offset - index })),
    len: Math.max(0, pointCount - 1),
    speed: 30,
    filamentMm: 2,
  };
}

function parsedFixture(): LegacyGcodeResult {
  return {
    layers: [
      { z: 0.2, paths: [path(10), path(6, 20)], extLen: 14, travelLen: 3, timeSec: 2 },
      { z: 0.4, paths: [path(18, 40)], extLen: 17, travelLen: 4, timeSec: 3 },
      { z: 0.6, paths: [path(4, 80)], extLen: 3, travelLen: 5, timeSec: 4 },
    ],
    totalLayers: 3,
    height: 0.6,
    stats: { extLenMm: 1234, travelMm: 456, timeSec: 789, volumeCm3: 1.2, filamentM: 3.4, filamentG: 4.5 },
    bounds: { minX: -10, maxX: 100, minY: -20, maxY: 80 },
    coordinateOrigin: "corner",
    warnings: ["fixture warning"],
    claims: { parserVersion: "fixture", moveCount: 42 },
  };
}

function countLayerSegments(layer: ReturnType<typeof buildPreview>["layers"][number]): number {
  return layer.paths.reduce((total, item) => total + Math.max(0, item.points.length - 1), 0);
}

describe("buildPreview", () => {
  it("never exceeds the global budget and emits exact cumulative layer offsets", () => {
    const parsed = parsedFixture();
    const preview = buildPreview(parsed, { maxSegments: 11, maxPointsPerPath: 64 });

    expect(preview.segments).toBeLessThanOrEqual(11);
    expect(preview.layerSegmentOffsets).toHaveLength(parsed.layers.length + 1);
    expect(preview.layerSegmentOffsets[0]).toBe(0);
    expect(preview.layerSegmentOffsets.at(-1)).toBe(preview.segments);

    preview.layers.forEach((layer, index) => {
      const start = preview.layerSegmentOffsets[index] ?? -1;
      const end = preview.layerSegmentOffsets[index + 1] ?? -1;
      expect(end - start).toBe(countLayerSegments(layer));
      expect(layer.index).toBe(index);
      expect(layer.z).toBe(parsed.layers[index]?.z);
      expect(layer.sourcePathCount).toBe(parsed.layers[index]?.paths.length);
    });
    expect(preview.truncated).toBe(true);
  });

  it("applies the per-path cap while preserving both endpoints", () => {
    const parsed = parsedFixture();
    const preview = buildPreview(parsed, { maxSegments: 100, maxPointsPerPath: 4 });
    const sampled = preview.layers[0]?.paths[0];

    expect(sampled?.points).toHaveLength(4);
    expect(sampled?.points[0]).toEqual([0, 0]);
    expect(sampled?.points.at(-1)).toEqual([9, -9]);
    expect(preview.segments).toBeLessThanOrEqual(100);
    expect(preview.truncated).toBe(true);
  });

  it("marks complete geometry as untruncated", () => {
    const parsed: LegacyGcodeResult = {
      ...parsedFixture(),
      layers: [{ z: 0.2, paths: [path(3)], extLen: 2, travelLen: 0, timeSec: 1 }],
      totalLayers: 1,
      height: 0.2,
    };
    const preview = buildPreview(parsed, { maxSegments: 10, maxPointsPerPath: 10 });

    expect(preview.segments).toBe(2);
    expect(preview.sourceSegments).toBe(2);
    expect(preview.truncated).toBe(false);
  });
});

describe("composePreviewResult", () => {
  it("keeps authoritative summary values independent of sampled display geometry", () => {
    const parsed = parsedFixture();
    const preview = buildPreview(parsed, { maxSegments: 2, maxPointsPerPath: 3 });
    const result = composePreviewResult({
      fileName: "fixture.gcode",
      byteLength: 4096,
      sha256: "a".repeat(64),
      parsed,
      preview,
    });

    expect(result.previewTruncated).toBe(true);
    expect(result.previewSegments).toBeLessThanOrEqual(2);
    expect(result.totalLayers).toBe(parsed.totalLayers);
    expect(result.height).toBe(parsed.height);
    expect(result.stats).toBe(parsed.stats);
    expect(result.bounds).toBe(parsed.bounds);
    expect(result.warnings).toBe(parsed.warnings);
    expect(result.claims).toBe(parsed.claims);
    expect(result.layerSummaries).toEqual([
      {
        index: 0,
        zMm: 0.2,
        pathCount: 2,
        extrusionLengthMm: 14,
        travelLengthMm: 3,
        timeSeconds: 2,
        filamentLengthMm: 4,
        pathTypeCounts: { perimeter: 2 },
      },
      {
        index: 1,
        zMm: 0.4,
        pathCount: 1,
        extrusionLengthMm: 17,
        travelLengthMm: 4,
        timeSeconds: 3,
        filamentLengthMm: 2,
        pathTypeCounts: { perimeter: 1 },
      },
      {
        index: 2,
        zMm: 0.6,
        pathCount: 1,
        extrusionLengthMm: 3,
        travelLengthMm: 5,
        timeSeconds: 4,
        filamentLengthMm: 2,
        pathTypeCounts: { perimeter: 1 },
      },
    ]);
  });
});
