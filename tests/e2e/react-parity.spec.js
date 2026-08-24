/* React 工作台与旧入口的一致性门禁。

   迁移的验收标准是「两个入口看起来、用起来一样」，这条标准必须由机器判定：
   上一版 React 迁移正是在没有像素卡口的情况下逐步演变成了另一套界面。

   两层断言：
     1. 布局契约——关键节点的几何、计算样式与文案逐项比对，差异可精确定位；
     2. 界面像素——隐去 3D 画布后整屏比对，容差之外即失败。
   3D 视口本身不参与像素比对：两个入口是各自独立的 WebGL 上下文，
   取帧时刻与抗锯齿噪声不具备可复现性，改用布局契约约束其尺寸与层叠。 */
"use strict";

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

async function waitBooted(page) {
  await page.waitForFunction(() => window.FX && window.FX.sim && window.FX.sim.slice, null, { timeout: 30_000 });
  // 启动动画结束后布局才稳定（body.boot 由引导流程在 1.6s 后移除）
  await page.waitForFunction(() => !document.body.classList.contains("boot"), null, { timeout: 10_000 });
  await page.waitForTimeout(500);
}

async function captureContract(page, url) {
  await page.goto(url);
  await waitBooted(page);
  return page.evaluate(
    ([selectors, styleKeys]) => {
      const round = (value) => Math.round(value);
      const entries = [];
      for (const selector of selectors) {
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
    [TRACKED_SELECTORS, TRACKED_STYLES]
  );
}

/** 隐去 3D 画布后整屏截图，只保留确定性的 CSS 界面层。 */
async function captureInterface(page, url) {
  await page.goto(url);
  await waitBooted(page);
  await page.evaluate(() => {
    const canvas = document.getElementById("gl");
    if (canvas) canvas.style.visibility = "hidden";
    /* 校准同步等异步提示会在不确定的时刻浮现并遮挡界面，
       它们不属于稳定界面的一部分，比对前统一隐去。 */
    const toasts = document.getElementById("toasts");
    if (toasts) toasts.style.display = "none";
  });
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
    const diff = await mismatchRatio(page, legacyShot, reactShot);
    expect(diff.ratio, `差异像素 ${diff.mismatched} 处，范围 ${JSON.stringify(diff.box)}`).toBeLessThanOrEqual(
      MAX_MISMATCH_RATIO
    );
  });
});
