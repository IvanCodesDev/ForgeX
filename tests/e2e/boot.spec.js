/* 启动与核心交互 —— 覆盖「打不开」与「点了没反应」这两类。

   纯逻辑测试永远抓不到这些：切片算法再正确，只要 index.html 少加载一个脚本、
   或者某个 id 改名没同步，用户看到的就是一片黑。 */
"use strict";

const { test, expect } = require("@playwright/test");
const path = require("path");

/** 收集控制台错误与未捕获异常。任何一条都视为失败——静默报错是最难查的那种。 */
function watchErrors(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  return errors;
}

/** 等 3D 场景与仿真器就绪（main.js 会把句柄挂到 window.FX 供调试） */
async function waitBooted(page) {
  await page.waitForFunction(() => window.FX && window.FX.sim && window.FX.sim.slice, null, { timeout: 30_000 });
}

test.describe("启动", () => {
  test("带后端打开：无控制台报错，3D 与仿真器就绪", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    await waitBooted(page);

    // WebGL 兜底页必须没出现——它出现就意味着 3D 没起来
    await expect(page.locator("#webgl-fallback")).toBeHidden();
    await expect(page.locator("#gl")).toBeVisible();

    const state = await page.evaluate(() => ({
      model: window.FX.sim.model && window.FX.sim.model.name,
      layers: window.FX.sim.slice.totalLayers,
      printer: window.FX.sim.printer.MODEL_TAG,
      machineId: window.FX.sim.machineId,
    }));
    expect(state.model).toBeTruthy();
    expect(state.layers).toBeGreaterThan(0);
    expect(state.printer).toBeTruthy();
    // P0 修的那个缺陷：机台编号必须来自实际机型，不能写死
    expect(state.machineId).toContain(state.printer);

    expect(errors).toEqual([]);
  });

  test("file:// 直开同样可用（零依赖承诺的核心）", async ({ page }) => {
    const errors = watchErrors(page);
    const url = "file:///" + path.resolve(__dirname, "..", "..", "index.html").replace(/\\/g, "/");
    await page.goto(url);
    await waitBooted(page);

    await expect(page.locator("#webgl-fallback")).toBeHidden();
    // file:// 下后端不可用，引擎标识必须如实显示为本地
    await expect(page.locator("#insight-engine-tag")).toHaveText(/本地规则/);
    expect(errors).toEqual([]);
  });
});

test.describe("流程面板", () => {
  test("五个流程页都能打开且渲染出内容", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    await waitBooted(page);

    const pills = page.locator("#flow-pills .flow-pill");
    const n = await pills.count();
    expect(n).toBeGreaterThanOrEqual(5);

    for (let i = 0; i < n; i++) {
      const label = (await pills.nth(i).textContent()).trim();
      const isInsight = label.includes("洞察");
      const panelSel = isInsight ? "#insight-panel" : "#ctx-panel";
      const body = page.locator(isInsight ? "#insight-body" : "#ctx-body");

      // 流程胶囊是开关语义：点已展开的那个会收起。
      // 面板有 360ms 进场动画，点完立刻读 isVisible() 会读到过渡中的状态——
      // 所以等 hidden 属性稳定下来再判断，必要时补一次点击。
      await pills.nth(i).click();
      await page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return el && !el.classList.contains("entering");
        },
        panelSel,
        { timeout: 5000 }
      );
      const open = await page.locator(panelSel).evaluate((el) => !el.hidden);
      if (!open) {
        await pills.nth(i).click();
        await page.waitForFunction((sel) => !document.querySelector(sel).hidden, panelSel, { timeout: 5000 });
      }

      await expect(body, `「${label}」面板没有展开`).toBeVisible();
      const text = await body.textContent();
      expect(text.trim().length, `「${label}」面板内容为空`).toBeGreaterThan(10);
    }
    expect(errors).toEqual([]);
  });

  test("切换机型会重新调平并更新机台编号", async ({ page }) => {
    await page.goto("/");
    await waitBooted(page);

    const before = await page.evaluate(() => window.FX.sim.machineId);
    const changed = await page.evaluate(() => {
      // 走公开 API 而不是点 DOM：机型列表是动态渲染的，这里要测的是数据链不是选择器
      const ids = window.FXPrinters.list.map((p) => p.id);
      const other = ids.find((id) => id !== window.FX.sim.printer.ID);
      window.FX.sim.setPrinterModel(other);
      return { id: window.FX.sim.machineId, tag: window.FX.sim.printer.MODEL_TAG };
    });
    expect(changed.id).not.toBe(before);
    expect(changed.id).toContain(changed.tag);
    // 换机台后旧调平数据必须作废——床面误差场是机台固有的
    expect(await page.evaluate(() => window.FX.sim.levelMesh)).toBeNull();
  });
});

test.describe("参数面板", () => {
  test("切换材料会联动温度与风扇", async ({ page }) => {
    await page.goto("/");
    await waitBooted(page);
    await page.locator("#btn-params").click();
    await expect(page.locator("#param-panel")).toBeVisible();

    const before = await page.evaluate(() => ({ ...window.FX.sim.settings }));
    // 点材料 chip（ABS 与 PLA 的温度窗口差别最大，最容易看出联动是否生效）
    await page.locator("#param-body .chip", { hasText: "ABS" }).first().click();
    const after = await page.evaluate(() => ({ ...window.FX.sim.settings }));

    expect(after.material).toBe("ABS");
    expect(after.nozzleTemp).toBeGreaterThan(before.nozzleTemp);
    expect(after.bedTemp).toBeGreaterThan(before.bedTemp);
    expect(after.fanSpeed).toBeLessThan(before.fanSpeed); // ABS 要减风
  });

  test("打印中锁定几何参数（与真实切片器行为一致）", async ({ page }) => {
    await page.goto("/");
    await waitBooted(page);
    await page.evaluate(() => {
      window.FX.sim.simMult = 8;
      window.FX.sim.start();
    });
    await page.waitForFunction(() => window.FX.sim.state !== "idle");

    const locked = await page.evaluate(() => {
      const before = window.FX.sim.settings.layerHeight;
      window.FX.sim.updateSettings({ layerHeight: 0.28 });   // 几何参数：应被拒绝
      const geom = window.FX.sim.settings.layerHeight;
      window.FX.sim.updateSettings({ fanSpeed: 55 });        // 非几何：应生效
      return { before, geom, fan: window.FX.sim.settings.fanSpeed };
    });
    expect(locked.geom).toBe(locked.before);
    expect(locked.fan).toBe(55);
  });
});
