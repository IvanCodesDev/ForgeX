/* ParsedGcodeResult ⇄ Transferable 打包（纯逻辑；Worker 与主线程共用）。

   为什么不直接 postMessage 解析结果：64 MB 级 G-code 的层/路径/点是
   百万级小对象图，结构化克隆的「反序列化」发生在主线程接收侧，本身就是
   一条秒级长任务——恰好抵消 Worker 化的意义。改为把点坐标与逐层/逐路径
   标量压进 TypedArray（Transferable 零拷贝转移），主线程再分片重建对象图，
   每片让出事件循环，任何单条任务都远小于 50ms 长任务口径。 */
import type { GcodeLayer, GcodePath, ParsedGcodeResult } from "../../engine/gcode-parser";
import type { Point2 } from "../../engine/util";

/** layers 之外的全部标量与小结构：体积小，走普通结构化克隆即可 */
export type PackedGcodeMeta = Omit<ParsedGcodeResult, "layers">;

export interface PackedParsedGcode {
  readonly meta: PackedGcodeMeta;
  /** 路径类型字符串表（parser 收敛后 ≤6 种，索引进 pathTypeIndex） */
  readonly pathTypes: string[];
  readonly layerZ: Float64Array;
  /** 每层 3 个：extLen, travelLen, timeSec */
  readonly layerStats: Float64Array;
  readonly layerPathCount: Uint32Array;
  readonly pathPointCount: Uint32Array;
  readonly pathTypeIndex: Uint16Array;
  /** 每路径 3 个：speed, filamentMm, len（len 缺省写 NaN） */
  readonly pathStats: Float64Array;
  /** 每点 2 个：x, y */
  readonly coords: Float64Array;
}

export function packParsedGcode(parsed: ParsedGcodeResult): PackedParsedGcode {
  const { layers, ...meta } = parsed;
  let pathCount = 0;
  let pointCount = 0;
  for (const layer of layers) {
    pathCount += layer.paths.length;
    for (const path of layer.paths) pointCount += path.pts.length;
  }

  const pathTypes: string[] = [];
  const typeIndexByName = new Map<string, number>();
  const layerZ = new Float64Array(layers.length);
  const layerStats = new Float64Array(layers.length * 3);
  const layerPathCount = new Uint32Array(layers.length);
  const pathPointCount = new Uint32Array(pathCount);
  const pathTypeIndex = new Uint16Array(pathCount);
  const pathStats = new Float64Array(pathCount * 3);
  const coords = new Float64Array(pointCount * 2);

  let pathCursor = 0;
  let coordCursor = 0;
  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx]!;
    layerZ[layerIdx] = layer.z;
    layerStats[layerIdx * 3] = layer.extLen;
    layerStats[layerIdx * 3 + 1] = layer.travelLen;
    layerStats[layerIdx * 3 + 2] = layer.timeSec;
    layerPathCount[layerIdx] = layer.paths.length;
    for (const path of layer.paths) {
      let typeIndex = typeIndexByName.get(path.type);
      if (typeIndex == null) {
        typeIndex = pathTypes.length;
        if (typeIndex > 0xffff) throw new Error("G-code 路径类型表超出 Uint16 上限");
        pathTypes.push(path.type);
        typeIndexByName.set(path.type, typeIndex);
      }
      pathPointCount[pathCursor] = path.pts.length;
      pathTypeIndex[pathCursor] = typeIndex;
      pathStats[pathCursor * 3] = path.speed;
      pathStats[pathCursor * 3 + 1] = path.filamentMm;
      pathStats[pathCursor * 3 + 2] = path.len ?? NaN;
      pathCursor++;
      for (const point of path.pts) {
        coords[coordCursor] = point.x;
        coords[coordCursor + 1] = point.y;
        coordCursor += 2;
      }
    }
  }
  return { meta, pathTypes, layerZ, layerStats, layerPathCount, pathPointCount, pathTypeIndex, pathStats, coords };
}

/** postMessage 的 transfer 清单：全部 TypedArray 底层 buffer 零拷贝转移 */
export function packedGcodeTransferables(packed: PackedParsedGcode): ArrayBuffer[] {
  return [
    packed.layerZ.buffer,
    packed.layerStats.buffer,
    packed.layerPathCount.buffer,
    packed.pathPointCount.buffer,
    packed.pathTypeIndex.buffer,
    packed.pathStats.buffer,
    packed.coords.buffer,
  ] as ArrayBuffer[];
}

export interface UnpackOptions {
  /** 每处理约这么多点就让出一次事件循环；默认值实测慢机（SwiftShader 测试机）单片 ≈ 35ms，常规硬件 ≈ 10ms */
  readonly pointsPerSlice?: number;
  /** 让出实现（可注入取消检查）；默认 setTimeout(0) */
  readonly yieldToEventLoop?: () => Promise<void>;
}

const DEFAULT_POINTS_PER_SLICE = 32_000;
const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * 分片重建与 parse() 输出同构的对象图。
 * 分片只发生在路径边界（单条路径的点数受挤出段连续性约束，天然远小于片预算）。
 */
export async function unpackParsedGcode(
  packed: PackedParsedGcode,
  options?: UnpackOptions
): Promise<ParsedGcodeResult> {
  const pointsPerSlice = options?.pointsPerSlice ?? DEFAULT_POINTS_PER_SLICE;
  const yieldToEventLoop = options?.yieldToEventLoop ?? defaultYield;
  const layers: GcodeLayer[] = [];
  let pathCursor = 0;
  let coordCursor = 0;
  let pointsSinceYield = 0;
  for (let layerIdx = 0; layerIdx < packed.layerZ.length; layerIdx++) {
    const layer: GcodeLayer = {
      z: packed.layerZ[layerIdx]!,
      paths: [],
      extLen: packed.layerStats[layerIdx * 3]!,
      travelLen: packed.layerStats[layerIdx * 3 + 1]!,
      timeSec: packed.layerStats[layerIdx * 3 + 2]!,
    };
    const pathTotal = packed.layerPathCount[layerIdx]!;
    for (let pathIdx = 0; pathIdx < pathTotal; pathIdx++) {
      const pointTotal = packed.pathPointCount[pathCursor]!;
      const pts: Point2[] = new Array(pointTotal);
      for (let k = 0; k < pointTotal; k++) {
        pts[k] = { x: packed.coords[coordCursor]!, y: packed.coords[coordCursor + 1]! };
        coordCursor += 2;
      }
      const path: GcodePath = {
        pts,
        type: packed.pathTypes[packed.pathTypeIndex[pathCursor]!]!,
        speed: packed.pathStats[pathCursor * 3]!,
        filamentMm: packed.pathStats[pathCursor * 3 + 1]!,
      };
      const len = packed.pathStats[pathCursor * 3 + 2]!;
      if (!Number.isNaN(len)) path.len = len;
      layer.paths.push(path);
      pathCursor++;
      pointsSinceYield += pointTotal;
      if (pointsSinceYield >= pointsPerSlice) {
        pointsSinceYield = 0;
        await yieldToEventLoop();
      }
    }
    layers.push(layer);
  }
  return { ...packed.meta, layers };
}
