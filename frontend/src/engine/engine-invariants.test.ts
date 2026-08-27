/* Stage 10.4 引擎数值锁定：切片器与 G-code 解析器在固定输入下的关键几何/运动数值。
   这些期望值是当前实现的实测输出（与 classic 版逐位对齐的 TS 引擎），
   作用是把「迁移/重构造成的静默数值漂移」变成显式测试失败——
   若因**有意**的算法调整而失败，请核实差异后更新期望值并在提交说明中写明原因。 */
import { describe, expect, it } from "vitest";
import { createBuiltins, type BuiltModel } from "./models.ts";
import { slice, type SliceSettings, type SliceTransform } from "./slicer.ts";
import { parse } from "./gcode-parser.ts";

const SETTINGS: SliceSettings = {
  layerHeight: 0.2,
  extrusionWidth: 0.42,
  solidLayers: 3,
  infillDensity: 0.2,
  infillPattern: "斜线网格",
  infillAngle: 0,
  perimeters: 2,
  supportEnabled: false,
  supportSpacing: 5,
  skirtLoops: 1,
  skirtGap: 6,
  speed: 60,
  travelSpeed: 150,
  retraction: 1,
};
const TF: SliceTransform = { scale: 1, rotZ: 0, offX: 0, offY: 0 };

function typeCount(paths: ReadonlyArray<{ type: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of paths) counts[p.type] = (counts[p.type] || 0) + 1;
  return counts;
}

function builtin(id: string): BuiltModel {
  const model = createBuiltins().find((m) => m.id === id);
  if (!model) throw new Error(`builtin model ${id} missing`);
  return model;
}

describe("切片器数值锁定（Stage 10.4）", () => {
  it("行星齿轮 · 默认工艺：层数、总量统计与首层构成保持", () => {
    const out = slice(builtin("gear"), TF, SETTINGS);
    expect(out.totalLayers).toBe(80);
    expect(out.height).toBe(16);
    expect(out.stats.extLenMm).toBeCloseTo(96939.66953777178, 6);
    expect(out.stats.travelMm).toBeCloseTo(29650.651590205474, 6);
    expect(out.stats.timeSec).toBeCloseTo(2887.768720945661, 6);
    expect(out.stats.volumeCm3).toBeCloseTo(8.142932241172831, 9);
    expect(out.stats.filamentM).toBeCloseTo(3.385437825162506, 9);

    const layer0 = out.layers[0]!;
    expect(layer0.z).toBeCloseTo(0.2, 12);
    expect(typeCount(layer0.paths)).toEqual({ skirt: 1, perimeter: 12, solid: 250 });
    expect(layer0.extLen).toBeCloseTo(3999.9432972530435, 6);
    expect(layer0.travelLen).toBeCloseTo(2065.270501130468, 6);
    expect(layer0.timeSec).toBeCloseTo(211.99204050660222, 6);

    // 首条周界的起点坐标：offsetLoop 的法线偏置几何一变这里立刻红
    const firstPerimeter = layer0.paths.find((p) => p.type === "perimeter")!;
    expect(firstPerimeter.pts[0]!.x).toBeCloseTo(23.868286713529134, 9);
    expect(firstPerimeter.pts[0]!.y).toBeCloseTo(-2.4127286666313785, 9);

    const mid = out.layers[40]!;
    expect(typeCount(mid.paths)).toEqual({ perimeter: 12, infill: 35 });
    expect(mid.extLen).toBeCloseTo(1634.7677366714402, 6);
  });

  it("涡轮叶轮 · 蜂窝填充 + 旋转/平移变换：动态轮廓与蜂窝裁剪保持", () => {
    const out = slice(
      builtin("impeller"),
      { scale: 1, rotZ: 15, offX: 2, offY: -3 },
      { ...SETTINGS, infillPattern: "蜂窝", infillDensity: 0.15 }
    );
    expect(out.totalLayers).toBe(150);
    expect(out.height).toBe(30);
    expect(out.stats.extLenMm).toBeCloseTo(109546.03074299451, 6);
    expect(out.stats.travelMm).toBeCloseTo(49129.77007674185, 6);
    expect(out.stats.timeSec).toBeCloseTo(3718.254553653778, 6);
    expect(out.stats.filamentM).toBeCloseTo(3.8256915650949805, 9);

    const layer0 = out.layers[0]!;
    expect(typeCount(layer0.paths)).toEqual({ skirt: 1, perimeter: 4, solid: 34 });
    expect(layer0.extLen).toBeCloseTo(5187.928098957698, 6);

    // 中层：轮毂 + 7 片扭转叶片 = 周界 18 条（含孔），蜂窝填充 24 条折线
    const mid = out.layers[75]!;
    expect(typeCount(mid.paths)).toEqual({ perimeter: 18, infill: 24 });
    expect(mid.extLen).toBeCloseTo(616.4063330047824, 6);

    const firstPerimeter = layer0.paths.find((p) => p.type === "perimeter")!;
    expect(firstPerimeter.pts[0]!.x).toBeCloseTo(26.911033813122323, 9);
    expect(firstPerimeter.pts[0]!.y).toBeCloseTo(3.6748913928505167, 9);
  });

  it("传感器支架 · 支撑启用：悬垂区支撑路径存在且总量保持", () => {
    const out = slice(builtin("bracket"), TF, { ...SETTINGS, supportEnabled: true });
    expect(out.totalLayers).toBe(150);
    expect(out.stats.extLenMm).toBeCloseTo(103770.55910552936, 6);
    expect(out.stats.travelMm).toBeCloseTo(6043.642782616995, 6);
    expect(out.stats.timeSec).toBeCloseTo(2564.134868203638, 6);
    expect(out.stats.filamentM).toBeCloseTo(3.6239939501468577, 9);

    expect(typeCount(out.layers[0]!.paths)).toEqual({ skirt: 1, perimeter: 6, solid: 35 });
    // 墙体段（z∈[4,26)）：法兰悬空区必须有支撑路径
    const mid = out.layers[75]!;
    expect(typeCount(mid.paths)).toEqual({ perimeter: 2, infill: 1, support: 1 });
    expect(mid.extLen).toBeCloseTo(482.56152036731964, 6);
    expect(out.layers[0]!.paths.some((p) => p.type === "support")).toBe(false);
  });
});

describe("G-code 解析器数值锁定（Stage 10.4）", () => {
  const GCODE = [
    ";TIME:120",
    ";Filament used: 0.5m",
    "M104 S210",
    "M140 S60",
    "G28",
    "G1 Z0.2 F600",
    "G1 X10 Y0 E1 F1200",
    "G1 X10 Y10 E2",
    "G0 X0 Y0",
    "G1 Z0.4",
    "G1 X10 Y0 E3 F1800",
    "G1 X10 Y10 E3.5",
  ].join("\n");

  it("挤出量按 E 真实增量、层按 Z 切分、声明按注释提取", () => {
    const parsed = parse(GCODE, { origin: "corner" });
    expect(parsed.totalLayers).toBe(2);
    expect(parsed.height).toBeCloseTo(0.4, 12);
    expect(parsed.layers.map((l) => l.z)).toEqual([0.2, 0.4]);

    expect(parsed.stats.extLenMm).toBeCloseTo(40, 9);
    expect(parsed.stats.travelMm).toBeCloseTo(14.142135623730951, 9);
    expect(parsed.stats.timeSec).toBeCloseTo(2.3737734478532144, 9);
    expect(parsed.stats.filamentM).toBeCloseTo(0.0035, 12); // E 增量 3.5mm，非路径长估算
    expect(parsed.stats.volumeCm3).toBeCloseTo(0.008418486563916397, 12);
    expect(parsed.stats.filamentG).toBeCloseTo(0.010438923339256332, 12);

    expect(parsed.claims).toEqual({ timeSec: 120, filamentMm: 500, nozzleTemp: 210, bedTemp: 60 });
    expect(parsed.bounds).toEqual({ minX: -128, maxX: -118, minY: -128, maxY: -118 });
    expect(parsed.warnings).toEqual([]);

    const layer0 = parsed.layers[0]!;
    expect(layer0.paths.map((p) => ({ type: p.type, speed: p.speed, filamentMm: p.filamentMm, len: p.len }))).toEqual([
      { type: "infill", speed: 20, filamentMm: 2, len: 20 },
    ]);
  });
});
