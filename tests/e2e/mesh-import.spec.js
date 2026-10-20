/* Stage 9.3 前半「STL / 3MF 浏览器预览导入」回归卡口（V2 §4.3 工作项 3 的 TS Worker 半边）。

   固化的结论：
   - 网格文件的读取 / SHA-256 / 解析 / 归一化在 Web Worker 内完成（探针 __forgexMeshImportVia === "worker"），
     3MF 的 deflate 条目在 Worker 内经 DecompressionStream 解压；
   - 导入产物是可切片模型：进入既有的切片链（层数 = 高度 / 层高）、摘要面板标注为浏览器预览口径；
   - 导出链零改动复用：导入 STL → 导出 STL 往返后三角面数与包围盒一致（世界系 Y-up ↔ Z-up 映射互逆）；
   - 选择内置模型后网格摘要随导入链一起清空；坏文件只给错误 toast，不替换当前模型。

   夹具全部在测试内程序化生成并落到系统临时目录（与 gcode-worker.spec.js 同一做法，仓库不放二进制文件）。 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { test, expect } = require("@playwright/test");

/* ── 夹具生成 ─────────────────────────────── */

/** 四边形 → 两个三角形；顶点按从外侧看逆时针给出 */
function quad(out, p0, p1, p2, p3) {
  out.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
}
/** 轴对齐盒的 12 个三角形（法向朝外），Z-up、单位 mm */
function boxTriangles(x0, y0, z0, x1, y1, z1) {
  const out = [];
  quad(out, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); // −Z
  quad(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
  quad(out, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // −Y
  quad(out, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]); // +Y
  quad(out, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]); // −X
  quad(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +X
  return out;
}

function binaryStl(coords, header = "FORGE-X e2e fixture") {
  const n = coords.length / 9;
  const buf = Buffer.alloc(84 + 50 * n);
  buf.write(header, 0, "ascii");
  buf.writeUInt32LE(n, 80);
  let off = 84;
  for (let t = 0; t < n; t++) {
    off += 12; // 法向量留零，由解析侧重算
    for (let k = 0; k < 9; k++) {
      buf.writeFloatLE(coords[t * 9 + k], off);
      off += 4;
    }
    off += 2;
  }
  return buf;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 最小 ZIP 写入器：entries = [{ name, data: Buffer, deflate?: boolean }] */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const payload = entry.deflate ? zlib.deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const cdSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** 3MF：对象 1 = 20×10×10 盒；对象 2 = 两个对象 1 的组件（一个平移 x+30）；build 项再整体抬高 z+5 */
function threeMf(production = false) {
  const mesh = `<mesh><vertices>
    <vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="20" y="10" z="0"/><vertex x="0" y="10" z="0"/>
    <vertex x="0" y="0" z="10"/><vertex x="20" y="0" z="10"/><vertex x="20" y="10" z="10"/><vertex x="0" y="10" z="10"/>
  </vertices><triangles>
    <triangle v1="0" v2="3" v3="2"/><triangle v1="0" v2="2" v3="1"/>
    <triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
    <triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/>
    <triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/>
    <triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/>
    <triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
  </triangles></mesh>`;
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">${mesh}</object>
    <object id="2" type="model"><components>
      <component objectid="1" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>
      <component objectid="1"/>
    </components></object>
  </resources>
  <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 5"/></build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  if (production) {
    const namespace = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
    const root = `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:parts="${namespace}" requiredextensions="parts"><resources><object id="2"><components><component parts:path="/3D/Objects/part.model" objectid="1" transform="0.1 0 0 0 0.1 0 0 0 0.1 30 0 0"/><component parts:path="/3D/Objects/part.model" objectid="1" transform="0.1 0 0 0 0.1 0 0 0 0.1 0 0 0"/></components></object></resources><build><item objectid="2"/></build></model>`;
    const child = `<model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1">${mesh}</object></resources><build><item objectid="999" transform="not executed"/></build></model>`;
    return zip([
      { name: "[Content_Types].xml", data: Buffer.from(contentTypes), deflate: true },
      { name: "_rels/.rels", data: Buffer.from(rels.replace("/3D/3dmodel.model", "/3D/build.model")), deflate: true },
      { name: "3D/3dmodel.model", data: Buffer.from("<invalid-decoy/>"), deflate: true },
      { name: "3D/build.model", data: Buffer.from(root), deflate: true },
      {
        name: "3D/_rels/build.model.rels",
        data: Buffer.from(rels.replace("/3D/3dmodel.model", "Objects/part.model")),
        deflate: true,
      },
      { name: "3D/Objects/part.model", data: Buffer.from(child), deflate: true },
    ]);
  }
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8"), deflate: true },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8"), deflate: true },
    { name: "3D/3dmodel.model", data: Buffer.from(model, "utf8"), deflate: true },
  ]);
}

/** 读回导出的二进制 STL：三角数 + 包围盒 */
function readBinaryStl(buf) {
  const n = buf.readUInt32LE(80);
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let off = 84;
  for (let t = 0; t < n; t++) {
    off += 12;
    for (let v = 0; v < 3; v++) {
      for (let k = 0; k < 3; k++) {
        const value = buf.readFloatLE(off);
        off += 4;
        bbox.min[k] = Math.min(bbox.min[k], value);
        bbox.max[k] = Math.max(bbox.max[k], value);
      }
    }
    off += 2;
  }
  return { triangles: n, bbox, bytes: buf.length };
}

/* ── 页面辅助 ─────────────────────────────── */

async function openImportPage(page) {
  await page.goto("/react");
  await page.waitForFunction(() => window.FX && window.FX.sim && window.FX.sim.slice, null, { timeout: 30_000 });
  await page.locator("#flow-pills .flow-pill").first().click();
  await page.evaluate(() => {
    const audit = { toasts: [], errors: [] };
    window.__meshGate = audit;
    window.FX.bus.on("toast", (payload) => {
      if (!payload) return;
      audit.toasts.push({ type: payload.type, msg: String(payload.msg) });
      if (payload.type === "err") audit.errors.push(String(payload.msg));
    });
  });
}

/** 选文件后等到导入链发出结果 toast（成功 toast 在 sim.setModel 之后发出，失败 toast 即错误文案） */
async function importMesh(page, filePath) {
  const before = await page.evaluate(() => window.__meshGate.toasts.length);
  await page.locator("#mesh-input").setInputFiles(filePath);
  await page.waitForFunction((count) => window.__meshGate.toasts.length > count, before, {
    timeout: 30_000,
    polling: 100,
  });
}

test.describe("STL / 3MF 导入（Worker 浏览器预览解析）", () => {
  let fixtureDir;
  test.beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-mesh-gate-"));
    // 20×20×10 盒，故意偏离原点：验证 XY 居中 / Z 归零
    fs.writeFileSync(path.join(fixtureDir, "box.stl"), binaryStl(boxTriangles(5, 7, 3, 25, 27, 13)));
    fs.writeFileSync(path.join(fixtureDir, "pair.3mf"), threeMf());
    fs.writeFileSync(path.join(fixtureDir, "production.3mf"), threeMf(true));
    fs.writeFileSync(
      path.join(fixtureDir, "pinched.stl"),
      binaryStl([...boxTriangles(0, 0, 0, 10, 10, 10), ...boxTriangles(-10, -10, -10, 0, 0, 0)])
    );
    fs.writeFileSync(
      path.join(fixtureDir, "shells.stl"),
      binaryStl([...boxTriangles(0, 0, 0, 10, 10, 10), ...boxTriangles(20, 0, 0, 30, 10, 10)])
    );
    // 扩展名对但内容坏：声明 4 亿个三角形的 100 字节文件
    const broken = Buffer.alloc(100);
    broken.writeUInt32LE(400_000_000, 80);
    fs.writeFileSync(path.join(fixtureDir, "broken.stl"), broken);
  });
  test.afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("二进制 STL：Worker 解析 → 预览摘要 → 切片 → 导出 STL 往返", async ({ page }) => {
    await openImportPage(page);
    await importMesh(page, path.join(fixtureDir, "box.stl"));

    await page.waitForFunction(() => window.FX.sim.model && window.FX.sim.model.id === "mesh-import", null, {
      timeout: 30_000,
    });
    const summary = page.locator("#mesh-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("box.stl");
    await expect(summary).toContainText("STL（二进制）");
    await expect(summary).toContainText("12 面 · 20.0 × 20.0 × 10.0 mm");
    await expect(summary).toContainText("4.00 cm³ · 16.0 cm²");
    await expect(summary).toContainText("无需支撑");
    if (process.env.E2E_MESH_AUTHORITY === "dotnet") {
      await expect(page.locator('[data-mesh-authority="done"]')).toBeVisible();
      await expect(page.locator("#mesh-authority-summary")).toContainText("4.00 cm³");
      await expect(page.locator("#mesh-authority-summary")).toContainText("边界 0");
      const artifactDir = path.resolve(__dirname, "../../backend/artifacts");
      fs.mkdirSync(artifactDir, { recursive: true });
      await page
        .locator('[data-react-only="stage-9.3 mesh-import"]')
        .screenshot({ path: path.join(artifactDir, "mesh-authority-panel.png") });
    } else {
      await expect(page.locator('[data-mesh-authority="pending"]')).toBeVisible();
    }

    const state = await page.evaluate(() => ({
      via: window.__forgexMeshImportVia,
      model: {
        id: window.FX.sim.model.id,
        name: window.FX.sim.model.name,
        kind: window.FX.sim.model.kind,
        height: window.FX.sim.model.height,
        footprintR: window.FX.sim.model.footprintR,
        needSupport: window.FX.sim.model.needSupport,
        dims: window.FX.sim.model.dims,
      },
      layerHeight: window.FX.sim.settings.layerHeight,
      totalLayers: window.FX.sim.slice.totalLayers,
      sliceHeight: window.FX.sim.slice.height,
      importedToolpath: !!window.FX.sim.importedToolpath,
      errors: window.__meshGate.errors,
      okToast: window.__meshGate.toasts.filter((t) => t.type === "ok").map((t) => t.msg),
    }));
    console.log("[mesh-gate stl]", JSON.stringify(state));
    expect(state.errors).toEqual([]);
    // 解析确实发生在 Worker（回退主线程时此探针为 "main"，应视为回归）
    expect(state.via).toBe("worker");
    expect(state.model).toEqual({
      id: "mesh-import",
      name: "box",
      kind: "mesh",
      height: 10,
      footprintR: 10,
      needSupport: false,
      dims: "20.0 × 20.0 × 10.0 mm",
    });
    expect(state.importedToolpath).toBe(false);
    expect(state.sliceHeight).toBe(10);
    expect(state.totalLayers).toBe(Math.round(10 / state.layerHeight));
    expect(
      state.okToast.some((msg) =>
        /已导入 STL-BINARY · 12 面 · 20\.0 × 20\.0 × 10\.0 mm · SHA-256 [0-9a-f]{12}…/.test(msg)
      )
    ).toBe(true);

    // 导出链零改动复用：导入网格 → 导出二进制 STL，三角数与包围盒往返一致（居中 XY、Z 从 0 起）
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator(".chip", { hasText: "STL 网格" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("box.stl");
    const exported = readBinaryStl(fs.readFileSync(await download.path()));
    expect(exported.bytes).toBe(84 + 50 * 12);
    expect(exported.triangles).toBe(12);
    expect(exported.bbox).toEqual({ min: [-10, -10, 0], max: [10, 10, 10] });
  });

  test("3MF（deflate 条目 + 组件复用 + 变换）在 Worker 内解压；切回内置模型后摘要清空", async ({ page }) => {
    await openImportPage(page);
    await importMesh(page, path.join(fixtureDir, "pair.3mf"));

    await page.waitForFunction(() => window.FX.sim.model && window.FX.sim.model.name === "pair", null, {
      timeout: 30_000,
    });
    const summary = page.locator("#mesh-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("3MF · 单位 millimeter · 2 个对象");
    await expect(summary).toContainText("24 面 · 50.0 × 10.0 × 10.0 mm");
    await expect(summary).toContainText("4.00 cm³");

    const state = await page.evaluate(() => ({
      via: window.__forgexMeshImportVia,
      height: window.FX.sim.model.height,
      footprintR: window.FX.sim.model.footprintR,
      totalLayers: window.FX.sim.slice.totalLayers,
      layerHeight: window.FX.sim.settings.layerHeight,
      errors: window.__meshGate.errors,
    }));
    console.log("[mesh-gate 3mf]", JSON.stringify(state));
    expect(state.errors).toEqual([]);
    expect(state.via).toBe("worker");
    expect(state.height).toBe(10);
    expect(state.footprintR).toBe(25);
    expect(state.totalLayers).toBe(Math.round(10 / state.layerHeight));

    // 两个盒子中间是空的：中层截面应有两个环 → 两条独立外周界起点
    const midLayerLoops = await page.evaluate(() => {
      const sim = window.FX.sim;
      const layer = sim.slice.layers[Math.floor(sim.slice.totalLayers / 2)];
      return layer.paths.filter((p) => p.type === "perimeter").length;
    });
    expect(midLayerLoops).toBe(4); // 2 个外环 × 2 圈周界
    if (process.env.E2E_MESH_AUTHORITY === "dotnet") {
      await expect(page.locator('[data-mesh-authority="done"]')).toBeVisible();
      await expect(page.locator("#mesh-authority-summary")).toContainText("24 面");
    }

    // 选择内置模型 → 导入链整体清空（网格摘要消失、模型换回内置）
    await page.locator(".model-card", { hasText: "行星齿轮" }).click();
    await page.waitForFunction(() => window.FX.sim.model && window.FX.sim.model.id === "gear", null, {
      timeout: 30_000,
    });
    await expect(summary).toHaveCount(0);
  });

  test("Production 3MF：OPC 根模型、跨文件组件及单位变换在预览与 C# 中一致", async ({ page }) => {
    await openImportPage(page);
    await importMesh(page, path.join(fixtureDir, "production.3mf"));
    const summary = page.locator("#mesh-summary");
    await expect(summary).toContainText("production.3mf");
    await expect(summary).toContainText("24 面 · 50.0 × 10.0 × 10.0 mm");
    await expect(summary).toContainText("4.00 cm³");
    expect(await page.evaluate(() => window.__meshGate.errors)).toEqual([]);
    const state = await page.evaluate(() => ({
      via: window.__forgexMeshImportVia,
      height: window.FX.sim.model.height,
      layers: window.FX.sim.slice.totalLayers,
      layerHeight: window.FX.sim.settings.layerHeight,
    }));
    expect(state.via).toBe("worker");
    expect(state.height).toBe(10);
    expect(state.layers).toBe(Math.round(10 / state.layerHeight));
    if (process.env.E2E_MESH_AUTHORITY === "dotnet") {
      await expect(page.locator('[data-mesh-authority="done"]')).toBeVisible();
      await expect(page.locator("#mesh-authority-summary")).toContainText("24 面");
      await expect(page.locator('[data-mesh-diff="true"]')).toHaveCount(0);
    }
  });

  test("点接触与分离壳体：闭合边不再误报可用体积，界面显示顶点及连通分量", async ({ page }) => {
    test.skip(process.env.E2E_MESH_AUTHORITY !== "dotnet", "专项使用真实 C# 拓扑检查");
    await openImportPage(page);
    for (const [file, vertices] of [
      ["pinched.stl", 1],
      ["shells.stl", 0],
    ]) {
      await importMesh(page, path.join(fixtureDir, file));
      await expect(page.locator("#mesh-summary")).toContainText(file);
      await expect(page.locator('[data-mesh-authority="done"]')).toBeVisible();
      const authority = page.locator("#mesh-authority-summary");
      await expect(authority).toContainText("体积不可用");
      await expect(authority).toContainText("边界 0 · 非流形边 0 · 朝向冲突 0");
      await expect(authority.locator('[data-mesh-topology="vertices"] .v')).toHaveText(String(vertices));
      await expect(authority.locator('[data-mesh-topology="components"] .v')).toHaveText("2");
      await expect(authority.locator('[data-mesh-volume="unavailable"]')).toContainText("预览体积仅供展示");
      await expect(authority).toContainText("未判定壳体包含关系");
      if (vertices) {
        const artifactDir = path.resolve(__dirname, "../../backend/artifacts");
        fs.mkdirSync(artifactDir, { recursive: true });
        await page
          .locator('[data-react-only="stage-9.3 mesh-import"]')
          .screenshot({ path: path.join(artifactDir, "mesh-topology-panel.png") });
      }
    }
    expect(await page.evaluate(() => window.__meshGate.errors)).toEqual([]);
  });

  test("坏文件：只给错误 toast，当前模型与切片保持不变", async ({ page }) => {
    await openImportPage(page);
    const before = await page.evaluate(() => ({
      id: window.FX.sim.model.id,
      totalLayers: window.FX.sim.slice.totalLayers,
    }));
    await importMesh(page, path.join(fixtureDir, "broken.stl"));
    const after = await page.evaluate(() => ({
      id: window.FX.sim.model.id,
      totalLayers: window.FX.sim.slice.totalLayers,
      errors: window.__meshGate.errors,
    }));
    console.log("[mesh-gate broken]", JSON.stringify(after));
    expect(after.id).toBe(before.id);
    expect(after.totalLayers).toBe(before.totalLayers);
    expect(after.errors).toHaveLength(1);
    expect(after.errors[0]).toMatch(/^网格导入失败：二进制 STL 声明 400000000 个三角形，但文件长度不足$/);
    await expect(page.locator("#mesh-summary")).toHaveCount(0);
  });

  test("后端校验失败保留预览，后到的旧结果不覆盖新模型", async ({ page }) => {
    test.skip(process.env.E2E_MESH_AUTHORITY !== "dotnet", "专项使用真实 C# 网格校验模式");
    await openImportPage(page);
    await page.route("**/api/v1/meshes/analyze?*", async (route) => {
      await route.fulfill({
        status: 422,
        contentType: "application/problem+json",
        body: JSON.stringify({ title: "必需扩展暂不支持" }),
      });
    });
    await importMesh(page, path.join(fixtureDir, "box.stl"));
    await expect(page.locator('[data-mesh-authority="error"]')).toContainText("必需扩展暂不支持");
    await expect(page.locator("#mesh-summary")).toContainText("box.stl");
    expect(await page.evaluate(() => window.FX.sim.model.id)).toBe("mesh-import");
    await page.unroute("**/api/v1/meshes/analyze?*");
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const requestStarted = new Promise((resolve) => {
      started = resolve;
    });
    await page.route("**/api/v1/meshes/analyze?*", async (route) => {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await importMesh(page, path.join(fixtureDir, "box.stl"));
    await requestStarted;
    await page.locator(".model-card", { hasText: "行星齿轮" }).click();
    release();
    await expect(page.locator("#mesh-summary")).toHaveCount(0);
    await expect(page.locator("#mesh-authority-summary")).toHaveCount(0);
    expect(await page.evaluate(() => window.FX.sim.model.id)).toBe("gear");
  });
});
