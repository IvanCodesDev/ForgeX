/* Stage 9.3 前半：STL / 3MF 网格导入（浏览器预览解析）的引擎级测试。
   夹具全部在测试内程序化生成（二进制/ASCII STL、含孔管件、stored/deflate 两种 3MF），
   不向仓库放二进制文件；数值期望为几何真值或当前实现的实测输出（切片统计）。 */
import { describe, expect, it } from "vitest";
import {
  analyzeTriangles,
  createMeshModel,
  detectMeshFormat,
  meshCrossSection,
  parse3mf,
  parseMeshBuffer,
  parseStlAscii,
  parseStlBinary,
} from "./mesh-import.ts";
import { buildGeometry } from "./models.ts";
import { stlFromTriangles, trianglesFromGeometry, type GeometryLike } from "./exporter.ts";
import { polyArea } from "./util.ts";
import { slice, type SliceSettings, type SliceTransform } from "./slicer.ts";

/* ── 几何夹具 ─────────────────────────────── */

type P = [number, number, number];
/** 四边形 → 两个三角形；p0..p3 按从外侧看逆时针给出 */
function quad(out: number[], p0: P, p1: P, p2: P, p3: P, flip = false): void {
  const tri = (a: P, b: P, c: P) => (flip ? out.push(...a, ...c, ...b) : out.push(...a, ...b, ...c));
  tri(p0, p1, p2);
  tri(p0, p2, p3);
}
function boxSides(out: number[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, flip = false) {
  quad(out, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], flip); // −Y
  quad(out, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], flip); // +Y
  quad(out, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], flip); // −X
  quad(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], flip); // +X
}
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const out: number[] = [];
  quad(out, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); // −Z
  quad(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
  boxSides(out, x0, y0, z0, x1, y1, z1);
  return out;
}
/** 方管：外 20×20、内 10×10、高 10（水密，含一个通孔） */
function tube(): number[] {
  const out: number[] = [];
  const [x0, y0, x1, y1] = [-10, -10, 10, 10];
  const [xi0, yi0, xi1, yi1] = [-5, -5, 5, 5];
  const [z0, z1] = [0, 10];
  boxSides(out, x0, y0, z0, x1, y1, z1);
  boxSides(out, xi0, yi0, z0, xi1, yi1, z1, true);
  const strips: Array<[P, P, P, P]> = [
    [
      [x0, y0, z1],
      [x1, y0, z1],
      [xi1, yi0, z1],
      [xi0, yi0, z1],
    ],
    [
      [x1, y0, z1],
      [x1, y1, z1],
      [xi1, yi1, z1],
      [xi1, yi0, z1],
    ],
    [
      [x1, y1, z1],
      [x0, y1, z1],
      [xi0, yi1, z1],
      [xi1, yi1, z1],
    ],
    [
      [x0, y1, z1],
      [x0, y0, z1],
      [xi0, yi0, z1],
      [xi0, yi1, z1],
    ],
  ];
  for (const [a, b, c, d] of strips) {
    quad(out, a, b, c, d);
    const low = (p: P): P => [p[0], p[1], z0];
    quad(out, low(a), low(d), low(c), low(b));
  }
  return out;
}

function stlBinary(coords: number[], extraTail = 0): ArrayBuffer {
  const n = coords.length / 9;
  const buf = new ArrayBuffer(84 + 50 * n + extraTail);
  const view = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode("FORGE-X test fixture"), 0);
  view.setUint32(80, n, true);
  let off = 84;
  for (let t = 0; t < n; t++) {
    off += 12;
    for (let k = 0; k < 9; k++) {
      view.setFloat32(off, coords[t * 9 + k]!, true);
      off += 4;
    }
    off += 2;
  }
  return buf;
}
function stlAscii(coords: number[]): string {
  const lines = ["solid fixture"];
  for (let t = 0; t < coords.length; t += 9) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (let k = 0; k < 9; k += 3)
      lines.push(`      vertex ${coords[t + k]!.toExponential(3)} ${coords[t + k + 1]} ${coords[t + k + 2]}`);
    lines.push("    endloop", "  endfacet");
  }
  lines.push("endsolid fixture");
  return lines.join("\r\n");
}

/* ── 最小 ZIP 写入器（stored / deflate） ─── */

interface ZipInput {
  name: string;
  data: Uint8Array;
  deflate?: boolean;
}
async function zip(entries: ZipInput[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const payload = e.deflate
      ? new Uint8Array(
          await new Response(
            new Blob([new Uint8Array(e.data)]).stream().pipeThrough(new CompressionStream("deflate-raw"))
          ).arrayBuffer()
        )
      : e.data;
    const method = e.deflate ? 8 : 0;
    const local = Uint8Array.from([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(payload.length),
      ...u32(e.data.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]);
    central.push(
      Uint8Array.from([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(method),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(payload.length),
        ...u32(e.data.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...name,
      ])
    );
    parts.push(local, payload);
    offset += local.length + payload.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = Uint8Array.from([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(cdSize),
    ...u32(offset),
    ...u16(0),
  ]);
  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of [...parts, ...central, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const BOX_3MF_MESH = `
  <mesh>
    <vertices>
      <vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="10" z="0"/><vertex x="0" y="10" z="0"/>
      <vertex x="0" y="0" z="10"/><vertex x="20" y="0" z="10"/><vertex x="20" y="10" z="10"/><vertex x="0" y="10" z="10"/>
    </vertices>
    <triangles>
      <triangle v1="0" v2="3" v3="2"/><triangle v1="0" v2="2" v3="1"/>
      <triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
      <triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/>
      <triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/>
      <triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/>
      <triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
    </triangles>
  </mesh>`;

function modelXml(unit: string, body: string): Uint8Array {
  return new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">${body}</model>`
  );
}
const CONTENT_TYPES = new TextEncoder().encode(
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`
);

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

/* ── STL ──────────────────────────────────── */

describe("STL 解析与归一化", () => {
  const BOX = box(5, 7, 3, 25, 27, 13); // 20×20×10，故意偏离原点

  it("二进制 STL：12 个三角形，包围盒居中、Z 归零，体积 4 cm³", async () => {
    const payload = await parseMeshBuffer(stlBinary(BOX), "box.stl");
    expect(payload.format).toBe("stl-binary");
    expect(payload.triangleCount).toBe(12);
    expect(payload.droppedTriangles).toBe(0);
    expect(payload.objectCount).toBe(1);
    expect(payload.bounds).toEqual({ minX: -10, maxX: 10, minY: -10, maxY: 10, minZ: 0, maxZ: 10 });
    expect(payload.sizeMm).toEqual({ x: 20, y: 20, z: 10 });
    expect(payload.volumeCm3).toBeCloseTo(4, 9);
    expect(payload.surfaceAreaCm2).toBeCloseTo(16, 9); // 2×400 + 4×200 = 1600 mm²
    expect(payload.overhangAreaMm2).toBe(0);
    expect(payload.needSupport).toBe(false);
    expect(payload.unit).toBeNull();
    expect(payload.warnings).toEqual([]);
    expect(payload.positions.length).toBe(12 * 9);
  });

  it("ASCII STL：与二进制解析结果逐位一致（含 \\r\\n 与科学计数法）", async () => {
    const a = await parseMeshBuffer(new TextEncoder().encode(stlAscii(BOX)).buffer as ArrayBuffer, "box.stl");
    const b = await parseMeshBuffer(stlBinary(BOX), "box.stl");
    expect(a.format).toBe("stl-ascii");
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(a.volumeCm3).toBe(b.volumeCm3);
  });

  it("格式识别：ZIP 签名优先于扩展名；带尾巴的二进制 STL 按扩展名兜底", async () => {
    const bytes = (buf: ArrayBuffer) => new Uint8Array(buf);
    expect(detectMeshFormat("a.stl", bytes(stlBinary(BOX)))).toBe("stl-binary");
    expect(detectMeshFormat("a.STL", new TextEncoder().encode(stlAscii(BOX)))).toBe("stl-ascii");
    expect(detectMeshFormat("weird.bin", new TextEncoder().encode("solid x\nfacet"))).toBe("stl-ascii");
    expect(detectMeshFormat("model.3mf", new Uint8Array([1, 2, 3, 4]))).toBe("3mf");
    expect(detectMeshFormat("model.stl", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("3mf");
    expect(detectMeshFormat("unknown.bin", new Uint8Array(200))).toBeNull();
    // 尾部多 3 个字节：长度公式不吻合，但扩展名兜底后仍能按声明的三角数解析
    const tailed = await parseMeshBuffer(stlBinary(BOX, 3), "box.stl");
    expect(tailed.triangleCount).toBe(12);
  });

  it("退化三角形被丢弃并计入 warnings；全反法向给出提示", () => {
    const coords = box(0, 0, 0, 10, 10, 10);
    coords.push(0, 0, 0, 1, 1, 1, 2, 2, 2); // 共线 → 零面积
    coords.push(0, 0, 0, 1, 0, 0, NaN, 1, 0);
    const p = analyzeTriangles(Float32Array.from(coords), "stl-binary", { objectCount: 1, unit: null, warnings: [] });
    expect(p.triangleCount).toBe(12);
    expect(p.droppedTriangles).toBe(2);
    expect(p.warnings).toEqual(["已丢弃 2 个退化三角形"]);
    const inverted: number[] = [];
    const src = box(0, 0, 0, 10, 10, 10);
    for (let t = 0; t < src.length; t += 9)
      inverted.push(...src.slice(t, t + 3), ...src.slice(t + 6, t + 9), ...src.slice(t + 3, t + 6));
    const q = analyzeTriangles(Float32Array.from(inverted), "stl-binary", { objectCount: 1, unit: null, warnings: [] });
    expect(q.volumeCm3).toBeCloseTo(1, 9);
    expect(q.warnings).toEqual(["三角形法向整体朝内（有向体积为负），体积已按绝对值计算"]);
  });

  it("悬垂启发式：T 形件的悬空底面计入 overhangAreaMm2 → needSupport", () => {
    const t = [...box(-5, -5, 0, 5, 5, 10), ...box(-15, -15, 10, 15, 15, 15)];
    const p = analyzeTriangles(Float32Array.from(t), "stl-binary", { objectCount: 1, unit: null, warnings: [] });
    expect(p.overhangAreaMm2).toBe(900); // 30×30 悬空底面（贴床的 10×10 底面不计）
    expect(p.needSupport).toBe(true);
    expect(p.sizeMm).toEqual({ x: 30, y: 30, z: 15 });
  });

  it("错误路径：空文件 / 未知格式 / 声明三角数超出文件长度 / 顶点数不整", async () => {
    await expect(parseMeshBuffer(new ArrayBuffer(0), "x.stl")).rejects.toThrow("ASCII STL 中没有 vertex 记录");
    await expect(parseMeshBuffer(new ArrayBuffer(200), "x.bin")).rejects.toThrow("无法识别的网格格式");
    const truncated = stlBinary(BOX).slice(0, 84 + 50 * 5);
    new DataView(truncated).setUint32(80, 12, true);
    expect(() => parseStlBinary(new Uint8Array(truncated))).toThrow("文件长度不足");
    expect(() => parseStlAscii("solid a\nvertex 0 0 0\nvertex 1 0 0\nendsolid")).toThrow("不是 3 的倍数");
    await expect(parseMeshBuffer(new ArrayBuffer(64 * 1024 * 1024 + 1), "big.stl")).rejects.toThrow("超过 64MB");
  });
});

/* ── 3MF ──────────────────────────────────── */

describe("3MF 解析（ZIP + XML，零依赖）", () => {
  it("stored 条目：components 复用 + item 变换 + 对象计数", async () => {
    const model = modelXml(
      "millimeter",
      `<resources>
         <object id="1" type="model">${BOX_3MF_MESH}</object>
         <object id="7" type="support">${BOX_3MF_MESH}</object>
         <object id="2" type="model">
           <components>
             <component objectid="1" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>
             <component objectid="1"/>
           </components>
         </object>
       </resources>
       <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 5"/></build>`
    );
    const bytes = await zip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "3D/3dmodel.model", data: model },
    ]);
    const r = await parse3mf(bytes);
    expect(r.unit).toBe("millimeter");
    expect(r.objectCount).toBe(2);
    expect(r.positions.length).toBe(24 * 9);
    expect(r.warnings).toEqual([]);
    const p = analyzeTriangles(r.positions, "3mf", { objectCount: r.objectCount, unit: r.unit, warnings: r.warnings });
    expect(p.sizeMm).toEqual({ x: 50, y: 10, z: 10 });
    expect(p.volumeCm3).toBeCloseTo(4, 9);
    // 两个盒子之间（x ∈ (20,30) 原坐标 → 归一化后 (−5,5)）在 z=5 处应有两个环
    const loops = meshCrossSection(p.positions, 5);
    expect(loops.length).toBe(2);
    for (const lp of loops) expect(Math.abs(polyArea(lp))).toBeCloseTo(200, 9);
  });

  it("deflate 条目经 DecompressionStream 解压；inch 单位换算为 mm；缩放变换", async () => {
    const model = modelXml(
      "inch",
      `<resources><object id="1" type="model">${BOX_3MF_MESH}</object></resources>
       <build><item objectid="1" transform="0.5 0 0 0 0.5 0 0 0 0.5 0 0 0"/></build>`
    );
    const bytes = await zip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES, deflate: true },
      { name: "3D/3dmodel.model", data: model, deflate: true },
    ]);
    const payload = await parseMeshBuffer(bytes.buffer as ArrayBuffer, "box.3mf");
    expect(payload.format).toBe("3mf");
    expect(payload.unit).toBe("inch");
    // 20×10×10 × 0.5 = 10×5×5 inch → mm
    expect(payload.sizeMm.x).toBeCloseTo(254, 9);
    expect(payload.sizeMm.y).toBeCloseTo(127, 9);
    expect(payload.sizeMm.z).toBeCloseTo(127, 9);
    expect(payload.volumeCm3).toBeCloseTo((254 * 127 * 127) / 1000, 6);
  });

  it("缺少 <build> 时按全部 model 对象原位导入并提示；引用不存在的对象只告警", async () => {
    const model = modelXml(
      "millimeter",
      `<resources><object id="1" type="model">${BOX_3MF_MESH}</object>
       <object id="3" type="model"><components><component objectid="99"/><component objectid="1"/></components></object></resources>`
    );
    const bytes = await zip([{ name: "3D/3dmodel.model", data: model }]);
    const r = await parse3mf(bytes);
    expect(r.objectCount).toBe(2); // 对象 1 直接 + 经对象 3 的组件再引用一次
    expect(r.warnings).toEqual([
      "3MF 缺少 <build> 段，已按全部 model 对象原位导入",
      "3MF 引用了不存在的对象 3D/3dmodel.model#99，已跳过",
    ]);
  });

  it("错误路径：无 .model 部件 / 非 ZIP / 未知单位 / 三角形越界顶点", async () => {
    await expect(parse3mf(await zip([{ name: "readme.txt", data: new Uint8Array([65]) }]))).rejects.toThrow(
      "没有 .model 部件"
    );
    await expect(
      parseMeshBuffer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]).buffer as ArrayBuffer, "x.3mf")
    ).rejects.toThrow("找不到目录结尾记录");
    const badUnit = await zip([
      {
        name: "3D/3dmodel.model",
        data: modelXml("parsec", `<resources><object id="1" type="model">${BOX_3MF_MESH}</object></resources>`),
      },
    ]);
    await expect(parse3mf(badUnit)).rejects.toThrow("未知单位 parsec");
    const badIndex = await zip([
      {
        name: "3D/3dmodel.model",
        data: modelXml(
          "millimeter",
          `<resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="9"/></triangles></mesh></object></resources><build><item objectid="1"/></build>`
        ),
      },
    ]);
    await expect(parse3mf(badIndex)).rejects.toThrow("引用了不存在的顶点 9");
  });
});

/* ── 平面截交 → 切片 ──────────────────────── */

describe("平面截交与切片器接入", () => {
  it("方块截面：一个 CCW 外环，面积 400；顶点恰在平面上不产生重复环", async () => {
    const payload = await parseMeshBuffer(stlBinary(box(0, 0, 0, 20, 20, 10)), "box.stl");
    const model = createMeshModel(payload, { name: "box.stl" });
    expect(model.id).toBe("mesh-import");
    expect(model.kind).toBe("mesh");
    expect(model.name).toBe("box");
    expect(model.dims).toBe("20.0 × 20.0 × 10.0 mm");
    expect(model.footprintR).toBe(10);
    expect(model.height).toBe(10);
    const sec = model.outlinesAt!(5)!;
    expect(sec.loops!.length).toBe(1);
    expect(sec.loops![0]!.hole).toBe(false);
    expect(polyArea(sec.loops![0]!.pts)).toBeCloseTo(400, 9);
    expect(sec.loops![0]!.pts.length).toBe(8); // 每个侧面两个三角形 → 8 段（共线点保留）
    // 半开规则（z >= 平面 = 上方）：底面 z=0 全部「上方」→ 无截交；顶面 z=10 只剩侧壁贡献的顶边一圈
    expect(meshCrossSection(payload.positions, 0).length).toBe(0);
    expect(meshCrossSection(payload.positions, 10).length).toBe(1);
    expect(meshCrossSection(payload.positions, 10.5).length).toBe(0);
    expect(meshCrossSection(payload.positions, 5, new Uint32Array([0, 1]))).toEqual([]); // 只给底面两个三角形 → 无截交
  });

  it("方管截面：外环 CCW、内环标记为孔且 CW", async () => {
    const payload = await parseMeshBuffer(stlBinary(tube()), "tube.stl");
    expect(payload.volumeCm3).toBeCloseTo(3, 9); // (400 − 100) × 10
    const model = createMeshModel(payload, { name: "tube.stl" });
    const loops = model.outlinesAt!(2.5)!.loops!;
    expect(loops.length).toBe(2);
    const outer = loops.find((l) => !l.hole)!;
    const hole = loops.find((l) => l.hole)!;
    expect(polyArea(outer.pts)).toBeCloseTo(400, 9);
    expect(polyArea(hole.pts)).toBeCloseTo(-100, 9);
  });

  it("切片：方块 50 层，周界 / 填充 / 裙边统计锁定", async () => {
    const payload = await parseMeshBuffer(stlBinary(box(0, 0, 0, 20, 20, 10)), "box.stl");
    const model = createMeshModel(payload, { name: "box.stl" });
    const out = slice(model, TF, SETTINGS);
    expect(out.totalLayers).toBe(50);
    expect(out.height).toBe(10);
    const kinds = new Set(out.layers.flatMap((l) => l.paths.map((p) => p.type)));
    expect([...kinds].sort()).toEqual(["infill", "perimeter", "skirt", "solid"]);
    expect(out.layers[0]!.paths.filter((p) => p.type === "perimeter").length).toBe(2);
    expect(out.layers[25]!.paths.filter((p) => p.type === "infill").length).toBeGreaterThan(0);
    expect(out.layers[0]!.paths.length).toBe(5); // 裙边 + 2 周界 + 2 段实心填充
    expect(out.layers[25]!.paths.length).toBe(3);
    expect(out.stats.extLenMm).toBeCloseTo(21006.967504668475, 6);
    expect(out.stats.travelMm).toBeCloseTo(476.2442387854945, 6);
    expect(out.stats.timeSec).toBeCloseTo(545.18801976231, 6);
    expect(out.stats.volumeCm3).toBeCloseTo(1.764585270392152, 9);
    expect(out.stats.filamentM).toBeCloseTo(0.7336293049209723, 9);
  });

  it("buildGeometry：导入网格按 (x,y,z) → (x,z,−y) 进入世界系", async () => {
    const payload = await parseMeshBuffer(stlBinary(box(0, 0, 0, 20, 10, 6)), "box.stl");
    const geo = buildGeometry(createMeshModel(payload, { name: "box.stl" }));
    expect(geo.attributes.position!.count).toBe(36);
    geo.computeBoundingBox();
    expect(geo.boundingBox!.min.toArray()).toEqual([-10, 0, -5]);
    expect(geo.boundingBox!.max.toArray()).toEqual([10, 6, 5]);
    expect(geo.attributes.normal).toBeDefined();
  });

  it("导出往返：导入 STL → buildGeometry → 导出 STL，顶点逐位等于归一化坐标，再导入结果不变", async () => {
    const payload = await parseMeshBuffer(stlBinary(box(5, 7, 3, 25, 27, 13)), "box.stl");
    const model = createMeshModel(payload, { name: "box.stl" });
    const tris = trianglesFromGeometry(buildGeometry(model) as unknown as GeometryLike, 1);
    expect(tris).toHaveLength(12);
    const flat = tris.flatMap((t) => t.flatMap((v) => [v.x, v.y, v.z]));
    expect(flat).toEqual(Array.from(payload.positions)); // Y-up ↔ Z-up 两次映射互逆
    const exported = stlFromTriangles(tris, model.name);
    expect(exported.byteLength).toBe(84 + 50 * 12);
    const again = await parseMeshBuffer(exported, "box-roundtrip.stl");
    expect(again.format).toBe("stl-binary");
    expect(Array.from(again.positions)).toEqual(Array.from(payload.positions));
    expect(again.volumeCm3).toBe(payload.volumeCm3);
    expect(again.bounds).toEqual(payload.bounds);
  });
});
