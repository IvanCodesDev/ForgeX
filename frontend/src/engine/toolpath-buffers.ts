/* FORGE·X — toolpath 顶点缓冲构建（纯逻辑；不得引用 DOM 或 THREE）。

   自 printer3d.attachToolpath 的内联采样循环提取：算法逐行保留（分段计数、
   stride 采样、逐层 ranges），仅把输出从 number[] 换成 Float32Array——
   数值经 float32 舍入后与旧 Float32BufferAttribute(number[]) 完全一致。

   提取动机（V1 §5.5）：G-code 导入走 Web Worker 后，「传给 Three.js 前的
   顶点缓冲构建」也要在 Worker 里完成；渲染层与 Worker 共用同一实现，
   避免两份采样逻辑各自漂移。 */

export interface ToolpathPoint {
  readonly x: number;
  readonly y: number;
}

export interface ToolpathPathLike {
  readonly pts: readonly ToolpathPoint[];
}

export interface ToolpathLayerLike {
  readonly z: number;
  readonly paths: readonly ToolpathPathLike[];
}

export interface ToolpathBuffers {
  /** 每段 6 个 float32：ax, z, -ay, bx, z, -by（与 THREE LineSegments 的世界系一致） */
  readonly positions: Float32Array;
  /** 逐层累计顶点数（positions/3 的运行值），逐层回放 setDrawRange 依赖 */
  readonly ranges: Array<{ z: number; count: number }>;
  readonly stride: number;
}

/** 与旧 attachToolpath 相同的段数上限：超出后按 2 的幂以外的最小步长抽稀 */
export const TOOLPATH_MAX_SEGMENTS = 400000;

export function buildToolpathBuffers(
  layers: readonly ToolpathLayerLike[],
  maxSegments: number = TOOLPATH_MAX_SEGMENTS
): ToolpathBuffers {
  let totalSegments = 0;
  for (const layer of layers) for (const path of layer.paths) totalSegments += Math.max(0, path.pts.length - 1);
  const stride = Math.max(1, Math.ceil(totalSegments / maxSegments));
  const sampledSegments = totalSegments > 0 ? Math.floor((totalSegments - 1) / stride) + 1 : 0;

  const positions = new Float32Array(sampledSegments * 6);
  const ranges: Array<{ z: number; count: number }> = [];
  let seen = 0;
  let write = 0;
  for (const layer of layers) {
    for (const path of layer.paths) {
      for (let i = 1; i < path.pts.length; i++) {
        if (seen % stride === 0) {
          const a = path.pts[i - 1]!;
          const b = path.pts[i]!;
          positions[write] = a.x;
          positions[write + 1] = layer.z;
          positions[write + 2] = -a.y;
          positions[write + 3] = b.x;
          positions[write + 4] = layer.z;
          positions[write + 5] = -b.y;
          write += 6;
        }
        seen++;
      }
    }
    ranges.push({ z: layer.z, count: write / 3 });
  }
  return { positions, ranges, stride };
}
