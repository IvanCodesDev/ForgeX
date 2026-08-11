export type GcodePathType = "perimeter" | "solid" | "infill" | "support" | "skirt" | string;

export interface LegacyPoint {
  readonly x: number;
  readonly y: number;
}

export interface LegacyPath {
  readonly pts: readonly LegacyPoint[];
  readonly type: GcodePathType;
  readonly len: number;
  readonly speed: number;
  readonly filamentMm: number;
}

export interface LegacyLayer {
  readonly z: number;
  readonly paths: readonly LegacyPath[];
  readonly extLen: number;
  readonly travelLen: number;
  readonly timeSec: number;
}

export interface GcodeStats {
  readonly extLenMm: number;
  readonly travelMm: number;
  readonly timeSec: number;
  readonly volumeCm3: number;
  readonly filamentM: number;
  readonly filamentG?: number;
}

export interface GcodeBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface LegacyGcodeResult {
  readonly layers: readonly LegacyLayer[];
  readonly totalLayers: number;
  readonly height: number;
  readonly stats: GcodeStats;
  readonly bounds: GcodeBounds;
  readonly coordinateOrigin: "corner" | "center";
  readonly warnings: readonly string[];
  readonly claims: Readonly<Record<string, string | number>>;
}

export interface GcodeParseOptions {
  readonly densityG: number;
  readonly bedSize: number;
  readonly origin: "corner" | "center";
  readonly machineProfileId?: string;
  readonly materialProfileId?: string;
}

export interface PreviewPath {
  readonly type: GcodePathType;
  readonly points: readonly (readonly [number, number])[];
}

export interface PreviewLayer {
  readonly index: number;
  readonly z: number;
  readonly sourcePathCount: number;
  readonly sourcePointCount: number;
  readonly paths: readonly PreviewPath[];
}

/** A decoded layer view over the C# packed visualization contract. */
export interface AuthorityToolpathLayerView {
  readonly index: number;
  readonly z: number;
  readonly sourcePathCount: number;
  readonly sourceSegmentCount: number;
  readonly segmentCount: number;
  /** Four XY float32 values per independent line segment: x1, y1, x2, y2. */
  readonly coordinates: Float32Array;
  readonly pathTypeIndexes: Uint8Array;
  readonly pathTypes: readonly string[];
}

export interface GcodeLayerSummary {
  readonly index: number;
  readonly zMm: number;
  readonly pathCount: number;
  readonly extrusionLengthMm: number;
  readonly travelLengthMm: number;
  readonly timeSeconds: number;
  readonly filamentLengthMm: number;
  readonly pathTypeCounts: Readonly<Record<string, number>>;
}

export interface GcodePreviewResult {
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly totalLayers: number;
  readonly height: number;
  readonly stats: GcodeStats;
  readonly bounds: GcodeBounds;
  readonly coordinateOrigin: "corner" | "center";
  readonly warnings: readonly string[];
  readonly claims: Readonly<Record<string, string | number>>;
  readonly layers: readonly PreviewLayer[];
  readonly layerSummaries: readonly GcodeLayerSummary[];
  readonly layerSegmentOffsets: readonly number[];
  readonly sourceSegments: number;
  readonly previewSegments: number;
  readonly previewTruncated: boolean;
}

export interface GcodeWorkerLimits {
  readonly chunkBytes: number;
  readonly maxPreviewSegments: number;
  readonly maxPointsPerPath: number;
}

export type GcodeWorkerPhase = "read" | "hash" | "parse" | "pack";
export type GcodeWorkerErrorCode =
  "FILE_TOO_LARGE" | "READ_FAILED" | "CRYPTO_UNAVAILABLE" | "DECODE_FAILED" | "NO_EXTRUSION" | "WORKER_FAILURE";

export type GcodeWorkerRequest = {
  readonly type: "parse";
  readonly requestId: string;
  readonly file: File;
  readonly options: GcodeParseOptions;
  readonly limits: GcodeWorkerLimits;
};

export type GcodeWorkerResponse =
  | {
      readonly type: "progress";
      readonly requestId: string;
      readonly phase: GcodeWorkerPhase;
      readonly progress: number;
      readonly stage: string;
    }
  | { readonly type: "result"; readonly requestId: string; readonly result: GcodePreviewResult }
  | {
      readonly type: "error";
      readonly requestId: string;
      readonly code: GcodeWorkerErrorCode;
      readonly phase: GcodeWorkerPhase;
      readonly message: string;
      readonly retryable: boolean;
    };
