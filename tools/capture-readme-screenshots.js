"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "docs", "images");
const demo = (relativePath) => path.join(ROOT, "demo", relativePath);

async function settle(page) {
  await page.waitForTimeout(800);
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(300);
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  const fileUrl = `file:///${path.join(ROOT, "index.html").replace(/\\/g, "/")}`;
  await page.goto(fileUrl);
  await page.waitForFunction(() => window.FX?.sim?.slice, null, { timeout: 30_000 });
  await page.waitForFunction(() => !document.body.classList.contains("boot"));

  await page.locator('#hud-cam button[data-v="overview"]').click();
  await settle(page);
  await page.screenshot({ path: path.join(OUTPUT, "workbench-overview.png") });

  await page.locator("#flow-pills .flow-pill", { hasText: "模型" }).click();
  await page.locator("#gcode-input").setInputFiles(demo("replay/03-demo-turbine.gcode"));
  await page.locator("#machine-log-input").setInputFiles(demo("replay/04-demo-machine-log.json"));
  await page.waitForSelector("#machine-log-summary");
  await page.locator("#flow-pills .flow-pill", { hasText: "切片" }).click();
  await page.waitForSelector("#ctx-body input[type=range]");
  await page.locator("#ctx-body input[type=range]").first().fill("9");
  await settle(page);
  await page.screenshot({ path: path.join(OUTPUT, "gcode-layer-replay.png") });

  await page.locator("#pill-insight").click();
  await page.locator("#csv-input").setInputFiles(demo("insight/06-demo-production.csv"));
  await page.locator(".ask-input").fill("哪台机故障率最高，主要故障是什么");
  await page.locator(".ask-btn").click();
  await page.waitForSelector(".report-box .rp-title");
  await page.locator(".report-box").scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: path.join(OUTPUT, "production-insight.png") });

  await browser.close();
  console.log(`README screenshots saved to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
