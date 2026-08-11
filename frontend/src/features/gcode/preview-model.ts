import type {
  GcodeLayerSummary,
  GcodePreviewResult,
  LegacyGcodeResult,
  LegacyPath,
  PreviewLayer,
  PreviewPath,
} from "./gcode-types";

export interface PreviewBudget {
  readonly maxSegments: number;
  readonly maxPointsPerPath: number;
}

export interface BuiltPreview {
  readonly layers: readonly PreviewLayer[];
  /** Cumulative segment offsets; item N is the start offset for layer N. */
  readonly layerSegmentOffsets: readonly number[];
  readonly segments: number;
  readonly sourceSegments: number;
  readonly truncated: boolean;
}

export interface PreviewResultInput {
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly parsed: LegacyGcodeResult;
  readonly preview: BuiltPreview;
}

export function buildLayerSummaries(parsed: LegacyGcodeResult): readonly GcodeLayerSummary[] {
  return parsed.layers.map((layer, index) => {
    const pathTypeCounts: Record<string, number> = {};
    let filamentLengthMm = 0;
    for (const path of layer.paths) {
      pathTypeCounts[path.type] = (pathTypeCounts[path.type] ?? 0) + 1;
      filamentLengthMm += path.filamentMm;
    }
    return {
      index,
      zMm: layer.z,
      pathCount: layer.paths.length,
      extrusionLengthMm: layer.extLen,
      travelLengthMm: layer.travelLen,
      timeSeconds: layer.timeSec,
      filamentLengthMm,
      pathTypeCounts,
    };
  });
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Allocate an integer budget proportionally without exceeding any item cap.
 * Fractional ties are resolved by source order, making golden results stable.
 */
function allocateProportionally(caps: readonly number[], requestedBudget: number): number[] {
  const normalizedCaps = caps.map(normalizeLimit);
  const capacity = normalizedCaps.reduce((total, value) => total + value, 0);
  const budget = Math.min(normalizeLimit(requestedBudget), capacity);
  if (budget === 0 || capacity === 0) return normalizedCaps.map(() => 0);

  const exact = normalizedCaps.map((cap) => (budget * cap) / capacity);
  const allocation = exact.map((value) => Math.floor(value));
  let remainder = budget - allocation.reduce((total, value) => total + value, 0);
  const priority = exact
    .map((value, index) => ({ fraction: value - Math.floor(value), index }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);

  for (const item of priority) {
    if (remainder === 0) break;
    const cap = normalizedCaps[item.index] ?? 0;
    const current = allocation[item.index] ?? 0;
    if (current >= cap) continue;
    allocation[item.index] = current + 1;
    remainder -= 1;
  }
  return allocation;
}

function pathSegmentCapacity(path: LegacyPath, maxPointsPerPath: number): number {
  const sourceSegments = Math.max(0, path.pts.length - 1);
  return Math.min(sourceSegments, Math.max(0, maxPointsPerPath - 1));
}

function samplePath(path: LegacyPath, segmentBudget: number): PreviewPath | null {
  const sourceSegments = Math.max(0, path.pts.length - 1);
  const targetSegments = Math.min(sourceSegments, normalizeLimit(segmentBudget));
  if (targetSegments === 0) return null;

  const points: Array<readonly [number, number]> = [];
  for (let index = 0; index <= targetSegments; index += 1) {
    const sourceIndex = Math.min(sourceSegments, Math.round((index * sourceSegments) / targetSegments));
    const point = path.pts[sourceIndex];
    if (point) points.push([point.x, point.y]);
  }
  return { type: path.type, points };
}

/**
 * Create display-only geometry under a hard global segment budget. Source-layer
 * indices, Z positions and source counts remain exact even when paths are sampled.
 */
export function buildPreview(parsed: LegacyGcodeResult, budget: PreviewBudget): BuiltPreview {
  const maxSegments = normalizeLimit(budget.maxSegments);
  const maxPointsPerPath = Math.max(2, normalizeLimit(budget.maxPointsPerPath));
  const sourceSegmentsByLayer = parsed.layers.map((layer) =>
    layer.paths.reduce((total, path) => total + Math.max(0, path.pts.length - 1), 0)
  );
  const sourceSegments = sourceSegmentsByLayer.reduce((total, value) => total + value, 0);
  const layerCapacities = parsed.layers.map((layer) =>
    layer.paths.reduce((total, path) => total + pathSegmentCapacity(path, maxPointsPerPath), 0)
  );
  const layerBudgets = allocateProportionally(layerCapacities, maxSegments);
  const layerSegmentOffsets: number[] = [0];
  let segments = 0;

  const layers = parsed.layers.map((layer, layerIndex): PreviewLayer => {
    const pathCapacities = layer.paths.map((path) => pathSegmentCapacity(path, maxPointsPerPath));
    const pathBudgets = allocateProportionally(pathCapacities, layerBudgets[layerIndex] ?? 0);
    const paths: PreviewPath[] = [];

    layer.paths.forEach((path, pathIndex) => {
      const sampled = samplePath(path, pathBudgets[pathIndex] ?? 0);
      if (!sampled) return;
      segments += Math.max(0, sampled.points.length - 1);
      paths.push(sampled);
    });
    layerSegmentOffsets.push(segments);

    return {
      index: layerIndex,
      z: layer.z,
      sourcePathCount: layer.paths.length,
      sourcePointCount: layer.paths.reduce((total, path) => total + path.pts.length, 0),
      paths,
    };
  });

  return {
    layers,
    layerSegmentOffsets,
    segments,
    sourceSegments,
    truncated: segments < sourceSegments,
  };
}

/** Compose the worker result without deriving authoritative summary fields from sampled geometry. */
export function composePreviewResult(input: PreviewResultInput): GcodePreviewResult {
  const { parsed, preview } = input;
  return {
    fileName: input.fileName,
    byteLength: input.byteLength,
    sha256: input.sha256,
    totalLayers: parsed.totalLayers,
    height: parsed.height,
    stats: parsed.stats,
    bounds: parsed.bounds,
    coordinateOrigin: parsed.coordinateOrigin,
    warnings: parsed.warnings,
    claims: parsed.claims,
    layers: preview.layers,
    layerSummaries: buildLayerSummaries(parsed),
    layerSegmentOffsets: preview.layerSegmentOffsets,
    sourceSegments: preview.sourceSegments,
    previewSegments: preview.segments,
    previewTruncated: preview.truncated,
  };
}
