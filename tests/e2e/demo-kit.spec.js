"use strict";

const path = require("path");
const { test, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
const demo = (rel) => path.join(ROOT, "demo", rel);

test("录屏素材可通过真实界面完成整条导入链", async ({ page }) => {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.locator("body")).not.toHaveClass(/boot/);
  await expect(page.locator("#ctx-panel")).toBeHidden();
  await expect(page.locator(".flow-pill.on")).toHaveCount(0);

  await page.locator("#flow-pills .flow-pill").first().click();
  await expect(page.locator("#ctx-panel")).toBeVisible();
  await expect(page.locator("#ctx-title")).toHaveText("模型与摆放");

  await page.locator("#profile-input").setInputFiles(demo("profile/02-demo-profile.json"));
  await expect(page.locator("#toasts")).toContainText("Profile 已导入");
  await expect(page.locator("#ctx-body")).toContainText("演示 CoreXY 320");

  await page.locator("#file-input").setInputFiles(demo("assets/01-turbine-relief.png"));
  await expect(page.locator(".img-preview")).toContainText("01-turbine-relief.png", { timeout: 30_000 });

  await page.locator("#gcode-input").setInputFiles(demo("replay/03-demo-turbine.gcode"));
  await expect(page.locator("#gcode-summary")).toContainText("18 层");
  await expect(page.locator("#gcode-summary")).toContainText("OrcaSlicer 2.3.0");

  await page.locator("#machine-log-input").setInputFiles(demo("replay/04-demo-machine-log.json"));
  await expect(page.locator("#machine-log-summary")).toContainText("DEMO-CX320-01");
  await expect(page.locator("#machine-log-summary")).toContainText("Marlin 2.1.2-demo");

  await page.locator("#calibration-input").setInputFiles(demo("calibration/05-demo-calibration.json"));
  await expect(page.locator("#toasts")).toContainText("校准包已导入");

  await page.locator("#pill-insight").click();
  await page.locator("#csv-input").setInputFiles(demo("insight/06-demo-production.csv"));
  await expect(page.locator("#insight-body")).toContainText("我的上传 · 72");
  await expect(page.locator("#insight-body")).toContainText("任务总数");

  expect(errors).toEqual([]);
});
