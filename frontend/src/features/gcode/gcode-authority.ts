import { detectRuntimeMode } from "../../app/runtime/runtime-mode";
import { createNodeRequestInit, resolveNodeApiBase } from "../../app/api/api-adapter";
import { forgeXApiOperations, type GCodeAnalysisResponse } from "../../generated/forgex-api";
import type { GcodeParseOptions, GcodePreviewResult } from "./gcode-types";

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
  readonly sha256Matches: boolean;
  readonly pass: boolean;
  readonly fields: readonly AuthorityDiffField[];
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

export function parseAuthorityResponse(value: unknown): AuthorityAnalysisResponse {
  const root = requireRecord(value, "root");
  const engine = requireRecord(root.engine, "engine");
  const input = requireRecord(root.input, "input");
  const profile = requireRecord(root.profile, "profile");
  const parameters = requireRecord(root.parameters, "parameters");
  const summary = requireRecord(root.summary, "summary");
  const bounds = requireRecord(root.bounds, "bounds");
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
      totalLayers: requireFinite(summary, "totalLayers"),
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
  const fields = pairs.map(([field, previewValue, authorityValue]) => {
    const absoluteDelta = Math.abs(previewValue - authorityValue);
    const limit = Math.max(0.000001, Math.abs(previewValue) * 0.000001);
    return {
      field,
      preview: previewValue,
      authority: authorityValue,
      absoluteDelta,
      limit,
      pass: absoluteDelta <= limit,
    };
  });
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
    sha256Matches,
    fields,
    pass:
      engineMatches &&
      contractMatches &&
      inputMatches &&
      parametersMatch &&
      profileMatches &&
      sha256Matches &&
      fields.every((field) => field.pass),
  };
}
