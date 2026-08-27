/* React 工作台与旧入口的一致性门禁。

   迁移的验收标准是「两个入口看起来、用起来一样」，这条标准必须由机器判定：
   上一版 React 迁移正是在没有像素卡口的情况下逐步演变成了另一套界面。

   两层断言：
     1. 布局契约——关键节点的几何、计算样式与文案逐项比对，差异可精确定位；
     2. 界面像素——隐去 3D 画布后整屏比对，容差之外即失败。
   3D 视口本身不参与像素比对：两个入口是各自独立的 WebGL 上下文，
   取帧时刻与抗锯齿噪声不具备可复现性，改用布局契约约束其尺寸与层叠。

   Stage 7.3 扩面：除启动态外，五个流程页（模型/切片/校准/质量/洞察）逐页、
   四台机型逐台执行同一套「布局契约 + 整屏像素」比对（§5 硬门禁），
   两入口的截图同步归档到 optimization/stage7-classic-retirement/ 作为视觉校验记录。 */
"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

/** 参与比对的节点。覆盖全部常驻可见区域，动态填充的容器只比对其自身盒模型。 */
const TRACKED_SELECTORS = [
  "#bg-space",
  "#gl",
  "#topbar",
  "#topbar .brand",
  "#brand-mark",
  "#topbar .brand-name",
  "#flow-pills",
  "#flow-pills .flow-pill",
  "#status-pill",
  "#status-pill .sp-text",
  "#speed-seg",
  "#speed-seg button",
  "#btn-params",
  "#btn-about",
  "#btn-fullscreen",
  "#hud",
  "#hud-cam",
  "#hud-cam button",
  "#hud .hud-info",
  "#hud-action",
  "#hud-coords",
  "#dock",
  "#dock .ring-wrap",
  "#dock .ring",
  "#ring-fg",
  "#ring-val",
  "#btn-start",
  "#btn-pause",
  "#btn-stop",
  "#dock .dock-stat",
  "#stat-layer",
  "#stat-remain",
  "#noz-now",
  "#bed-now",
  "#btn-monitor",
];

/** 影响观感的样式子集：颜色、排版、盒模型与层叠。 */
const TRACKED_STYLES = [
  "display",
  "position",
  "zIndex",
  "color",
  "backgroundColor",
  "backgroundImage",
  "borderRadius",
  "borderColor",
  "borderWidth",
  "boxShadow",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "opacity",
  "backdropFilter",
  "textAlign",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "padding",
  "margin",
];

/** 像素比对的单通道容差与允许的最大差异占比。 */
const CHANNEL_TOLERANCE = 8;
const MAX_MISMATCH_RATIO = 0.002;

/** 流程页清单（顶部导航全集）：四个流程面板 + 洞察独立面板。 */
const FLOW_PAGES = [
  { id: "import", pill: "模型", panel: "#ctx-panel" },
  { id: "slice", pill: "切片", panel: "#ctx-panel" },
  { id: "calib", pill: "校准", panel: "#ctx-panel" },
  { id: "quality", pill: "质量", panel: "#ctx-panel" },
  { id: "insight", pill: "洞察", panel: "#insight-panel" },
];

/** 四台机型（注册顺序 = 模型页卡片顺序；corexy 为启动默认）。 */
const MACHINES = [
  { id: "corexy", card: "FX-256 睿造" },
  { id: "i3", card: "FX-220 轻锋" },
  { id: "delta", card: "FX-Δ260 迅影" },
  { id: "gantry", card: "FX-500 巨匠" },
];

/** Stage 7 视觉校验记录的归档目录（optimization/ 不入库，仅本地证据）。 */
const ARCHIVE_DIR = path.join(__dirname, "../../optimization/stage7-classic-retirement/screenshots");

function archiveShot(name, buffer) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARCHIVE_DIR, name + ".png"), buffer);
}

async function waitBooted(page) {
  await page.waitForFunction(() => window.FX && window.FX.sim && window.FX.sim.slice, null, { timeout: 30_000 });
  // 启动动画结束后布局才稳定（body.boot 由引导流程在 1.6s 后移除）
  await page.waitForFunction(() => !document.body.classList.contains("boot"), null, { timeout: 10_000 });
  await page.waitForTimeout(500);
}

/** 在页面上下文里采集一组选择器的布局契约（几何 + 计算样式 + 叶子文案）。 */
function collectContract(page, selectors) {
  return page.evaluate(
    ([selectorList, styleKeys]) => {
      const round = (value) => Math.round(value);
      const entries = [];
      for (const selector of selectorList) {
        const nodes = Array.from(document.querySelectorAll(selector));
        entries.push({ selector, count: nodes.length });
        nodes.forEach((node, index) => {
          const rect = node.getBoundingClientRect();
          const computed = window.getComputedStyle(node);
          const styles = {};
          for (const key of styleKeys) styles[key] = computed[key];
          entries.push({
            selector,
            index,
            tag: node.tagName,
            className: node.getAttribute("class") ?? "",
            hidden: node.hasAttribute("hidden"),
            disabled: node.disabled === true,
            childElements: node.childElementCount,
            /* 只在叶子节点比对文案：容器的 textContent 会拼进 HTML 源码的缩进空白，
               那是书写格式而非渲染差异，容器的实际内容由其子节点各自覆盖。 */
            text: node.childElementCount === 0 ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : null,
            rect: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
            styles,
          });
        });
      }
      return entries;
    },
    [selectors, TRACKED_STYLES]
  );
}

async function captureContract(page, url) {
  await page.goto(url);
  await waitBooted(page);
  return collectContract(page, TRACKED_SELECTORS);
}

/** 隐去不确定层（3D 画布 + 异步 toast），使整屏截图只保留确定性的 CSS 界面层。 */
async function hideNondeterministicLayers(page) {
  await page.evaluate(() => {
    const canvas = document.getElementById("gl");
    if (canvas) canvas.style.visibility = "hidden";
    /* 校准同步等异步提示会在不确定的时刻浮现并遮挡界面，
       它们不属于稳定界面的一部分，比对前统一隐去。 */
    const toasts = document.getElementById("toasts");
    if (toasts) toasts.style.display = "none";
  });
}

/** 隐去 3D 画布后整屏截图，只保留确定性的 CSS 界面层。 */
async function captureInterface(page, url) {
  await page.goto(url);
  await waitBooted(page);
  await hideNondeterministicLayers(page);
  await page.waitForTimeout(200);
  return page.screenshot();
}

function toDataUrl(buffer) {
  return "data:image/png;base64," + buffer.toString("base64");
}

async function mismatchRatio(page, legacyShot, reactShot) {
  return page.evaluate(
    async ([a, b, tolerance]) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("screenshot decode failed"));
          image.src = src;
        });
      const [left, right] = await Promise.all([load(a), load(b)]);
      if (left.width !== right.width || left.height !== right.height) return 1;

      const canvas = document.createElement("canvas");
      canvas.width = left.width;
      canvas.height = left.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(left, 0, 0);
      const leftData = context.getImageData(0, 0, canvas.width, canvas.height).data;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(right, 0, 0);
      const rightData = context.getImageData(0, 0, canvas.width, canvas.height).data;

      let mismatched = 0;
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (let i = 0; i < leftData.length; i += 4) {
        if (
          Math.abs(leftData[i] - rightData[i]) > tolerance ||
          Math.abs(leftData[i + 1] - rightData[i + 1]) > tolerance ||
          Math.abs(leftData[i + 2] - rightData[i + 2]) > tolerance
        ) {
          mismatched++;
          const pixel = i / 4;
          const x = pixel % canvas.width;
          const y = Math.floor(pixel / canvas.width);
          if (x < box.minX) box.minX = x;
          if (y < box.minY) box.minY = y;
          if (x > box.maxX) box.maxX = x;
          if (y > box.maxY) box.maxY = y;
        }
      }
      return { ratio: mismatched / (leftData.length / 4), mismatched, box };
    },
    [toDataUrl(legacyShot), toDataUrl(reactShot), CHANNEL_TOLERANCE]
  );
}

/** 打开一个流程页并等它进入稳定态（入场动画结束 + 页内异步内容就位）。 */
async function openFlowPage(page, def) {
  if (def.id === "insight") {
    await page.locator("#pill-insight").click();
  } else {
    await page.locator("#flow-pills .flow-pill", { hasText: def.pill }).click();
  }
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return el && !el.hidden && !el.classList.contains("entering");
    },
    def.panel,
    { timeout: 10_000 }
  );
  if (def.id === "import") {
    // 校准目录同步是启动期异步任务，等它落定，两个入口才在同一状态下比对
    await page.waitForFunction(
      () => (document.getElementById("ctx-body")?.textContent ?? "").includes("服务端已审核目录"),
      null,
      {
        timeout: 10_000,
      }
    );
  }
  if (def.id === "slice") {
    await page.waitForSelector("#ctx-body .layer-canvas-wrap canvas", { timeout: 10_000 });
  }
  if (def.id === "insight") {
    // 引擎探测是异步的：等标识从「本地规则」翻到「后端规则」，KPI 就位
    await expect(page.locator("#insight-engine-tag")).toHaveText("后端规则", { timeout: 10_000 });
    await page.waitForSelector("#insight-body .kpi-grid", { timeout: 10_000 });
  }
  await page.waitForTimeout(300);
}

/** 页面状态契约：流程胶囊高亮 + 当前面板整棵子树 + 引擎侧关键状态。 */
async function capturePageContract(page, def) {
  const contract = await collectContract(page, ["#flow-pills .flow-pill", def.panel, `${def.panel} *`]);
  const engine = await page.evaluate(() => ({
    selector: "@engine",
    printerId: window.FX.sim.printer.ID,
    machineId: window.FX.sim.machineId,
    modelId: window.FX.sim.model ? window.FX.sim.model.id : null,
    totalLayers: window.FX.sim.slice ? window.FX.sim.slice.totalLayers : 0,
  }));
  contract.push(engine);
  return contract;
}

/** 单入口全流程页 traversal：逐页采集契约与整屏截图。 */
async function captureFlowPages(page, url) {
  await page.goto(url);
  await waitBooted(page);
  await hideNondeterministicLayers(page);
  const states = {};
  for (const def of FLOW_PAGES) {
    await openFlowPage(page, def);
    states[def.id] = {
      contract: await capturePageContract(page, def),
      shot: await page.screenshot(),
    };
  }
  return states;
}

/** 单入口四机型 traversal：模型页里逐台切换机型，采集契约与整屏截图。 */
async function captureMachines(page, url) {
  await page.goto(url);
  await waitBooted(page);
  await hideNondeterministicLayers(page);
  await openFlowPage(page, FLOW_PAGES[0]);
  const states = {};
  for (const machine of MACHINES) {
    // corexy 是启动默认机型；已选中的卡片点击是幂等空操作，统一走一次点击路径
    await page.locator("#ctx-body .model-card", { hasText: machine.card }).click();
    await page.waitForFunction((id) => window.FX.sim.printer.ID === id && !!window.FX.sim.slice, machine.id, {
      timeout: 15_000,
    });
    // 选中态高亮必须落在目标卡片上
    await expect(page.locator("#ctx-body .model-card.on", { hasText: machine.card })).toBeVisible();
    await page.waitForTimeout(300);
    states[machine.id] = {
      contract: await capturePageContract(page, FLOW_PAGES[0]),
      shot: await page.screenshot(),
    };
  }
  return states;
}

/** 逐条找出两份契约的全部差异；失败信息直接指向出问题的条目。 */
function contractDiffs(legacyEntries, reactEntries) {
  const diffs = [];
  const length = Math.max(legacyEntries.length, reactEntries.length);
  for (let i = 0; i < length; i++) {
    const legacyJson = JSON.stringify(legacyEntries[i] ?? null);
    const reactJson = JSON.stringify(reactEntries[i] ?? null);
    if (legacyJson !== reactJson) diffs.push({ index: i, legacy: legacyEntries[i], react: reactEntries[i] });
  }
  return diffs;
}

function describeDiffs(state, diffs) {
  const head = diffs
    .slice(0, 3)
    .map(
      (diff) =>
        `#${diff.index} legacy=${JSON.stringify(diff.legacy)?.slice(0, 300)} react=${JSON.stringify(diff.react)?.slice(0, 300)}`
    )
    .join("\n");
  return `「${state}」布局契约差异 ${diffs.length} 条：\n${head}`;
}

/** 逐状态执行「布局契约 + 整屏像素」双层断言，并把两入口截图归档为视觉校验记录。 */
async function assertStates(page, prefix, legacyStates, reactStates) {
  for (const state of Object.keys(legacyStates)) {
    const legacy = legacyStates[state];
    const react = reactStates[state];
    archiveShot(`${prefix}-${state}-legacy`, legacy.shot);
    archiveShot(`${prefix}-${state}-react`, react.shot);

    const diffs = contractDiffs(legacy.contract, react.contract);
    expect.soft(diffs.length, describeDiffs(state, diffs)).toBe(0);

    const diff = await mismatchRatio(page, legacy.shot, react.shot);
    console.log(`[parity] ${prefix}-${state} ratio=${diff.ratio.toFixed(6)} mismatched=${diff.mismatched}`);
    expect
      .soft(diff.ratio, `「${state}」差异像素 ${diff.mismatched} 处，范围 ${JSON.stringify(diff.box)}`)
      .toBeLessThanOrEqual(MAX_MISMATCH_RATIO);
  }
}

test.describe("React 工作台与旧入口一致性", () => {
  test("布局契约逐项一致", async ({ page }) => {
    const legacy = await captureContract(page, "/legacy");
    const react = await captureContract(page, "/react");

    expect(react.length).toBe(legacy.length);
    // 逐条比对而非整体 toEqual：失败信息直接指向出问题的选择器
    for (let i = 0; i < legacy.length; i++) {
      expect(react[i], `布局契约不一致：${legacy[i].selector}`).toEqual(legacy[i]);
    }
  });

  test("界面像素差异在容差内", async ({ page }) => {
    const legacyShot = await captureInterface(page, "/legacy");
    const reactShot = await captureInterface(page, "/react");
    archiveShot("boot-legacy", legacyShot);
    archiveShot("boot-react", reactShot);
    const diff = await mismatchRatio(page, legacyShot, reactShot);
    console.log(`[parity] boot ratio=${diff.ratio.toFixed(6)} mismatched=${diff.mismatched}`);
    expect(diff.ratio, `差异像素 ${diff.mismatched} 处，范围 ${JSON.stringify(diff.box)}`).toBeLessThanOrEqual(
      MAX_MISMATCH_RATIO
    );
  });

  test("全部流程页布局契约与整屏像素一致", async ({ page }) => {
    // 两个入口各走一遍五页 traversal，洞察页还要等引擎探测；
    // 本机与 CI 都可能被并行任务抢占 CPU，给固定大预算而不是 ×3。
    test.setTimeout(600_000);
    const legacyStates = await captureFlowPages(page, "/legacy");
    const reactStates = await captureFlowPages(page, "/react");
    await assertStates(page, "page", legacyStates, reactStates);
  });

  test("四机型切换布局契约与整屏像素一致", async ({ page }) => {
    test.setTimeout(600_000); // 每台机型都触发重建 3D 打印机与整床重切片
    const legacyStates = await captureMachines(page, "/legacy");
    const reactStates = await captureMachines(page, "/react");
    await assertStates(page, "machine", legacyStates, reactStates);
  });
});
