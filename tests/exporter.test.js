/* FORGE·X 导出引擎测试（node tests/exporter.test.js）
   覆盖：三角提取（Y-up→Z-up、缩放）/ 二进制 STL 结构 / OBJ 结构 / G-code 语义与挤出量守恒 */
"use strict";
const path = require("path");
const J = (p) => path.join(__dirname, "..", "js", p);

require(J("util.js"));
require(J("slicer.js"));
require(J("models.js"));
require(J("exporter.js"));

const FXU = globalThis.FXU, FXSlicer = globalThis.FXSlicer,
      FXModels = globalThis.FXModels, FXExport = globalThis.FXExport;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const ST = {
  material: "PLA", layerHeight: 0.2, extrusionWidth: 0.45, perimeters: 2, solidLayers: 3,
  infillDensity: 0.18, nozzleTemp: 210, bedTemp: 60, speed: 120, travelSpeed: 260,
  retraction: 1.2, fanSpeed: 100, supportEnabled: true, supportSpacing: 4.5,
  skirtLoops: 2, skirtGap: 5, zOffset: 0, autoLevel: true,
};
const TF = { scale: 1, rotZ: 0, offX: 0, offY: 0 };

console.log("\n[1] 三角网格提取（Y-up → Z-up · 缩放）");
{
  // 一个三角形：世界系 (0,0,0) (1,0,0) (0,2,-3) —— Y 为高度
  const geo = {
    attributes: { position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, -3]) } },
    index: null,
  };
  const tris = FXExport.trianglesFromGeometry(geo, 1);
  check("非索引几何 → 1 个三角", tris.length === 1, String(tris.length));
  const c = tris[0][2];
  check("Z-up 转换：世界(0,2,-3) → (0,3,2)", Math.abs(c.x) < 1e-9 && Math.abs(c.y - 3) < 1e-9 && Math.abs(c.z - 2) < 1e-9,
    JSON.stringify(c));
  const tris2 = FXExport.trianglesFromGeometry(geo, 2);
  check("2× 缩放生效", Math.abs(tris2[0][2].y - 6) < 1e-9, JSON.stringify(tris2[0][2]));
  const geoIdx = {
    attributes: { position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]) } },
    index: { array: [0, 1, 2, 0, 2, 3] },
  };
  check("索引几何 → 2 个三角", FXExport.trianglesFromGeometry(geoIdx, 1).length === 2);
}

console.log("\n[2] 二进制 STL 结构");
{
  const tris = [
    [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
    [{ x: 0, y: 0, z: 5 }, { x: 10, y: 0, z: 5 }, { x: 0, y: 10, z: 5 }],
  ];
  const buf = FXExport.stlFromTriangles(tris, "unit-test");
  check("字节数 = 84 + 50×n", buf.byteLength === 84 + 50 * 2, String(buf.byteLength));
  const dv = new DataView(buf);
  check("uint32 三角数正确", dv.getUint32(80, true) === 2);
  // 首三角法线应为 +Z（逆时针在 XY 平面）
  const nz = dv.getFloat32(84 + 8, true);
  check("法线计算正确（nz=1）", Math.abs(nz - 1) < 1e-6, String(nz));
  const v1x = dv.getFloat32(84 + 12, true);
  check("顶点小端写入", Math.abs(v1x - 0) < 1e-9);
  const attr = dv.getUint16(84 + 48, true);
  check("attribute byte count = 0", attr === 0);
}

console.log("\n[3] OBJ 结构");
{
  const tris = [
    [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
  ];
  const obj = FXExport.objFromTriangles(tris, "行星齿轮 v2");
  const vLines = obj.split("\n").filter((l) => l.startsWith("v "));
  const fLines = obj.split("\n").filter((l) => l.startsWith("f "));
  check("v 行数 = 3×n", vLines.length === 3, String(vLines.length));
  check("f 行数 = n", fLines.length === 1, String(fLines.length));
  check("对象名空格转下划线", obj.includes("o 行星齿轮_v2"));
  check("面索引从 1 起", fLines[0] === "f 1 2 3", fLines[0]);
}

console.log("\n[4] G-code 语义（真实切片 → 可切片器核验的输出）");
{
  const gear = FXModels.createBuiltins()[0];
  const slice = FXSlicer.slice(gear, TF, ST);
  const g = FXExport.gcode(slice, ST, { model: gear.name, printer: "FX-256", densityG: 1.24 });
  const lines = g.split("\n");

  check("含温度指令（M104/M109/M140/M190 带设定值）",
    g.includes("M104 S210") && g.includes("M109 S210") && g.includes("M140 S60") && g.includes("M190 S60"));
  check("相对挤出 M83 + 归位 G28", g.includes("M83") && g.includes("G28 ; home"));
  check("自动调平 G29 跟随设置", g.includes("G29"));
  check("LAYER_COUNT 与切片一致", g.includes(`;LAYER_COUNT:${slice.totalLayers}`));
  check("首末层标记存在", g.includes(";LAYER:0") && g.includes(`;LAYER:${slice.totalLayers - 1}`));
  check("风扇首层关闭、第二层开启", g.includes("M107 ; fan off for first layer") && g.includes("M106 S255"));

  // 挤出量守恒：ΣE（正值，不含回抽对）≈ 挤出总长 × 截面比
  let eSum = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let retracts = 0, unretracts = 0;
  for (const ln of lines) {
    const me = ln.match(/^G1 .*E(-?\d+(?:\.\d+)?)/);
    if (me) {
      const v = parseFloat(me[1]);
      if (ln.includes("; retract")) { retracts++; continue; }
      if (ln.includes("; unretract")) { unretracts++; continue; }
      eSum += v;
    }
    const mx = ln.match(/X(\d+(?:\.\d+)?) Y(\d+(?:\.\d+)?)/);
    if (mx) {
      const x = parseFloat(mx[1]), y = parseFloat(mx[2]);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const expectE = slice.stats.extLenMm * (ST.extrusionWidth * ST.layerHeight) / (Math.PI * 0.875 * 0.875);
  check("挤出量守恒（ΣE ≈ 理论耗材长，±1%）", Math.abs(eSum - expectE) / expectE < 0.01,
    `ΣE=${eSum.toFixed(1)} expect=${expectE.toFixed(1)}`);
  check("回抽/回填成对出现", retracts > 0 && retracts === unretracts, `${retracts}/${unretracts}`);
  check("坐标全部落在床内（0..256）", minX >= 0 && maxX <= 256 && minY >= 0 && maxY <= 256,
    `X ${minX.toFixed(1)}..${maxX.toFixed(1)} Y ${minY.toFixed(1)}..${maxY.toFixed(1)}`);
  check("齿轮 Ø55 居中 → X 范围应跨约 128±40", minX < 108 && maxX > 148,
    `X ${minX.toFixed(1)}..${maxX.toFixed(1)}`);
  check("收尾：关加热 + 松电机", g.includes("M104 S0") && g.includes("M140 S0") && g.includes("M84"));
}

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
