/* 导出引擎（Stage 7.4 前置：自 tests/exporter.test.js 迁入 vitest，改测 TS 引擎）
   覆盖：三角提取（Y-up→Z-up、缩放）/ 二进制 STL 结构 / OBJ 结构 / G-code 语义与挤出量守恒。
   经典 JS 版删除后，本文件即为导出链唯一的回归护栏。 */
import { describe, expect, it } from "vitest";
import {
  gcode,
  objFromTriangles,
  stlFromTriangles,
  trianglesFromGeometry,
  type GcodeExportSettings,
} from "./exporter.ts";
import { createBuiltins } from "./models.ts";
import { slice, type SliceSettings } from "./slicer.ts";

const ST: SliceSettings & GcodeExportSettings = {
  material: "PLA",
  layerHeight: 0.2,
  extrusionWidth: 0.45,
  perimeters: 2,
  solidLayers: 3,
  infillDensity: 0.18,
  nozzleTemp: 210,
  bedTemp: 60,
  speed: 120,
  travelSpeed: 260,
  retraction: 1.2,
  fanSpeed: 100,
  supportEnabled: true,
  supportSpacing: 4.5,
  skirtLoops: 2,
  skirtGap: 5,
  autoLevel: true,
};
const TF = { scale: 1, rotZ: 0, offX: 0, offY: 0 };

describe("三角网格提取（Y-up → Z-up · 缩放）", () => {
  // 一个三角形：世界系 (0,0,0) (1,0,0) (0,2,-3) —— Y 为高度
  const geo = {
    attributes: { position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, -3]) } },
    index: null,
  };

  it("非索引几何 → 1 个三角，世界 (0,2,-3) → Z-up (0,3,2)", () => {
    const tris = trianglesFromGeometry(geo, 1);
    expect(tris).toHaveLength(1);
    const c = tris[0]![2];
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.y).toBeCloseTo(3, 9);
    expect(c.z).toBeCloseTo(2, 9);
  });

  it("2× 缩放生效", () => {
    expect(trianglesFromGeometry(geo, 2)[0]![2].y).toBeCloseTo(6, 9);
  });

  it("索引几何 → 2 个三角", () => {
    const geoIdx = {
      attributes: { position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]) } },
      index: { array: [0, 1, 2, 0, 2, 3] },
    };
    expect(trianglesFromGeometry(geoIdx, 1)).toHaveLength(2);
  });
});

describe("二进制 STL 结构", () => {
  const tris: Parameters<typeof stlFromTriangles>[0] = [
    [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 10, z: 0 },
    ],
    [
      { x: 0, y: 0, z: 5 },
      { x: 10, y: 0, z: 5 },
      { x: 0, y: 10, z: 5 },
    ],
  ];

  it("字节数 = 84 + 50×n，uint32 三角数、法线、顶点、属性字节均正确", () => {
    const buf = stlFromTriangles(tris, "unit-test");
    expect(buf.byteLength).toBe(84 + 50 * 2);
    const dv = new DataView(buf);
    expect(dv.getUint32(80, true)).toBe(2);
    // 首三角法线应为 +Z（逆时针在 XY 平面）
    expect(dv.getFloat32(84 + 8, true)).toBeCloseTo(1, 6);
    expect(dv.getFloat32(84 + 12, true)).toBeCloseTo(0, 9); // 顶点小端写入
    expect(dv.getUint16(84 + 48, true)).toBe(0); // attribute byte count
  });

  it("头部写入名称并把非 ASCII 字符替换为 ?", () => {
    const dv = new DataView(stlFromTriangles(tris, "齿轮 v2"));
    const header = Array.from({ length: 80 }, (_, i) => dv.getUint8(i))
      .filter((c) => c !== 0)
      .map((c) => String.fromCharCode(c))
      .join("");
    expect(header).toBe("FORGE-X binary STL ?? v2");
  });
});

describe("OBJ 结构", () => {
  it("v 行 = 3×n、f 行 = n、对象名空格转下划线、面索引从 1 起", () => {
    const obj = objFromTriangles(
      [
        [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0 },
          { x: 0, y: 10, z: 0 },
        ],
      ],
      "行星齿轮 v2"
    );
    const lines = obj.split("\n");
    expect(lines.filter((l) => l.startsWith("v "))).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith("f "))).toEqual(["f 1 2 3"]);
    expect(obj).toContain("o 行星齿轮_v2");
  });
});

describe("G-code 语义（真实切片 → 可切片器核验的输出）", () => {
  const gear = createBuiltins()[0]!;
  const sliced = slice(gear, TF, ST);
  const g = gcode(sliced, ST, { model: gear.name, printer: "FX-256", densityG: 1.24 });
  const lines = g.split("\n");

  it("温度、相对挤出、归位、调平、层标记、风扇与收尾指令齐全", () => {
    for (const cmd of ["M104 S210", "M109 S210", "M140 S60", "M190 S60", "M83", "G28 ; home", "G29"]) {
      expect(g).toContain(cmd);
    }
    expect(g).toContain(`;LAYER_COUNT:${sliced.totalLayers}`);
    expect(g).toContain(";LAYER:0");
    expect(g).toContain(`;LAYER:${sliced.totalLayers - 1}`);
    expect(g).toContain("M107 ; fan off for first layer");
    expect(g).toContain("M106 S255");
    for (const cmd of ["M104 S0", "M140 S0", "M84"]) expect(g).toContain(cmd);
  });

  it("挤出量守恒（ΣE ≈ 理论耗材长 ±1%）、回抽/回填成对、坐标落在床内且居中", () => {
    let eSum = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let retracts = 0;
    let unretracts = 0;
    for (const ln of lines) {
      const me = ln.match(/^G1 .*E(-?\d+(?:\.\d+)?)/);
      if (me) {
        if (ln.includes("; retract")) {
          retracts++;
          continue;
        }
        if (ln.includes("; unretract")) {
          unretracts++;
          continue;
        }
        eSum += parseFloat(me[1]!);
      }
      const mx = ln.match(/X(\d+(?:\.\d+)?) Y(\d+(?:\.\d+)?)/);
      if (mx) {
        const x = parseFloat(mx[1]!);
        const y = parseFloat(mx[2]!);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    const expectE = (sliced.stats.extLenMm * (ST.extrusionWidth * ST.layerHeight)) / (Math.PI * 0.875 * 0.875);
    expect(Math.abs(eSum - expectE) / expectE).toBeLessThan(0.01);
    expect(retracts).toBeGreaterThan(0);
    expect(retracts).toBe(unretracts);
    expect(minX).toBeGreaterThanOrEqual(0);
    expect(maxX).toBeLessThanOrEqual(256);
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(maxY).toBeLessThanOrEqual(256);
    // 齿轮 Ø55 居中 → X 范围应跨约 128±40
    expect(minX).toBeLessThan(108);
    expect(maxX).toBeGreaterThan(148);
  });
});
