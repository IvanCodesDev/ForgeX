/* FORGE·X 切片引擎冒烟测试（node tests/smoke.js）
   覆盖：几何工具 / 多边形偏置 / 扫描线填充 / Marching Squares / 内置模型切片 / 图片高度场切片 */
"use strict";
const path = require("path");
const J = (p) => path.join(__dirname, "..", "js", p);

require(J("util.js"));
require(J("slicer.js"));
require(J("models.js"));

const FXU = globalThis.FXU, FXSlicer = globalThis.FXSlicer, FXModels = globalThis.FXModels;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const ST = {
  layerHeight: 0.2, extrusionWidth: 0.45, perimeters: 2, solidLayers: 3,
  infillDensity: 0.18, infillPattern: "斜线网格",
  nozzleTemp: 210, bedTemp: 60, speed: 120, travelSpeed: 260,
  retraction: 1.2, fanSpeed: 100, supportEnabled: true, supportSpacing: 4.5,
  skirtLoops: 2, skirtGap: 5, zOffset: 0,
};
const TF = { scale: 1, rotZ: 0, offX: 0, offY: 0 };

console.log("\n[1] 几何工具");
{
  const sq = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
  check("正方形面积 = 400", Math.abs(FXU.polyArea(sq) - 400) < 1e-6, String(FXU.polyArea(sq)));
  const off = FXSlicer.offsetLoop(sq, 1);
  check("内偏置后面积收缩至 ~324", Math.abs(FXU.polyArea(off) - 324) < 2, String(FXU.polyArea(off)));
  const collapsed = FXSlicer.offsetLoop(sq, 9.99);
  check("过度收缩返回 null", collapsed === null);
  check("路径长度计算", Math.abs(FXU.pathLen([{ x: 0, y: 0 }, { x: 3, y: 4 }]) - 5) < 1e-9);
}

console.log("\n[2] 扫描线填充（奇偶规则）");
{
  const sq = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
  const hole = [{ x: -3, y: -3 }, { x: -3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: -3 }]; // CW
  const lines = FXSlicer.hatchLoops([{ pts: sq }, { pts: hole, hole: true }], 0, 2);
  check("生成填充折线", lines.length > 0, String(lines.length));
  let inHole = false, totalPts = 0;
  for (const pl of lines) for (const p of pl) {
    totalPts++;
    if (Math.abs(p.x) < 2.4 && Math.abs(p.y) < 2.4) inHole = true;
  }
  check("填充点不落入孔洞", !inHole);
  check("45° 斜向填充可用", FXSlicer.hatchLoops([{ pts: sq }], 45, 2).length > 0);
  check("蛇形串联（折线数 < 线段数）", lines.length < 12, String(lines.length));
  const loops = [{ pts: sq }];
  const straight = FXSlicer.patternFill(loops, "直线", 2, 0);
  const diagonal = FXSlicer.patternFill(loops, "斜线网格", 2, 0);
  const honeycomb = FXSlicer.patternFill(loops, "蜂窝", 2, 0);
  const angles = (paths) => {
    const found = new Set();
    for (const path of paths) for (let i = 1; i < path.length; i++) {
      const dx = path[i].x - path[i - 1].x, dy = path[i].y - path[i - 1].y;
      if (Math.hypot(dx, dy) < 0.5) continue;
      let a = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
      a = ((a % 180) + 180) % 180;
      found.add(Math.round(a / 5) * 5);
    }
    return found;
  };
  const aStraight = angles(straight), aDiagonal = angles(diagonal), aHoney = angles(honeycomb);
  check("直线填充生成 0° 主路径", aStraight.has(0), [...aStraight].join(","));
  check("斜线网格生成 45° 主路径", aDiagonal.has(45), [...aDiagonal].join(","));
  check("蜂窝生成 60°/120° 六边形边", aHoney.has(60) || aHoney.has(120), [...aHoney].join(","));
  const signature = (paths) => paths.slice(0, 8).map((p) =>
    p.slice(0, 4).map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(";")).join("|");
  check("三种填充的实际路径互不相同",
    new Set([signature(straight), signature(diagonal), signature(honeycomb)]).size === 3);
  void totalPts;
}

console.log("\n[3] Marching Squares 高度场等值线");
{
  // 半径 8 的圆锥高度场
  const nx = 41, ny = 41, H = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = (i - 20) * 0.5, y = (j - 20) * 0.5;
    H[j * nx + i] = Math.max(0, 8 - Math.hypot(x, y));
  }
  const grid = { nx, ny, w: 20, d: 20, H };
  const cts = FXSlicer.gridContours(grid, 4);      // 半高 → 半径约 4mm 圆
  check("提取到等值线", cts.length >= 1, String(cts.length));
  const c0 = cts[0];
  let rAvg = 0;
  for (const p of c0) rAvg += Math.hypot(p.x, p.y);
  rAvg /= c0.length;
  check("等值线半径 ≈ 4mm", Math.abs(rAvg - 4) < 0.5, rAvg.toFixed(2));
  const fills = FXSlicer.gridHatch(grid, 4, 1.5);
  check("高度场逐行填充", fills.length > 0, String(fills.length));
}

console.log("\n[4] 内置模型 · 行星齿轮切片");
{
  const gear = FXModels.createBuiltins()[0];
  const r = FXSlicer.slice(gear, TF, ST);
  check("总层数 = 80（16mm / 0.2mm）", r.totalLayers === 80, String(r.totalLayers));
  const L0 = r.layers[0];
  const types = new Set(L0.paths.map((p) => p.type));
  check("首层含裙边", types.has("skirt"), [...types].join(","));
  check("首层含周界", types.has("perimeter"));
  check("首层为实心填充", types.has("solid") && !types.has("infill"));
  const Lmid = r.layers[40];
  check("中段为稀疏填充", Lmid.paths.some((p) => p.type === "infill"));
  check("挤出总长 > 10m", r.stats.extLenMm > 10000, (r.stats.extLenMm / 1000).toFixed(1) + "m");
  check("时长估计为正", r.stats.timeSec > 60, r.stats.timeSec.toFixed(0) + "s");
  const boreOk = !L0.paths.some((p) => p.type !== "skirt" && p.pts.some((q) => Math.hypot(q.x, q.y) < 4.0));
  check("中心孔无路径穿越", boreOk);
}

console.log("\n[5] 内置模型 · 支架支撑生成");
{
  const bracket = FXModels.createBuiltins()[2];
  const r = FXSlicer.slice(bracket, TF, ST);
  const withSup = r.layers.filter((L) => L.paths.some((p) => p.type === "support"));
  check("悬垂区间存在支撑层", withSup.length > 50, String(withSup.length));
  const zs = withSup.map((L) => L.z);
  check("支撑位于 4–26mm 区间", Math.min(...zs) > 3.9 && Math.max(...zs) < 26.5,
    `${Math.min(...zs).toFixed(1)}–${Math.max(...zs).toFixed(1)}`);
  const off = FXSlicer.slice(bracket, TF, Object.assign({}, ST, { supportEnabled: false }));
  check("关闭支撑后无支撑路径", !off.layers.some((L) => L.paths.some((p) => p.type === "support")));
}

console.log("\n[6] 内置模型 · 叶轮动态轮廓");
{
  const imp = FXModels.createBuiltins()[1];
  const sec = imp.outlinesAt(10);
  check("z=10 截面 = 轮毂+孔+7叶片 = 9 环", sec.loops.length === 9, String(sec.loops.length));
  const a10 = imp.outlinesAt(10).loops[2].pts[0];
  const a20 = imp.outlinesAt(20).loops[2].pts[0];
  const ang = (p) => Math.atan2(p.y, p.x);
  check("叶片随高度扭转", Math.abs(ang(a10) - ang(a20)) > 0.15,
    (ang(a10) - ang(a20)).toFixed(3));
  const r = FXSlicer.slice(imp, TF, ST);
  check("叶轮切片成功（150 层）", r.totalLayers === 150, String(r.totalLayers));
}

console.log("\n[7] 图片高度场模型（模拟渐变图）");
{
  // 生成 64×64 对角渐变亮度图（模拟用户上传）
  const nx = 64, ny = 64;
  const lum = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    lum[j * nx + i] = (i + j) / (nx + ny - 2);
  const relief = FXModels.buildImageModel(lum, nx, ny, { mode: "relief", widthMm: 80, maxH: 8, invert: false });
  check("浮雕模型高度 ≤ 8mm", relief.height <= 8.01 && relief.height > 5, relief.height.toFixed(2));
  const r1 = FXSlicer.slice(relief, TF, ST);
  check("浮雕切片层数合理", r1.totalLayers >= 30, String(r1.totalLayers));
  const midL = r1.layers[Math.floor(r1.totalLayers / 2)];
  check("浮雕中层含周界+填充", midL.paths.some((p) => p.type === "perimeter") && midL.paths.some((p) => p.type === "infill" || p.type === "solid"),
    midL.paths.map((p) => p.type).join(","));
  const r4 = FXSlicer.slice(relief, TF, Object.assign({}, ST, { perimeters: 4 }));
  const perimeterCount = (slice) =>
    slice.layers[Math.floor(slice.totalLayers / 2)].paths.filter((p) => p.type === "perimeter").length;
  check("图片高度场响应周界圈数", perimeterCount(r4) > perimeterCount(r1),
    `${perimeterCount(r1)} → ${perimeterCount(r4)}`);

  const sil = FXModels.buildImageModel(lum, nx, ny, { mode: "silhouette", widthMm: 80, maxH: 6, invert: false, threshold: 0.5 });
  const r2 = FXSlicer.slice(sil, TF, ST);
  check("剪影切片成功", r2.totalLayers === 30, String(r2.totalLayers));
  const sMid = r2.layers[15];
  let area = 0;
  for (const p of sMid.paths) if (p.type === "perimeter") area++;
  check("剪影中层有轮廓周界", area >= 1, String(area));
}

console.log("\n[8] 变换与缩放");
{
  const gear = FXModels.createBuiltins()[0];
  const r = FXSlicer.slice(gear, { scale: 1.5, rotZ: 45, offX: 20, offY: -10 }, ST);
  check("1.5× 缩放层数 = 120", r.totalLayers === 120, String(r.totalLayers));
  let cx = 0, cy = 0, n = 0;
  for (const p of r.layers[10].paths) if (p.type === "perimeter") for (const q of p.pts) { cx += q.x; cy += q.y; n++; }
  cx /= n; cy /= n;
  check("平移后质心偏移 ≈ (20,-10)", Math.abs(cx - 20) < 3 && Math.abs(cy + 10) < 3, `(${cx.toFixed(1)}, ${cy.toFixed(1)})`);
}

console.log("\n[9] 工艺参数因果差异");
{
  const gear = FXModels.createBuiltins()[0];
  const base = FXSlicer.slice(gear, TF, ST);
  const coarse = FXSlicer.slice(gear, TF, Object.assign({}, ST, { layerHeight: 0.28 }));
  check("层高改变实际层数", coarse.totalLayers !== base.totalLayers,
    `${base.totalLayers} → ${coarse.totalLayers}`);

  const thickWalls = FXSlicer.slice(gear, TF, Object.assign({}, ST, { perimeters: 4 }));
  const mid = Math.floor(base.totalLayers / 2);
  const perimeterPaths = (slice) => slice.layers[mid].paths.filter((p) => p.type === "perimeter").length;
  check("周界圈数改变实际轮廓路径", perimeterPaths(thickWalls) > perimeterPaths(base),
    `${perimeterPaths(base)} → ${perimeterPaths(thickWalls)}`);

  const moreSkin = FXSlicer.slice(gear, TF, Object.assign({}, ST, { solidLayers: 6 }));
  const solidLayerCount = (slice) => slice.layers.filter((L) => L.paths.some((p) => p.type === "solid")).length;
  check("实心层数改变顶底实体层", solidLayerCount(moreSkin) > solidLayerCount(base),
    `${solidLayerCount(base)} → ${solidLayerCount(moreSkin)}`);

  const dense = FXSlicer.slice(gear, TF, Object.assign({}, ST, { infillDensity: 0.45 }));
  check("填充密度增加真实挤出路径", dense.stats.extLenMm > base.stats.extLenMm,
    `${base.stats.extLenMm.toFixed(0)} → ${dense.stats.extLenMm.toFixed(0)} mm`);

  const fastPrint = FXSlicer.slice(gear, TF, Object.assign({}, ST, { speed: 240 }));
  check("打印速度改变路径估时", fastPrint.stats.timeSec < base.stats.timeSec,
    `${base.stats.timeSec.toFixed(0)} → ${fastPrint.stats.timeSec.toFixed(0)} s`);

  const fastTravel = FXSlicer.slice(gear, TF, Object.assign({}, ST, { travelSpeed: 520 }));
  check("空驶速度改变路径估时", fastTravel.stats.timeSec < base.stats.timeSec,
    `${base.stats.timeSec.toFixed(0)} → ${fastTravel.stats.timeSec.toFixed(0)} s`);

  const longRetract = FXSlicer.slice(gear, TF, Object.assign({}, ST, { retraction: 3 }));
  check("回抽距离增加运动耗时", longRetract.stats.timeSec > base.stats.timeSec,
    `${base.stats.timeSec.toFixed(0)} → ${longRetract.stats.timeSec.toFixed(0)} s`);

  const bracket = FXModels.createBuiltins()[2];
  const tightSupport = FXSlicer.slice(bracket, TF, Object.assign({}, ST, { supportSpacing: 2 }));
  const sparseSupport = FXSlicer.slice(bracket, TF, Object.assign({}, ST, { supportSpacing: 8 }));
  const supportLength = (slice) => slice.layers.reduce((sum, L) =>
    sum + L.paths.filter((p) => p.type === "support").reduce((a, p) => a + p.len, 0), 0);
  check("支撑间距改变支撑材料量", supportLength(tightSupport) > supportLength(sparseSupport),
    `${supportLength(tightSupport).toFixed(0)} vs ${supportLength(sparseSupport).toFixed(0)} mm`);
}

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
