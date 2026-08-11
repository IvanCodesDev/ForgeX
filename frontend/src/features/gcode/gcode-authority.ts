import { detectRuntimeMode } from "../../app/runtime/runtime-mode";
import { createNodeRequestInit, resolveNodeApiBase } from "../../app/api/api-adapter";
import { forgeXApiOperations, type GCodeAnalysisResponse } from "../../generated/forgex-api";
import type { GcodeParseOptions, GcodePreviewResult } from "./gcode-types";
import { validateAuthorityToolpath } from "./authority-toolpath";

export type GcodeAuthorityMode = "browser" | "shadow" | "dotnet";
export type GcodeAuthorityStatus = "idle" | "running" | "done" | "error";

export type AuthorityAnalysisResponse = GCodeAnalysisResponse;

export interface AuthorityDiffField {
  readonly field: string;
  readonly preview: number;
  readonly authority: number;
  readonly absoluteDelta: number;
  readonly limit: number;
  readonly pass: boolean;
}

export interface AuthorityDiff {
  readonly engineMatches: boolean;
  readonly contractMatches: boolean;
  readonly inputMatches: boolean;
  readonly parametersMatch: boolean;
  readonly profileMatches: boolean;
  readonly layerPlanMatches: boolean;
  readonly layerMismatchCount: number;
  readonly sha256Matches: boolean;
  readonly pass: boolean;
  readonly fields: readonly AuthorityDiffField[];
  readonly layerFields: readonly AuthorityDiffField[];
}

export const DEFAULT_MACHINE_PROFILE_ID = "unspecified-machine";
export const DEFAULT_MATERIAL_PROFILE_ID = "unspecified-material";

function effectiveProfileIds(options: GcodeParseOptions): {
  readonly machineProfileId: string;
  readonly materialProfileId: string;
} {
  return {
    machineProfileId: options.machineProfileId ?? DEFAULT_MACHINE_PROFILE_ID,
    materialProfileId: options.materialProfileId ?? DEFAULT_MATERIAL_PROFILE_ID,
  };
}

export function buildGcodeAuthorityQuery(options: GcodeParseOptions): URLSearchParams {
  const profile = effectiveProfileIds(options);
  return new URLSearchParams({
    bedSizeMm: String(options.bedSize),
    coordinateOrigin: options.origin,
    filamentDensityGPerCm3: String(options.densityG),
    machineProfileId: profile.machineProfileId,
    materialProfileId: profile.materialProfileId,
  });
}

export interface EffectiveGcodeSummary {
  readonly provenance: "browser-preview" | "dotnet-authority";
  readonly totalLayers: number;
  readonly heightMm: number;
  readonly extrusionLengthMm: number;
  readonly travelLengthMm: number;
  readonly estimatedTimeSeconds: number;
  readonly volumeCm3: number;
  readonly filamentLengthM: number;
  readonly filamentMassG: number | null;
  readonly bounds: GcodePreviewResult["bounds"];
  readonly sha256: string;
}

/**
 * Selects the values that may be presented as the primary analysis result.
 * Shadow mode deliberately never switches away from the Worker preview. Dotnet
 * mode switches atomically only after a complete, validated authority response.
 */
export function selectEffectiveSummary(
  mode: GcodeAuthorityMode,
  status: GcodeAuthorityStatus,
  preview: GcodePreviewResult | null,
  authority: AuthorityAnalysisResponse | null
): EffectiveGcodeSummary | null {
  if (
    mode === "dotnet" &&
    status === "done" &&
    authority?.schemaVersion === "1.0" &&
    authority.engine.version.trim().length > 0 &&
    authority.engine.source === "gcode-import"
  ) {
    return {
      provenance: "dotnet-authority",
      ...authority.summary,
      bounds: authority.bounds,
      sha256: authority.input.sha256,
    };
  }

  if (!preview) return null;

  return {
    provenance: "browser-preview",
    totalLayers: preview.totalLayers,
    heightMm: preview.height,
    extrusionLengthMm: preview.stats.extLenMm,
    travelLengthMm: preview.stats.travelMm,
    estimatedTimeSeconds: preview.stats.timeSec,
    volumeCm3: preview.stats.volumeCm3,
    filamentLengthM: preview.stats.filamentM,
    filamentMassG: preview.stats.filamentG ?? null,
    bounds: preview.bounds,
    sha256: preview.sha256,
  };
}

export function resolveAuthorityMode(
  env: ImportMetaEnv,
  location: Pick<Location, "protocol"> = typeof window === "undefined" ? { protocol: "http:" } : window.location
): GcodeAuthorityMode {
  if (detectRuntimeMode(location, env).kind === "offline") return "browser";
  const value = env.VITE_GCODE_AUTHORITY?.trim().toLowerCase();
  return value === "shadow" || value === "dotnet" ? value : "browser";
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`C# 权威结果字段 ${label} 结构无效`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`C# 权威结果字段 ${key} 类型无效`);
  return value;
}

function requireFinite(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`C# 权威结果字段 ${key} 类型无效`);
  return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string, label = key): number {
  const value = requireFinite(record, key);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`C# 权威结果字段 ${label} 类型无效`);
  return value;
}

function requireNonNegativeFinite(record: Record<string, unknown>, key: string, label = key): number {
  const value = requireFinite(record, key);
  if (value < 0) throw new Error(`C# 权威结果字段 ${label} 类型无效`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`C# 权威结果字段 ${key} 类型无效`);
  return value;
}

export function parseAuthorityResponse(value: unknown): AuthorityAnalysisResponse {
  const root = requireRecord(value, "root");
  const engine = requireRecord(root.engine, "engine");
  const input = requireRecord(root.input, "input");
  const profile = requireRecord(root.profile, "profile");
  const parameters = requireRecord(root.parameters, "parameters");
  const summary = requireRecord(root.summary, "summary");
  const bounds = requireRecord(root.bounds, "bounds");
  if (!Array.isArray(root.layers) || root.layers.length > 20_000) {
    throw new Error("C# 权威结果字段 layers 结构无效");
  }
  const claims = requireRecord(root.claims, "claims");
  const pathTypeCounts = requireRecord(root.pathTypeCounts, "pathTypeCounts");
  const warnings = Array.isArray(root.warnings) ? root.warnings : [];
  const schemaVersion = requireString(root, "schemaVersion");
  if (schemaVersion !== "1.0") throw new Error(`C# 权威结果契约不一致：schemaVersion=${schemaVersion}`);
  const coordinateOrigin = requireString(parameters, "coordinateOrigin");
  if (coordinateOrigin !== "corner" && coordinateOrigin !== "center") {
    throw new Error(`C# 权威结果契约不一致：coordinateOrigin=${coordinateOrigin}`);
  }
  const profileCoordinateOrigin = requireString(profile, "coordinateOrigin");
  if (profileCoordinateOrigin !== "corner" && profileCoordinateOrigin !== "center") {
    throw new Error(`C# 权威结果契约不一致：profile.coordinateOrigin=${profileCoordinateOrigin}`);
  }
  const fingerprint = requireString(profile, "fingerprint");
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("C# 权威结果契约不一致：profile.fingerprint 无效");
  }
  const totalLayers = requireNonNegativeInteger(summary, "totalLayers");
  if (root.layers.length !== totalLayers) {
    throw new Error(`C# 权威结果契约不一致：layers.length=${root.layers.length}, totalLayers=${totalLayers}`);
  }
  const layers = root.layers.map((value, index) => {
    const layer = requireRecord(value, `layers[${index}]`);
    const actualIndex = requireNonNegativeInteger(layer, "index", `layers[${index}].index`);
    if (actualIndex !== index) {
      throw new Error(`C# 权威结果契约不一致：layers[${index}].index=${actualIndex}`);
    }
    const pathCount = requireNonNegativeInteger(layer, "pathCount", `layers[${index}].pathCount`);
    const rawPathTypeCounts = requireRecord(layer.pathTypeCounts, `layers[${index}].pathTypeCounts`);
    const pathTypeCounts = Object.fromEntries(
      Object.entries(rawPathTypeCounts).map(([key, count]) => {
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
          throw new Error(`C# 权威结果字段 layers[${index}].pathTypeCounts.${key} 类型无效`);
        }
        return [key, count];
      })
    );
    const countedPaths = Object.values(pathTypeCounts).reduce((sum, count) => sum + count, 0);
    if (countedPaths !== pathCount) {
      throw new Error(`C# 权威结果契约不一致：layers[${index}] pathTypeCounts=${countedPaths}, pathCount=${pathCount}`);
    }
    return {
      index: actualIndex,
      zMm: requireFinite(layer, "zMm"),
      pathCount,
      extrusionLengthMm: requireNonNegativeFinite(layer, "extrusionLengthMm", `layers[${index}].extrusionLengthMm`),
      travelLengthMm: requireNonNegativeFinite(layer, "travelLengthMm", `layers[${index}].travelLengthMm`),
      timeSeconds: requireNonNegativeFinite(layer, "timeSeconds", `layers[${index}].timeSeconds`),
      filamentLengthMm: requireNonNegativeFinite(layer, "filamentLengthMm", `layers[${index}].filamentLengthMm`),
      pathTypeCounts,
    };
  });
  const rawVisualization = requireRecord(root.visualization, "visualization");
  const encoding = requireString(rawVisualization, "encoding");
  const recordStrideBytes = requireNonNegativeInteger(rawVisualization, "recordStrideBytes");
  const sourceSegmentCount = requireNonNegativeInteger(rawVisualization, "sourceSegmentCount");
  const segmentCount = requireNonNegativeInteger(rawVisualization, "segmentCount");
  const samplingStride = requireNonNegativeInteger(rawVisualization, "samplingStride");
  const dataBase64 = requireString(rawVisualization, "dataBase64");
  if (encoding !== "forgex-toolpath-f32le-v1" || recordStrideBytes !== 20 || segmentCount > 100_000) {
    throw new Error("C# 权威结果契约不一致：visualization 编码或预算无效");
  }
  if (samplingStride < 1 || sourceSegmentCount < segmentCount) {
    throw new Error("C# 权威结果契约不一致：visualization 计数无效");
  }
  const truncated = requireBoolean(rawVisualization, "truncated");
  if (truncated !== segmentCount < sourceSegmentCount) {
    throw new Error("C# 权威结果契约不一致：visualization.truncated 不一致");
  }
  if (
    !Array.isArray(rawVisualization.pathTypes) ||
    rawVisualization.pathTypes.length === 0 ||
    rawVisualization.pathTypes.length > 16
  ) {
    throw new Error("C# 权威结果契约不一致：visualization.pathTypes 结构无效");
  }
  const pathTypes = rawVisualization.pathTypes.map((value, index) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 40) {
      throw new Error(`C# 权威结果契约不一致：visualization.pathTypes[${index}] 类型无效`);
    }
    return value;
  });
  if (new Set(pathTypes).size !== pathTypes.length) {
    throw new Error("C# 权威结果契约不一致：visualization.pathTypes 存在重复值");
  }
  if (!Array.isArray(rawVisualization.layers) || rawVisualization.layers.length !== totalLayers) {
    throw new Error("C# 权威结果契约不一致：visualization.layers 结构无效");
  }
  let expectedOffset = 0;
  let countedSourceSegments = 0;
  const visualizationLayers = rawVisualization.layers.map((value, index) => {
    const layer = requireRecord(value, `visualization.layers[${index}]`);
    const actualIndex = requireNonNegativeInteger(layer, "index", `visualization.layers[${index}].index`);
    const layerSourceSegments = requireNonNegativeInteger(
      layer,
      "sourceSegmentCount",
      `visualization.layers[${index}].sourceSegmentCount`
    );
    const segmentOffset = requireNonNegativeInteger(
      layer,
      "segmentOffset",
      `visualization.layers[${index}].segmentOffset`
    );
    const layerSegmentCount = requireNonNegativeInteger(
      layer,
      "segmentCount",
      `visualization.layers[${index}].segmentCount`
    );
    if (actualIndex !== index || segmentOffset !== expectedOffset || layerSegmentCount > layerSourceSegments) {
      throw new Error(`C# 权威结果契约不一致：visualization.layers[${index}] 切片无效`);
    }
    expectedOffset += layerSegmentCount;
    countedSourceSegments += layerSourceSegments;
    return {
      index: actualIndex,
      sourceSegmentCount: layerSourceSegments,
      segmentOffset,
      segmentCount: layerSegmentCount,
    };
  });
  if (expectedOffset !== segmentCount || countedSourceSegments !== sourceSegmentCount) {
    throw new Error("C# 权威结果契约不一致：visualization 层切片计数不一致");
  }
  const expectedBase64Length = 4 * Math.ceil((segmentCount * recordStrideBytes) / 3);
  if (
    dataBase64.length !== expectedBase64Length ||
    (dataBase64.length > 0 && !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64))
  ) {
    throw new Error("C# 权威结果契约不一致：visualization.dataBase64 长度或编码无效");
  }
  const visualization = {
    encoding,
    recordStrideBytes,
    sourceSegmentCount,
    segmentCount,
    truncated,
    samplingStride,
    pathTypes,
    layers: visualizationLayers,
    dataBase64,
  } as const;
  validateAuthorityToolpath(visualization);
  return {
    schemaVersion,
    engine: { version: requireString(engine, "version"), source: requireString(engine, "source") },
    input: {
      sha256: requireString(input, "sha256"),
      bytesRead: requireFinite(input, "bytesRead"),
      linesRead: requireFinite(input, "linesRead"),
    },
    profile: {
      machineProfileId: requireString(profile, "machineProfileId"),
      materialProfileId: requireString(profile, "materialProfileId"),
      bedSizeMm: requireFinite(profile, "bedSizeMm"),
      coordinateOrigin: profileCoordinateOrigin,
      filamentDensityGPerCm3: requireFinite(profile, "filamentDensityGPerCm3"),
      fingerprint,
    },
    parameters: {
      bedSizeMm: requireFinite(parameters, "bedSizeMm"),
      coordinateOrigin,
      filamentDensityGPerCm3: requireFinite(parameters, "filamentDensityGPerCm3"),
    },
    summary: {
      totalLayers,
      heightMm: requireFinite(summary, "heightMm"),
      extrusionLengthMm: requireFinite(summary, "extrusionLengthMm"),
      travelLengthMm: requireFinite(summary, "travelLengthMm"),
      estimatedTimeSeconds: requireFinite(summary, "estimatedTimeSeconds"),
      volumeCm3: requireFinite(summary, "volumeCm3"),
      filamentLengthM: requireFinite(summary, "filamentLengthM"),
      filamentMassG: requireFinite(summary, "filamentMassG"),
    },
    bounds: {
      minX: requireFinite(bounds, "minX"),
      maxX: requireFinite(bounds, "maxX"),
      minY: requireFinite(bounds, "minY"),
      maxY: requireFinite(bounds, "maxY"),
    },
    layers,
    visualization,
    claims: Object.fromEntries(
      Object.entries(claims).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    ),
    pathTypeCounts: Object.fromEntries(
      Object.entries(pathTypeCounts).filter((entry): entry is [string, number] => typeof entry[1] === "number")
    ),
    warnings: warnings.flatMap((warning) => {
      const item = requireRecord(warning, "warnings[]");
      return [{ code: requireString(item, "code"), message: requireString(item, "message") }];
    }),
  };
}

export function assertAuthorityContract(
  result: AuthorityAnalysisResponse,
  file: File,
  options: GcodeParseOptions
): AuthorityAnalysisResponse {
  const mismatches: string[] = [];
  const profile = effectiveProfileIds(options);
  if (result.schemaVersion !== "1.0") mismatches.push(`schemaVersion=${result.schemaVersion}`);
  if (!result.engine.version.trim()) mismatches.push("engine.version is empty");
  if (result.engine.source !== "gcode-import") {
    mismatches.push(`engine.source=${result.engine.source}, expected=gcode-import`);
  }
  if (result.input.bytesRead !== file.size) {
    mismatches.push(`bytesRead=${result.input.bytesRead}, expected=${file.size}`);
  }
  if (result.parameters.bedSizeMm !== options.bedSize) {
    mismatches.push(`bedSizeMm=${result.parameters.bedSizeMm}, expected=${options.bedSize}`);
  }
  if (result.parameters.coordinateOrigin !== options.origin) {
    mismatches.push(`coordinateOrigin=${result.parameters.coordinateOrigin}, expected=${options.origin}`);
  }
  if (result.parameters.filamentDensityGPerCm3 !== options.densityG) {
    mismatches.push(`filamentDensityGPerCm3=${result.parameters.filamentDensityGPerCm3}, expected=${options.densityG}`);
  }
  if (result.profile.machineProfileId !== profile.machineProfileId) {
    mismatches.push(
      `profile.machineProfileId=${result.profile.machineProfileId}, expected=${profile.machineProfileId}`
    );
  }
  if (result.profile.materialProfileId !== profile.materialProfileId) {
    mismatches.push(
      `profile.materialProfileId=${result.profile.materialProfileId}, expected=${profile.materialProfileId}`
    );
  }
  if (
    result.profile.bedSizeMm !== result.parameters.bedSizeMm ||
    result.profile.coordinateOrigin !== result.parameters.coordinateOrigin ||
    result.profile.filamentDensityGPerCm3 !== result.parameters.filamentDensityGPerCm3
  ) {
    mismatches.push("profile effective values differ from parameters");
  }
  if (mismatches.length) throw new Error(`C# 权威结果契约不一致：${mismatches.join("; ")}`);
  return result;
}

export async function requestAuthorityAnalysis(
  file: File,
  options: GcodeParseOptions,
  env: ImportMetaEnv,
  signal: AbortSignal
): Promise<AuthorityAnalysisResponse> {
  const base = resolveNodeApiBase(env);
  const query = buildGcodeAuthorityQuery(options);
  const response = await fetch(
    `${base}${forgeXApiOperations.analyzeGCode.path}?${query}`,
    createNodeRequestInit(env, {
      method: "POST",
      headers: { "Content-Type": "application/x-gcode" },
      body: file,
      signal,
    })
  );
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { code?: unknown; detail?: unknown } | null;
    const code = typeof problem?.code === "string" ? problem.code : `HTTP_${response.status}`;
    const detail = typeof problem?.detail === "string" ? problem.detail : "C# 权威分析失败";
    throw new Error(`${code}: ${detail}`);
  }
  return assertAuthorityContract(parseAuthorityResponse(await response.json()), file, options);
}

function compareNumber(field: string, previewValue: number, authorityValue: number, exact = false): AuthorityDiffField {
  const absoluteDelta = Math.abs(previewValue - authorityValue);
  const limit = exact ? 0 : Math.max(0.000001, Math.abs(previewValue) * 0.000001);
  return {
    field,
    preview: previewValue,
    authority: authorityValue,
    absoluteDelta,
    limit,
    pass: absoluteDelta <= limit,
  };
}

export function compareAuthority(
  preview: GcodePreviewResult,
  authority: AuthorityAnalysisResponse,
  expectedOptions?: GcodeParseOptions
): AuthorityDiff {
  const pairs: ReadonlyArray<readonly [string, number, number]> = [
    ["totalLayers", preview.totalLayers, authority.summary.totalLayers],
    ["heightMm", preview.height, authority.summary.heightMm],
    ["bounds.minX", preview.bounds.minX, authority.bounds.minX],
    ["bounds.maxX", preview.bounds.maxX, authority.bounds.maxX],
    ["bounds.minY", preview.bounds.minY, authority.bounds.minY],
    ["bounds.maxY", preview.bounds.maxY, authority.bounds.maxY],
    ["stats.extLenMm", preview.stats.extLenMm, authority.summary.extrusionLengthMm],
    ["stats.travelMm", preview.stats.travelMm, authority.summary.travelLengthMm],
    ["stats.timeSec", preview.stats.timeSec, authority.summary.estimatedTimeSeconds],
    ["stats.volumeCm3", preview.stats.volumeCm3, authority.summary.volumeCm3],
    ["stats.filamentM", preview.stats.filamentM, authority.summary.filamentLengthM],
    ["stats.filamentG", preview.stats.filamentG ?? 0, authority.summary.filamentMassG],
  ];
  const fields = pairs.map(([field, previewValue, authorityValue]) =>
    compareNumber(field, previewValue, authorityValue)
  );
  const layerFields: AuthorityDiffField[] = [];
  let layerMismatchCount = 0;
  if (preview.layerSummaries.length !== authority.layers.length) {
    layerMismatchCount += Math.abs(preview.layerSummaries.length - authority.layers.length);
    layerFields.push(compareNumber("layers.length", preview.layerSummaries.length, authority.layers.length, true));
  }
  const comparedLayers = Math.min(preview.layerSummaries.length, authority.layers.length);
  for (let index = 0; index < comparedLayers; index += 1) {
    const previewLayer = preview.layerSummaries[index];
    const authorityLayer = authority.layers[index];
    if (!previewLayer || !authorityLayer) continue;
    const comparisons = [
      compareNumber(`layers[${index}].index`, previewLayer.index, authorityLayer.index, true),
      compareNumber(`layers[${index}].zMm`, previewLayer.zMm, authorityLayer.zMm),
      compareNumber(`layers[${index}].pathCount`, previewLayer.pathCount, authorityLayer.pathCount, true),
      compareNumber(
        `layers[${index}].extrusionLengthMm`,
        previewLayer.extrusionLengthMm,
        authorityLayer.extrusionLengthMm
      ),
      compareNumber(`layers[${index}].travelLengthMm`, previewLayer.travelLengthMm, authorityLayer.travelLengthMm),
      compareNumber(`layers[${index}].timeSeconds`, previewLayer.timeSeconds, authorityLayer.timeSeconds),
      compareNumber(
        `layers[${index}].filamentLengthMm`,
        previewLayer.filamentLengthMm,
        authorityLayer.filamentLengthMm
      ),
    ];
    const pathTypes = new Set([
      ...Object.keys(previewLayer.pathTypeCounts),
      ...Object.keys(authorityLayer.pathTypeCounts),
    ]);
    for (const pathType of pathTypes) {
      comparisons.push(
        compareNumber(
          `layers[${index}].pathTypeCounts.${pathType}`,
          previewLayer.pathTypeCounts[pathType] ?? 0,
          authorityLayer.pathTypeCounts[pathType] ?? 0,
          true
        )
      );
    }
    const failures = comparisons.filter((field) => !field.pass);
    if (failures.length > 0) {
      layerMismatchCount += 1;
      layerFields.push(...failures.slice(0, Math.max(0, 64 - layerFields.length)));
    }
  }
  const layerPlanMatches = layerMismatchCount === 0;
  const engineMatches = authority.engine.version.trim().length > 0 && authority.engine.source === "gcode-import";
  const contractMatches = authority.schemaVersion === "1.0";
  const sha256Matches = preview.sha256 === authority.input.sha256;
  const inputMatches = authority.input.bytesRead === preview.byteLength;
  const parametersMatch =
    authority.parameters.coordinateOrigin === preview.coordinateOrigin &&
    (!expectedOptions ||
      (authority.parameters.bedSizeMm === expectedOptions.bedSize &&
        authority.parameters.coordinateOrigin === expectedOptions.origin &&
        authority.parameters.filamentDensityGPerCm3 === expectedOptions.densityG));
  const profileIds = expectedOptions ? effectiveProfileIds(expectedOptions) : null;
  const profileMatches =
    authority.profile.bedSizeMm === authority.parameters.bedSizeMm &&
    authority.profile.coordinateOrigin === authority.parameters.coordinateOrigin &&
    authority.profile.filamentDensityGPerCm3 === authority.parameters.filamentDensityGPerCm3 &&
    (!profileIds ||
      (authority.profile.machineProfileId === profileIds.machineProfileId &&
        authority.profile.materialProfileId === profileIds.materialProfileId));
  return {
    engineMatches,
    contractMatches,
    inputMatches,
    parametersMatch,
    profileMatches,
    layerPlanMatches,
    layerMismatchCount,
    sha256Matches,
    fields,
    layerFields,
    pass:
      engineMatches &&
      contractMatches &&
      inputMatches &&
      parametersMatch &&
      profileMatches &&
      layerPlanMatches &&
      sha256Matches &&
      fields.every((field) => field.pass),
  };
}
