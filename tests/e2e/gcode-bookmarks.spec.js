"use strict";
const { test, expect } = require("@playwright/test");
const content = "G20\nG90\nM82\nG92 X0 Y0 E0\nG1 X1 Z0.01 E0.1 F60\nG21\nG1 X50.8 E5.08\n";
async function analyze(page, name = "inch-source.gcode") {
  await page.locator("#flow-pills .flow-pill").first().click();
  await page
    .locator("#gcode-input")
    .setInputFiles({ name, mimeType: "application/x-gcode", buffer: Buffer.from(content) });
  await expect(page.locator('#authority-summary[data-authority="done"]')).toBeVisible({ timeout: 30000 });
  await page.locator("#flow-pills .flow-pill").nth(1).click();
  await page.locator("#gcode-replay-panel > summary").click();
}
test.describe("C# 来源绑定回放书签", () => {
  test.skip(process.env.E2E_GCODE_AUTHORITY !== "dotnet", "要求真实 C# 异步作业");
  test("英寸/毫米混合文件真实核算 → 保存书签 → 刷新重分析 → 重新核验", async ({ page }) => {
    await page.goto("/react");
    await page.waitForFunction(() => window.FX?.sim?.slice);
    await analyze(page);
    const planned = page.waitForResponse((r) => r.url().includes("/layer-timeline?"));
    await page.getByRole("button", { name: "加载权威时间轴", exact: true }).click();
    const plan = await (await planned).json();
    expect(plan.totalSeconds).toBeCloseTo(2, 10);
    expect(plan.totalPositiveExtrusionMm).toBeCloseTo(5.08, 10);
    await page.getByLabel("回放时间（秒）").fill("1");
    const checked = page.waitForResponse((r) => r.url().endsWith("/replay-checkpoints"));
    await page.getByRole("button", { name: "校验回放时间点", exact: true }).click();
    const original = await (await checked).json();
    await expect(page.locator("#gcode-replay-result")).toBeVisible();
    await page.locator("#replay-bookmarks summary").click();
    await page.getByLabel("回放书签名称").fill("重点观察");
    await page.getByRole("button", { name: "保存已核验时间为书签", exact: true }).click();
    await expect(page.locator('#replay-bookmarks[data-bookmark-count="1"]')).toBeVisible();
    await page.reload();
    await page.waitForFunction(() => window.FX?.sim?.slice);
    await analyze(page, "same-source-new-job.gcode");
    await page.locator("#replay-bookmarks summary").click();
    const restored = page.waitForResponse((r) => r.url().endsWith("/replay-checkpoints"));
    await page.getByRole("button", { name: "恢复并核验：重点观察", exact: true }).click();
    const fresh = await (await restored).json();
    expect(fresh.basis.jobId).not.toBe(original.basis.jobId);
    expect(fresh.basis.inputSha256).toBe(original.basis.inputSha256);
    expect(fresh.elapsedSeconds).toBe(1);
    expect(fresh.fingerprint).not.toBe(original.fingerprint);
    await expect(page.locator("#gcode-replay-result")).toBeVisible();
    await page.getByRole("button", { name: "删除书签：重点观察", exact: true }).click();
    await expect(page.locator('#replay-bookmarks[data-bookmark-count="0"]')).toBeVisible();
  });
});
