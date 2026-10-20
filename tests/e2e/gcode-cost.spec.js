"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { test, expect } = require("@playwright/test");
const fixture = path.resolve(__dirname, "../../contracts/validation/fixtures/cura-marlin.gcode");
const sha = crypto.createHash("sha256").update(fs.readFileSync(fixture)).digest("hex");
async function prepare(page) {
  await page.goto("/react");
  await page.waitForFunction(() => window.FX?.sim?.slice);
  await page.locator("#flow-pills .flow-pill").first().click();
  await page.locator("#gcode-input").setInputFiles(fixture);
  await expect(page.locator('#authority-summary[data-authority="done"]')).toBeVisible({ timeout: 30000 });
  await page.locator("#gcode-cost-panel summary").click();
  for (const [field, value] of Object.entries({
    averagePowerWatts: "200",
    electricityCnyPerKwh: "1",
    machineCnyPerHour: "5",
    materialCnyPerKg: "100",
  }))
    await page.locator(`[data-cost-input="${field}"]`).fill(value);
  await page.getByLabel("成本输入依据").fill("试验功率平均记录与费率单 2026-10-21");
}
test.describe("C# 作业能耗与成本估算", () => {
  test.skip(process.env.E2E_GCODE_AUTHORITY !== "dotnet", "专项要求真实 C# 异步作业");
  test("真实作业 → 完整成本 → 审计下载 → 修改输入后部分估算", async ({ page }) => {
    await prepare(page);
    const sent = page.waitForResponse(
      (response) => response.url().endsWith("/cost-estimates") && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "计算成本", exact: true }).click();
    const response = await sent;
    expect(response.status()).toBe(200);
    const estimate = await response.json();
    const sourceResponse = await page.request.get(`/api/v1/jobs/${estimate.basis.jobId}`);
    expect(sourceResponse.ok()).toBe(true);
    const snapshot = await sourceResponse.json();
    expect(estimate.basis.inputSha256).toBe(sha);
    expect(estimate.basis.profileFingerprint).toBe(snapshot.result.profile.fingerprint);
    expect(estimate.basis.durationSeconds).toBe(snapshot.result.summary.estimatedTimeSeconds);
    expect(estimate.basis.filamentMassG).toBe(snapshot.result.summary.filamentMassG);
    expect(estimate.totals.energyKwh).toBeCloseTo((estimate.basis.durationSeconds * 200) / 3600000, 8);
    expect(estimate.totals.totalCostCny).toBeCloseTo(
      estimate.totals.materialCostCny + estimate.totals.electricityCostCny + estimate.totals.machineTimeCostCny,
      6
    );
    await expect(page.locator('#gcode-cost-result[data-cost-complete="true"]')).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "下载成本审计 JSON" }).click(),
    ]);
    const audit = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    expect(audit).toEqual(estimate);
    const artifacts = path.resolve(__dirname, "../../backend/artifacts");
    fs.mkdirSync(artifacts, { recursive: true });
    await page.locator("#gcode-cost-panel").screenshot({ path: path.join(artifacts, "gcode-cost-panel.png") });
    await page.locator('[data-cost-input="averagePowerWatts"]').fill("");
    await expect(page.locator("#gcode-cost-result")).toHaveCount(0);
    const partial = page.waitForResponse((response) => response.url().endsWith("/cost-estimates"));
    await page.getByRole("button", { name: "计算成本", exact: true }).click();
    const incomplete = await (await partial).json();
    expect(incomplete.totals.totalCostCny).toBeNull();
    expect(incomplete.totals.energyKwh).toBeNull();
    expect(incomplete.missingInputs).toEqual(["averagePowerWatts"]);
    await expect(page.locator('#gcode-cost-result[data-cost-complete="false"]')).toContainText("输入不完整");
  });
  test("切换模型取消在途估算，旧结果不会恢复成本面板", async ({ page }) => {
    await prepare(page);
    let release, started, finished;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const began = new Promise((resolve) => {
      started = resolve;
    });
    const done = new Promise((resolve) => {
      finished = resolve;
    });
    await page.route("**/cost-estimates", async (route) => {
      const response = await route.fetch();
      started();
      await held;
      try {
        await route.fulfill({ response });
      } catch {
        /* Switching models aborts this request. */
      } finally {
        finished();
      }
    });
    await page.getByRole("button", { name: "计算成本", exact: true }).click();
    await began;
    await page.locator(".model-card", { hasText: "行星齿轮" }).click();
    release();
    await done;
    await expect(page.locator("#gcode-cost-panel")).toHaveCount(0);
    await expect(page.locator("#gcode-cost-result")).toHaveCount(0);
    expect(await page.evaluate(() => window.FX.sim.model.id)).toBe("gear");
  });
});
