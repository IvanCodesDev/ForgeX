/* Stage 4-F：生产 React → Node 同源代理 → C# 权威报告的真实浏览器竖切片。 */
"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
const SCREENSHOT_DIR = path.join(ROOT, "test-results", "react-stage4-analytics-authority");

test.describe("React Stage 4-F Analytics authority", () => {
  test.skip(process.env.E2E_ANALYTICS_AUTHORITY !== "dotnet", "requires the real .NET authority sidecar");

  test("uses an exactly matched C# report as the displayed and exported authority", async ({ page }) => {
    const errors = [];
    const authorityResponses = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("response", (response) => {
      if (response.url().endsWith("/api/v1/analytics/reports")) {
        authorityResponses.push(response.status());
      }
    });

    await page.goto("/react/#/analytics");
    await expect(page.getByRole("heading", { name: "C# 权威结果门禁" })).toBeVisible();
    await expect(page.getByText(/C# 权威报告已启用/)).toBeVisible();
    await expect(page.getByText("C# 权威规则引擎 v1.3.0")).toBeVisible();
    await expect(page.getByText("浏览器 JS 规则引擎（非 AI）")).toHaveCount(0);
    await expect.poll(() => authorityResponses).toEqual([200]);
    expect(errors).toEqual([]);

    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "analytics-dotnet-authority.png"), fullPage: true });
  });

  test("keeps the C# authority gate inside a 390px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/react/#/analytics");
    await expect(page.getByText(/C# 权威报告已启用/)).toBeVisible();
    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - window.innerWidth,
      document: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(0);
    expect(overflow.document).toBeLessThanOrEqual(0);

    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "analytics-dotnet-authority-390.png"), fullPage: true });
  });
});
