import type { GCodeAnalysisResponse, GCodeToolpathVisualization } from "../../generated/forgex-api";
import type { AuthorityToolpathLayerView } from "./gcode-types";

const payloadCache = new WeakMap<GCodeToolpathVisualization, Uint8Array>();
const layerCache = new WeakMap<GCodeToolpathVisualization, Map<number, AuthorityToolpathLayerView>>();

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function payload(visualization: GCodeToolpathVisualization): Uint8Array {
  const cached = payloadCache.get(visualization);
  if (cached) return cached;
  const decoded = decodeBase64(visualization.dataBase64);
  payloadCache.set(visualization, decoded);
  return decoded;
}

/** Decode and validate the complete bounded payload before dotnet mode may switch atomically. */
export function validateAuthorityToolpath(visualization: GCodeToolpathVisualization): void {
  const bytes = payload(visualization);
  const expectedBytes = visualization.segmentCount * visualization.recordStrideBytes;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`C# 权威结果契约不一致：可视化数据长度不一致：${bytes.byteLength} != ${expectedBytes}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < visualization.segmentCount; index += 1) {
    const offset = index * visualization.recordStrideBytes;
    for (let coordinate = 0; coordinate < 4; coordinate += 1) {
      if (!Number.isFinite(view.getFloat32(offset + coordinate * 4, true))) {
        throw new Error(`C# 权威结果契约不一致：可视化坐标无效：segment=${index}`);
      }
    }
    const pathTypeIndex = view.getInt32(offset + 16, true);
    if (pathTypeIndex < 0 || pathTypeIndex >= visualization.pathTypes.length) {
      throw new Error(`C# 权威结果契约不一致：可视化路径类型无效：segment=${index}`);
    }
  }
}

/** Decode one selected layer only; decoded payload and visited layers are cached by response identity. */
export function decodeAuthorityToolpathLayer(
  authority: GCodeAnalysisResponse,
  layerIndex: number
): AuthorityToolpathLayerView | null {
  const visualization = authority.visualization;
  const descriptor = visualization.layers[layerIndex];
  const summary = authority.layers[layerIndex];
  if (!descriptor || !summary) return null;

  let cachedLayers = layerCache.get(visualization);
  if (!cachedLayers) {
    cachedLayers = new Map();
    layerCache.set(visualization, cachedLayers);
  }
  const cached = cachedLayers.get(layerIndex);
  if (cached) return cached;

  const bytes = payload(visualization);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const coordinates = new Float32Array(descriptor.segmentCount * 4);
  const pathTypeIndexes = new Uint8Array(descriptor.segmentCount);
  for (let index = 0; index < descriptor.segmentCount; index += 1) {
    const offset = (descriptor.segmentOffset + index) * visualization.recordStrideBytes;
    const coordinateOffset = index * 4;
    coordinates[coordinateOffset] = view.getFloat32(offset, true);
    coordinates[coordinateOffset + 1] = view.getFloat32(offset + 4, true);
    coordinates[coordinateOffset + 2] = view.getFloat32(offset + 8, true);
    coordinates[coordinateOffset + 3] = view.getFloat32(offset + 12, true);
    pathTypeIndexes[index] = view.getInt32(offset + 16, true);
  }

  const result: AuthorityToolpathLayerView = {
    index: layerIndex,
    z: summary.zMm,
    sourcePathCount: summary.pathCount,
    sourceSegmentCount: descriptor.sourceSegmentCount,
    segmentCount: descriptor.segmentCount,
    coordinates,
    pathTypeIndexes,
    pathTypes: visualization.pathTypes,
  };
  cachedLayers.set(layerIndex, result);
  return result;
}
