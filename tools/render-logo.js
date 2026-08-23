"use strict";

const path = require("path");
const { chromium } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "docs", "images", "forgex-logo.svg");
const OUTPUT = path.join(ROOT, "docs", "images", "forgex-logo.png");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const url = `file:///${SOURCE.replace(/\\/g, "/")}`;

  await page.goto(url);
  await page.screenshot({ path: OUTPUT, omitBackground: true });

  await context.close();
  await browser.close();
  console.log(`Transparent logo rendered: ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
