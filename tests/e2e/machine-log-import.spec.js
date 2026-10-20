"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { test, expect } = require("@playwright/test");
const { probeMachineLogWorker } = require("./helpers/machine-log-worker");
const fixture = path.resolve(__dirname, "../../contracts/validation/fixtures/cura-marlin.gcode");
const sha = crypto.createHash("sha256").update(fs.readFileSync(fixture)).digest("hex");
async function prepare(page) {
  await page.goto("/react");
  await page.waitForFunction(() => window.FX?.sim?.slice);
  await page.locator("#flow-pills .flow-pill").first().click();
  await page.locator("#gcode-input").setInputFiles(fixture);
  await page.waitForFunction(() => window.FX.sim.importedToolpath);
  await expect(page.locator("#gcode-summary")).toContainText(path.basename(fixture));
}
const small = () => ({
  name: "bound.json",
  mimeType: "application/json",
  buffer: Buffer.from(
    JSON.stringify({
      job: { gcodeSha256: sha, durationSec: 100, filamentG: 1 },
      samples: [
        { timeSec: 0, nozzleC: 20 },
        { timeSec: 100, nozzleC: 210 },
      ],
    })
  ),
});

test("百万行 CSV 后台解析，界面继续绘制，结果回传大小有界", async ({ page }) => {
  test.slow();
  await prepare(page);
  await probeMachineLogWorker(page);
  const count = 1000000;
  const rows = Array.from({ length: count }, (_, i) => `${i},210.0,60.0,${i === count - 1 ? sha : ""}`);
  const buffer = Buffer.from("time_s,nozzle_c,bed_c,gcode_sha256\n" + rows.join("\n"));
  expect(buffer.length).toBeLessThanOrEqual(20 * 1024 * 1024);
  await page.locator("#machine-log-input").setInputFiles({ name: "million.csv", mimeType: "text/csv", buffer });
  await expect(page.locator("#machine-log-summary")).toContainText("1,000,000", { timeout: 60000 });
  expect(await page.evaluate(() => window.__forgexMachineLogImportVia)).toBe("worker");
  const probe = await page.evaluate(() => window.__machineLogWorkerProbe);
  expect(probe.phases).toEqual(expect.arrayContaining(["read", "hash", "parse", "summary"]));
  expect(probe.ticks).toBeGreaterThan(1);
  expect(probe.payloadBytes).toBeLessThan(3000);
  expect(probe.terminated).toBe(true);
  const log = probe.log;
  expect(log).not.toHaveProperty("samples");
  expect(log.telemetry.sampleCount).toBe(count);
  expect(log.sourceSha256).toBe(crypto.createHash("sha256").update(buffer).digest("hex"));
  expect(log.actualTimeSec).toBe(count - 1);
  await expect(page.locator("#machine-log-summary")).toHaveAttribute("data-source-sha256", log.sourceSha256);
  const artifacts = path.resolve(__dirname, "../../backend/artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(
    path.join(artifacts, "machine-log-worker.json"),
    JSON.stringify({ bytes: buffer.length, samples: count, ...probe }, null, 2)
  );
  await page.locator("#machine-log-summary").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, "machine-log-worker.png") });
});
test("显式取消释放后台任务，迟到结果不能恢复日志", async ({ page }) => {
  await prepare(page);
  await probeMachineLogWorker(page, { holdResult: true });
  await page.locator("#machine-log-input").setInputFiles(small());
  await page.waitForFunction(() => window.__machineLogWorkerProbe.held);
  await expect(page.locator("[data-machine-log-import]")).toBeVisible();
  await page.getByRole("button", { name: "取消日志导入" }).click();
  await page.evaluate(() => window.__releaseMachineLogWorker());
  await expect(page.locator("#machine-log-summary")).toHaveCount(0);
  await expect(page.locator("[data-machine-log-import]")).toHaveCount(0);
  expect((await page.evaluate(() => window.__machineLogWorkerProbe)).terminated).toBe(true);
});
test("后台不可用时兼容解析保持原件和统计，非法新日志不保留旧结果", async ({ page }) => {
  await prepare(page);
  await probeMachineLogWorker(page, { failStartup: true });
  const file = small();
  await page.locator("#machine-log-input").setInputFiles(file);
  await expect(page.locator("#machine-log-summary")).toContainText("本机兼容解析");
  await expect(page.locator("#machine-log-summary")).toHaveAttribute(
    "data-source-sha256",
    crypto.createHash("sha256").update(file.buffer).digest("hex")
  );
  await expect(page.locator("#machine-log-summary")).toHaveAttribute("data-sample-count", "2");
  await page
    .locator("#machine-log-input")
    .setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"samples":false}') });
  await expect(page.locator("#machine-log-summary")).toHaveCount(0);
  await expect(page.locator("[data-machine-log-import]")).toHaveCount(0);
  await expect(page.locator("#toasts")).toContainText("真机日志导入失败");
});
