/* Stage 2 React 竖切片：真实构建产物上的导航、Profile、强摘要对账与分析回归。 */
"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
const SCREENSHOT_DIR = path.join(ROOT, "test-results", "react-stage2");
const GCODE_FIXTURE = path.join(ROOT, "validation", "fixtures", "cura-marlin.gcode");
const MACHINE_LOG_FIXTURE = path.join(ROOT, "validation", "fixtures", "cura-marlin.machine-log.json");

function watchErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function capture(page, filename, options = {}) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const screenshotOptions = { path: path.join(SCREENSHOT_DIR, filename), fullPage: true, ...options };
  try {
    await page.screenshot(screenshotOptions);
  } catch (error) {
    await page.waitForTimeout(150);
    await page.screenshot(screenshotOptions).catch(() => {
      throw error;
    });
  }
}

async function openReact(page) {
  await page.goto("/react/");
  await expect(page).toHaveTitle("FORGE·X 工业工作台");
  await expect(page.getByRole("main")).toBeVisible();
}

test.describe("React Stage 2", () => {
  test("加载、导航与匿名身份 Header", async ({ page }) => {
    const errors = watchErrors(page);
    await openReact(page);

    await expect(page.getByRole("banner")).toContainText("FORGE·X");
    await expect(page.getByText("服务接入", { exact: true })).toBeVisible();
    await expect(page.getByText("匿名访客", { exact: true })).toBeVisible();
    await expect(page.getByLabel("通知，1 条")).toBeVisible();

    await page.getByRole("link", { name: "G-code 切片" }).click();
    await expect(page).toHaveURL(/#\/gcode$/);
    await expect(page.getByRole("heading", { name: "G-code 权威摘要前的即时预览" })).toBeVisible();

    await page.getByRole("link", { name: "数据分析" }).click();
    await expect(page).toHaveURL(/#\/analytics$/);
    await expect(page.getByRole("heading", { name: /数据来源、规则判断与统计证据/ })).toBeVisible();

    await page.getByRole("link", { name: "迁移总览" }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole("heading", { name: "主用户流程按可回滚竖切片迁入 React。" })).toBeVisible();
    await capture(page, "01-overview-navigation-identity.png");
    expect(errors).toEqual([]);
  });

  test("Delta + PETG 解析 validation fixture，并与匹配真机日志 verified 对账", async ({ page }) => {
    const errors = watchErrors(page);
    const authorityRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/gcode/analyze") authorityRequests.push(request.url());
    });
    await openReact(page);
    await page.getByRole("link", { name: "G-code 切片" }).click();

    await page.locator("#gcode-profile-machine").selectOption("delta");
    await page.locator("#gcode-profile-material").selectOption("PETG");
    await expect(page.locator("#gcode-profile-bed-size")).toHaveValue("260");
    await expect(page.locator("#gcode-profile-density")).toHaveValue("1.27");
    await expect(page.locator("#gcode-profile-origin")).toHaveValue("center");

    await page.locator('input[type="file"][accept*=".gcode"]').setInputFiles(GCODE_FIXTURE);
    await expect(page.getByText(/^摘要口径：/)).toContainText("浏览器即时预览（非权威）");
    const summary = page.getByRole("region", { name: /G-code 摘要/ });
    await expect(summary).toContainText("层数");
    await expect(summary.locator("article").first().locator("strong")).toHaveText("2");
    await expect(page.getByText(/0881cfdac2ef41f6df48f7f5e0f47fd632dcddec8238955ce3a59a6bd754cf07/)).toBeVisible();

    const logInput = page.getByLabel("选择真机日志");
    await expect(logInput).toBeEnabled();
    await logInput.setInputFiles(MACHINE_LOG_FIXTURE);
    await expect(page.getByText("已验证 · verified", { exact: true })).toBeVisible();
    const reconciliation = page.getByRole("table", { name: "真机日志计划与实测对账" });
    await expect(reconciliation).toBeVisible();
    await expect(reconciliation.getByRole("row")).toHaveCount(5);
    await expect(reconciliation).toContainText("计划");
    await expect(reconciliation).toContainText("实测");
    expect(authorityRequests).toEqual([]);
    await expect(page.getByLabel("当前 G-code 层的三维路径预览")).toBeVisible();
    await capture(page, "02-delta-petg-gcode-log-verified.png");
    expect(errors).toEqual([]);
  });

  test("分析页显式标记来源，并同步呈现规则报告、图表与表格", async ({ page }) => {
    const errors = watchErrors(page);
    await openReact(page);
    await page.getByRole("link", { name: "数据分析" }).click();

    const provenance = page.getByLabel("数据来源声明");
    await expect(provenance).toContainText("来源：");
    await expect(provenance).toContainText("非真实产线数据");
    await page.getByRole("button", { name: "运行规则分析" }).click();

    const report = page.locator(".analytics-report");
    await expect(report).toContainText("计算引擎：本地规则引擎（非 AI）");
    await expect(report.getByRole("img")).toBeVisible();
    await expect(report.getByRole("table", { name: /数据表$/ })).toBeVisible();
    await expect(report.getByRole("table", { name: "分析报告统计证据" })).toBeVisible();
    await capture(page, "03-analytics-provenance-chart-table.png");
    expect(errors).toEqual([]);
  });

  test("校准治理页读取公开目录，并保持审核与分享边界可见", async ({ page }) => {
    const errors = watchErrors(page);
    await openReact(page);
    await page.getByRole("link", { name: "校准治理" }).click();

    await expect(page.getByRole("heading", { name: /已发布模型、验证证据与人工审核队列/ })).toBeVisible();
    const catalog = page.getByRole("region", { name: "已发布校准目录" });
    await expect(catalog).toContainText(/服务端当前没有已发布校准 bundle。|active/);
    await expect(page.getByText("浏览器治理页固定为只读；审核队列仅向受信后台的专用身份开放。")).toBeVisible();
    await expect(page.getByText("浏览器只读", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "批准并发布" })).toHaveCount(0);
    const token = page.getByLabel("18 位分享 token");
    await token.fill("bad-token");
    await expect(page.getByRole("alert")).toContainText("18 位十六进制值");
    await token.fill("0123456789abcdef01");
    await expect(page.getByRole("link", { name: "打开服务端分享页" })).toHaveAttribute(
      "href",
      "/share/0123456789abcdef01"
    );
    await capture(page, "05-governance-public-readonly.png");
    expect(errors).toEqual([]);
  });

  test("390px 移动端无页面级水平溢出", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openReact(page);
    await expect(page.getByRole("complementary", { name: "主导航" })).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
    await capture(page, "04-mobile-390-no-overflow.png");
    expect(errors).toEqual([]);
  });
});
