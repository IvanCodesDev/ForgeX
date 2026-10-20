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
function logFile(name, patch = {}) {
  const buffer = Buffer.from(
    "\uFEFF" +
      JSON.stringify(
        {
          format: "forgex-machine-log",
          version: 1,
          job: {
            jobId: "METER-1",
            machineId: "FX-METER",
            status: "success",
            gcodeSha256: sha,
            durationSec: 5400,
            filamentG: 120,
            energyKwh: 0.4,
            energyEvidence: "演示电表：任务区间累计读数差额 0.4 kWh",
            ...patch,
          },
          telemetry: [],
        },
        null,
        2
      )
  );
  return { name, mimeType: "application/json", buffer };
}
async function calculate(page) {
  const ready = page.waitForResponse((response) => response.url().endsWith("/cost-estimates"));
  await page.getByRole("button", { name: "计算成本", exact: true }).click();
  expect((await ready).ok()).toBe(true);
  await expect(page.locator("#gcode-cost-result")).toBeVisible();
}
async function holdNextLogHash(page) {
  await page.evaluate(() => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    window.__logHashHeld = false;
    window.__logHashFinished = false;
    crypto.subtle.digest = async (...args) => {
      crypto.subtle.digest = original;
      window.__logHashHeld = true;
      await new Promise((resolve) => {
        window.__releaseLogHash = resolve;
      });
      const result = await original(...args);
      window.__logHashFinished = true;
      return result;
    };
  });
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
  test("真机能耗与同费率成本对账 → 原件审计 → 缺失值与错配不产生假总额", async ({ page }) => {
    await prepare(page);
    await calculate(page);
    const file = logFile("metered.json");
    await page.locator("#machine-log-input").setInputFiles(file);
    const comparison = page.locator("#machine-cost-comparison");
    await expect(comparison).toBeVisible();
    await expect(page.locator('[data-cost-comparison="total"]')).toContainText("¥19.90");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "下载成本对账 JSON" }).click(),
    ]);
    const report = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    expect(report.log.sha256).toBe(crypto.createHash("sha256").update(file.buffer).digest("hex"));
    expect(report.estimate.basis.inputSha256).toBe(sha);
    expect(report.log.gcodeSha256).toBe(sha);
    expect(report.rows.find((row) => row.key === "energy").recorded).toBe(0.4);
    expect(report.rows.find((row) => row.key === "total").recorded).toBeCloseTo(19.9, 8);
    const artifacts = path.resolve(__dirname, "../../backend/artifacts");
    fs.mkdirSync(artifacts, { recursive: true });
    // 对账区域高于侧栏可视范围；截取真实视口，避免元素截图产生大片被裁切的空白。
    await page.locator('[data-cost-comparison="duration"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, "machine-cost-comparison.png") });

    await page.locator("#machine-log-input").setInputFiles(logFile("missing-duration.json", { durationSec: null }));
    await expect(page.locator("#machine-log-summary")).toContainText("missing-duration.json");
    await expect(page.locator('[data-cost-comparison="machine"]')).toContainText("未知");
    await expect(page.locator('[data-cost-comparison="total"]')).toContainText("未知");
    await expect(page.locator("#machine-log-summary")).not.toContainText("单任务观测倍率");

    await page.locator("#machine-log-input").setInputFiles(logFile("no-evidence.json", { energyEvidence: "" }));
    await expect(page.locator("#machine-log-summary")).toContainText("no-evidence.json");
    await expect(page.locator('[data-cost-comparison="electricity"]')).toContainText("未知");

    await page.locator("#machine-log-input").setInputFiles(logFile("unbound.json", { gcodeSha256: "" }));
    await expect(page.locator("#machine-log-summary")).toContainText("unbound.json");
    await expect(comparison).toHaveCount(0);
    await expect(page.getByRole("button", { name: "下载成本对账 JSON" })).toHaveCount(0);

    await page.locator("#machine-log-input").setInputFiles(logFile("wrong-file.json", { gcodeSha256: "f".repeat(64) }));
    await expect(page.locator("#machine-log-summary")).toHaveCount(0);
    await expect(comparison).toHaveCount(0);
    await expect(page.locator("#gcode-cost-result")).toBeVisible();
  });
  test("旧日志摘要晚到不覆盖新日志，切换模型后也不会回写", async ({ page }) => {
    await prepare(page);
    await calculate(page);
    await holdNextLogHash(page);
    await page.locator("#machine-log-input").setInputFiles(logFile("old-held.json"));
    await page.waitForFunction(() => window.__logHashHeld);
    await page.locator("#machine-log-input").setInputFiles(logFile("new-log.json", { energyKwh: 0.6 }));
    await expect(page.locator("#machine-log-summary")).toContainText("new-log.json");
    await page.evaluate(() => window.__releaseLogHash());
    await page.waitForFunction(() => window.__logHashFinished);
    await expect(page.locator("#machine-log-summary")).toContainText("new-log.json");
    await expect(page.locator('[data-cost-comparison="energy"]')).toContainText("0.600000");

    await holdNextLogHash(page);
    await page.locator("#machine-log-input").setInputFiles(logFile("switch-held.json"));
    await page.waitForFunction(() => window.__logHashHeld);
    await page.locator(".model-card", { hasText: "行星齿轮" }).click();
    await page.evaluate(() => window.__releaseLogHash());
    await page.waitForFunction(() => window.__logHashFinished);
    await expect(page.locator("#gcode-cost-panel")).toHaveCount(0);
    await expect(page.locator("#machine-log-summary")).toHaveCount(0);
    await expect(page.locator("#machine-cost-comparison")).toHaveCount(0);
  });
});
