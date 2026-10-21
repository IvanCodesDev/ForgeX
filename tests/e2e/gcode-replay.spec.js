"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { test, expect } = require("@playwright/test");
const content =
  "G90\nM83\nG1 X10 Y0 Z0.6 F600\n" +
  Array.from(
    { length: 55 },
    (_, index) => `G1 X${index % 2 ? 10 : 20} Y0 Z${((55 - index) / 100).toFixed(2)} E1 F600\n`
  ).join("");
const sha = crypto.createHash("sha256").update(content).digest("hex");
async function prepare(page) {
  await page.goto("/react");
  await page.waitForFunction(() => window.FX?.sim?.slice);
  await page.locator("#flow-pills .flow-pill").first().click();
  await page
    .locator("#gcode-input")
    .setInputFiles({ name: "descending-layers.gcode", mimeType: "application/x-gcode", buffer: Buffer.from(content) });
  await expect(page.locator('#authority-summary[data-authority="done"]')).toBeVisible({ timeout: 30000 });
  await page.locator("#flow-pills .flow-pill").nth(1).click();
  await page.locator("#gcode-replay-panel summary").click();
  const response = page.waitForResponse((r) => r.url().includes("/layer-timeline?"));
  await page.getByRole("button", { name: "加载权威时间轴", exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  await expect(page.locator("#gcode-timeline-result")).toBeVisible();
  return result.json();
}
test.describe("C# 层计划回放", () => {
  test.skip(process.env.E2E_GCODE_AUTHORITY !== "dotnet", "专项要求真实 C# 作业");
  test("降层执行顺序 → 分页 → 按时间核验 → 预览联动 → 审计下载", async ({ page }) => {
    const first = await prepare(page);
    expect(first.basis.inputSha256).toBe(sha);
    expect(first.layers).toHaveLength(50);
    expect(first.layers[0].layerIndex).toBe(54);
    expect(first.layers[0].zMm).toBe(0.55);
    expect(first.nextOffset).toBe(50);
    await page.locator(".replay-row").first().getByRole("button", { name: "预览此层", exact: true }).click();
    await expect(page.locator(".lc-tag")).toContainText("LAYER 55");
    const next = page.waitForResponse((r) => r.url().includes("/layer-timeline?offset=50"));
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    const last = await (await next).json();
    expect(last.layers).toHaveLength(5);
    expect(last.fingerprint).toBe(first.fingerprint);
    await expect(page.locator(".replay-row")).toHaveCount(5);
    await page.getByRole("button", { name: "定位计划终点", exact: true }).click();
    const sought = page.waitForResponse((r) => r.url().endsWith("/replay-checkpoints"));
    await page.getByRole("button", { name: "校验回放时间点", exact: true }).click();
    const checkpoint = await (await sought).json();
    expect(checkpoint.phase).toBe("completed");
    expect(checkpoint.completedLayerCount).toBe(55);
    expect(checkpoint.completedPositiveExtrusionMm).toBe(55);
    await expect(page.locator('#gcode-replay-result[data-phase="completed"]')).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "下载层计划审计 JSON", exact: true }).click(),
    ]);
    const audit = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    expect(audit.timelinePage).toEqual(last);
    expect(audit.checkpoint).toEqual(checkpoint);
    const artifacts = path.resolve(__dirname, "../../backend/artifacts");
    fs.mkdirSync(artifacts, { recursive: true });
    await page.locator("#ctx-body").evaluate((body) => {
      const panel = body.querySelector("#gcode-replay-panel");
      body.scrollTop += panel.getBoundingClientRect().top - body.getBoundingClientRect().top;
    });
    await page.screenshot({ path: path.join(artifacts, "gcode-replay-panel.png") });
    await page.getByLabel("回放时间（秒）").fill(String(first.layers[0].startSeconds + 0.5));
    const partial = page.waitForResponse((r) => r.url().endsWith("/replay-checkpoints"));
    await page.getByRole("button", { name: "校验回放时间点", exact: true }).click();
    const active = await (await partial).json();
    expect(active.activeLayer.sequence).toBe(0);
    expect(active.completedPositiveExtrusionMm).toBe(0);
    await page.getByRole("button", { name: "预览检查点所在层", exact: true }).click();
    await expect(page.locator(".lc-tag")).toContainText("LAYER 55");
  });
  test("编辑时间或切换模型后丢弃在途检查点", async ({ page }) => {
    await prepare(page);
    let release, started;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const began = new Promise((resolve) => {
      started = resolve;
    });
    await page.route("**/replay-checkpoints", async (route) => {
      const response = await route.fetch();
      started();
      await held;
      try {
        await route.fulfill({ response });
      } catch {
        /* The edited request is aborted. */
      }
    });
    await page.getByRole("button", { name: "校验回放时间点", exact: true }).click();
    await began;
    await page.getByLabel("回放时间（秒）").fill("2");
    release();
    await expect(page.locator("#gcode-replay-result")).toHaveCount(0);
    await page.locator("#flow-pills .flow-pill").first().click();
    await page.locator(".model-card", { hasText: "行星齿轮" }).click();
    await page.locator("#flow-pills .flow-pill").nth(1).click();
    await expect(page.locator("#gcode-replay-panel")).toHaveCount(0);
  });
});
