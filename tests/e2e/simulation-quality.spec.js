"use strict";
const fs = require("fs");
const crypto = require("crypto");
const { test, expect } = require("@playwright/test");
async function ready(page) {
  await page.goto("/react");
  await page.waitForFunction(() => window.FX?.sim?.slice);
  await page.locator("#flow-pills .flow-pill").first().click();
}
test("仿真完成生成来源明确的质量报告并下载审计", async ({ page }) => {
  await ready(page);
  const buffer = Buffer.from("G90\nM82\nG1 X0 Y0 Z0.2 F600\nG1 X10 Y0 E1 F600\n");
  await page
    .locator("#gcode-input")
    .setInputFiles({ name: "quality-source.gcode", mimeType: "application/x-gcode", buffer });
  await expect(page.locator("#gcode-summary")).toContainText("quality-source.gcode");
  const result = await page.evaluate(() => {
    const sim = window.FX.sim;
    sim.simMult = 20;
    sim.start();
    for (let i = 0; i < 20000 && !["done", "fault"].includes(sim.state); i++) sim.tick(1 / 60);
    return { state: sim.state, score: sim.lastQuality?.score };
  });
  expect(result.state).toBe("done");
  await page.locator("#flow-pills .flow-pill").nth(3).click();
  await expect(page.getByText("最近一次仿真质量报告", { exact: true })).toBeVisible();
  await expect(page.getByText(/不是打印机实测或成品检测/)).toBeVisible();
  await expect(page.locator('[data-quality-source="browser-simulation"]')).toContainText("quality-source.gcode");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "下载仿真质量审计 JSON", exact: true }).click(),
  ]);
  const audit = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  expect(audit.source).toBe("browser-simulation");
  expect(audit.result.score).toBe(result.score);
  expect(audit.basis.gcodeSha256).toBe(crypto.createHash("sha256").update(buffer).digest("hex"));
  expect(audit.basis.initialSettings.material).toBeTruthy();
  expect(audit.basis.telemetry.printTime).toBeGreaterThan(0);
});
