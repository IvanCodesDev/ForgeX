/* Stage 7.2 —— file:// 离线场景验收。

   经典入口退役后，「零依赖直开」的承诺由 dist/react-offline 的单 HTML 文件承接。
   CI 的打包步骤只校验「没有外部引用」，从没证明过它真能用：
   2026-08-27 首次真实验收就抓到 style.css 的 UTF-8 BOM 被内联进 <style> 后
   粘连在设计令牌的 :root 选择器上，整套 CSS 变量失效、界面完全坍塌——
   外链加载时 BOM 由字节解码层剥掉，所以服务模式与经典 file:// 都看不出来。
   这里按 README 对 file:// 的既有承诺逐项验收：能启动、内置模型能切片预演、
   洞察面板本地规则分析可用；设计令牌断言即上述事故的回归卡口。 */
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
const ARTIFACT = path.join(ROOT, "dist", "react-offline", "FORGE-X-React-Offline.html");
const ARTIFACT_URL = "file:///" + ARTIFACT.replace(/\\/g, "/");

/** Stage 7 视觉校验记录的归档目录（optimization/ 不入库，仅本地证据）。 */
const ARCHIVE_DIR = path.join(ROOT, "optimization", "stage7-classic-retirement", "screenshots");

/** 与 serve.js 的 buildReactFixture 同一策略：不信任磁盘上可能过期的产物，验收前重新打包。 */
function buildOfflineArtifact() {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmCli ? [npmCli, "run", "frontend:build:offline"] : ["run", "frontend:build:offline"];
  const result = childProcess.spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("offline build failed with exit code " + result.status);
  if (!fs.existsSync(ARTIFACT)) throw new Error("offline artifact missing: " + ARTIFACT);
}

function watchErrors(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  return errors;
}

async function waitBooted(page) {
  await page.goto(ARTIFACT_URL);
  await page.waitForFunction(() => window.FX && window.FX.sim && window.FX.sim.slice, null, { timeout: 30_000 });
  await page.waitForFunction(() => !document.body.classList.contains("boot"), null, { timeout: 10_000 });
}

async function archiveShot(page, name) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(ARCHIVE_DIR, name) });
}

test.describe("React 离线单文件（Stage 7.2 验收）", () => {
  test.beforeAll(() => {
    // tsc 增量编译时冷缓存的 CI 机器可能较慢，给足预算
    test.setTimeout(300_000);
    buildOfflineArtifact();
  });

  test("file:// 启动：无报错、设计令牌生效、四机型可切换", async ({ page }) => {
    const errors = watchErrors(page);
    await waitBooted(page);

    await expect(page.locator("#webgl-fallback")).toBeHidden();
    await expect(page.locator("#gl")).toBeVisible();
    await expect(page.locator("#topbar")).toBeVisible();
    await expect(page.locator("#dock")).toBeVisible();
    await expect(page.locator("#flow-pills .flow-pill")).toHaveCount(5);

    /* 设计令牌回归卡口：BOM/打包类事故的表现是 :root 令牌整体失效。
       令牌一死，所有 var() 声明在计算值阶段作废，界面即坍塌。 */
    const tokens = await page.evaluate(() => {
      const rootStyle = window.getComputedStyle(document.documentElement);
      const topbar = window.getComputedStyle(document.getElementById("topbar"));
      return { bg1: rootStyle.getPropertyValue("--bg-1").trim(), topbarPosition: topbar.position };
    });
    expect(tokens.bg1, "设计令牌 --bg-1 必须在 :root 上生效").not.toBe("");
    expect(tokens.topbarPosition).toBe("fixed");

    // 默认模型在启动时完成切片
    const state = await page.evaluate(() => ({
      model: window.FX.sim.model && window.FX.sim.model.name,
      layers: window.FX.sim.slice.totalLayers,
      machineId: window.FX.sim.machineId,
      tag: window.FX.sim.printer.MODEL_TAG,
    }));
    expect(state.model).toBe("行星齿轮");
    expect(state.layers).toBeGreaterThan(0);
    expect(state.machineId).toContain(state.tag);

    // 四机型逐台装载：切换后机台编号更新、旧调平作废、切片仍可用
    const machines = await page.evaluate(() => {
      const out = [];
      for (const id of ["i3", "delta", "gantry", "corexy"]) {
        window.FX.sim.setPrinterModel(id);
        out.push({
          id,
          printerId: window.FX.sim.printer.ID,
          machineId: window.FX.sim.machineId,
          tag: window.FX.sim.printer.MODEL_TAG,
          levelMesh: window.FX.sim.levelMesh,
          layers: window.FX.sim.slice ? window.FX.sim.slice.totalLayers : 0,
        });
      }
      return out;
    });
    expect(machines.map((m) => m.printerId)).toEqual(["i3", "delta", "gantry", "corexy"]);
    for (const machine of machines) {
      expect(machine.machineId, `机型 ${machine.id} 的机台编号`).toContain(machine.tag);
      expect(machine.levelMesh, `机型 ${machine.id} 切换后旧调平必须作废`).toBeNull();
      expect(machine.layers, `机型 ${machine.id} 切换后切片必须可用`).toBeGreaterThan(0);
    }

    expect(errors).toEqual([]);
    await archiveShot(page, "offline-boot.png");
  });

  test("file:// 内置模型切片预演可用", async ({ page }) => {
    test.slow(); // 换模型触发全量重切片，软渲染 CI 上偏慢
    const errors = watchErrors(page);
    await waitBooted(page);

    // 模型页：换一个内置模型并完成切片
    await page.locator("#flow-pills .flow-pill", { hasText: "模型" }).click();
    await expect(page.locator("#ctx-panel")).toBeVisible();
    await page.locator("#ctx-body .model-card", { hasText: "涡轮叶轮" }).click();
    await expect(page.locator("#toasts")).toContainText("已载入「涡轮叶轮」并完成切片");
    const layers = await page.evaluate(() => ({
      model: window.FX.sim.model.id,
      total: window.FX.sim.slice.totalLayers,
    }));
    expect(layers.model).toBe("impeller");
    expect(layers.total).toBeGreaterThan(0);

    // 切片页：逐层预览画布、层滑块与统计
    await page.locator("#flow-pills .flow-pill", { hasText: "切片" }).click();
    await expect(page.locator("#ctx-body .layer-canvas-wrap canvas")).toBeVisible();
    await expect(page.locator("#ctx-body .lc-tag")).toContainText("LAYER 1");
    await expect(page.locator("#ctx-body .legend-row .mini-check input")).toBeChecked();

    const middle = String(Math.max(2, Math.floor(layers.total / 2)));
    await page.locator("#ctx-body input.range").fill(middle);
    await expect(page.locator("#ctx-body .lc-tag")).toContainText(`LAYER ${middle}`);
    await expect(page.locator("#ctx-body .lc-tag")).toContainText("paths");
    await expect(page.locator("#ctx-body")).toContainText("总层数");
    await expect(page.locator("#ctx-body")).toContainText(String(layers.total));
    await expect(page.locator("#ctx-body")).toContainText("预估时长");

    expect(errors).toEqual([]);
    await archiveShot(page, "offline-slice.png");
  });

  test("file:// 洞察面板本地规则分析可用", async ({ page }) => {
    test.slow(); // 洞察页要在软渲染 CI 上跑整套统计
    const errors = watchErrors(page);
    await waitBooted(page);

    await page.locator("#pill-insight").click();
    await expect(page.locator("#insight-panel")).toBeVisible();
    // file:// 下后端不可用，引擎标识必须如实显示为本地
    await expect(page.locator("#insight-engine-tag")).toHaveText(/本地规则/);
    await expect(page.locator("#insight-body")).toContainText("本地规则引擎");
    // 内置机群数据集就位，KPI 直接可读
    await expect(page.locator("#insight-body")).toContainText("机群仿真 · 400");
    await expect(page.locator("#insight-body .kpi-grid")).toContainText("任务总数");

    // 快捷问题走完整本地统计管线：结论 + 置信区间 + 证据链
    await page.locator(".quick-qs .chip", { hasText: "哪台机故障率最高" }).click();
    await expect(page.locator(".report-box .rp-title")).toHaveText("机台故障率排行", { timeout: 30_000 });
    await expect(page.locator(".report-box .rp-head")).toContainText("本地规则引擎（无 AI）");
    await expect(page.locator(".report-box .rp-head")).toContainText("400 行");
    await expect(page.locator(".report-box .verdict")).toContainText("故障率最高");
    await expect(page.locator(".report-box .verdict")).toContainText("95%CI");
    await expect(page.locator(".report-box .rp-evi summary")).toContainText("计算依据");
    // 内置数据必须带合成来源标记，不冒充真实产线
    await expect(page.locator(".report-box .rp-prov")).toHaveClass(/synth/);
    await expect(page.locator(".report-box .rp-prov")).toContainText("非真实产线数据");

    expect(errors).toEqual([]);
    await archiveShot(page, "offline-insight.png");
  });
});
