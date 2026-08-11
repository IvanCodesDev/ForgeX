/* React simulator closeout: browser-only preview provenance, parameter response and mobile layout. */
"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
const SCREENSHOT_DIR = path.join(ROOT, "test-results", "react-stage3-simulator");

function watchErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function capture(page, filename) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const options = { path: path.join(SCREENSHOT_DIR, filename), fullPage: true };
  try {
    await page.screenshot(options);
  } catch (error) {
    await page.waitForTimeout(150);
    await page.screenshot(options).catch(() => {
      throw error;
    });
  }
}

async function openSimulator(page) {
  await page.goto("/react/");
  await expect(page).toHaveTitle("FORGE·X 工业工作台");
  await expect(page.getByText("匿名访客", { exact: true })).toHaveText("匿名访客");
  await page.getByRole("link", { name: "过程仿真" }).click();
  await expect(page).toHaveURL(/#\/simulator$/);
  await expect(
    page.getByRole("heading", { name: "先在浏览器快速验证工艺方向，再把正式任务交给权威计算核心。" })
  ).toBeVisible();
}

test.describe("React simulator closeout", () => {
  test("即时预览不请求 API，保留非权威来源且参数变化会重算摘要", async ({ page }) => {
    const errors = watchErrors(page);
    const workloadRequests = [];
    let observeWorkload = false;
    page.on("request", (request) => {
      if (!observeWorkload) return;
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
        workloadRequests.push(`${request.method()} ${url.pathname}`);
      }
    });

    await openSimulator(page);
    await expect(page.getByText("浏览器即时预览（非权威）", { exact: true }).first()).toBeVisible();
    observeWorkload = true;

    const layerHeight = page.getByRole("spinbutton", { name: /层高/ });
    await layerHeight.fill("0.20");
    await page.getByRole("button", { name: "立即重新计算" }).click();

    const summary = page.getByRole("region", { name: "即时计算结果" });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("预计总时长");
    const layerCount = summary.getByText("层 / 路径", { exact: true }).locator("..").locator("strong");
    await expect(layerCount).toBeVisible();
    const baselineLayers = await layerCount.textContent();

    await layerHeight.fill("0.30");
    await page.getByRole("button", { name: "立即重新计算" }).click();
    await expect
      .poll(() => layerCount.textContent(), { message: "改变层高后应生成新的即时仿真层数" })
      .not.toBe(baselineLayers);

    expect(workloadRequests).toEqual([]);
    await capture(page, "01-simulator-desktop.png");
    expect(errors).toEqual([]);
  });

  test("390px 视口下 simulator 页面无水平溢出", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSimulator(page);
    await expect(page.getByRole("complementary", { name: "主导航" })).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
    await capture(page, "02-simulator-mobile-390.png");
    expect(errors).toEqual([]);
  });
});
