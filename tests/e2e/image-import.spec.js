"use strict";
const crypto = require("crypto");
const { test, expect } = require("@playwright/test");
async function ready(page) {
  await page.goto("/react");
  await page.waitForFunction(() => window.FX?.sim?.slice);
  await page.locator("#flow-pills .flow-pill").first().click();
}
async function png(page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    const c = canvas.getContext("2d");
    c.fillStyle = "white";
    c.fillRect(0, 0, 8, 8);
    c.fillStyle = "black";
    c.fillRect(2, 2, 4, 4);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return { name: "shape.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") };
}
async function holdImage(page) {
  await page.evaluate(() => {
    const Original = window.Image;
    window.__imageHeld = false;
    window.Image = new Proxy(Original, {
      construct(Target, args) {
        window.Image = Original;
        const img = Reflect.construct(Target, args);
        Object.defineProperty(img, "onload", {
          set(handler) {
            if (!handler) return;
            img.addEventListener(
              "load",
              (event) => {
                window.__imageHeld = true;
                window.__releaseImage = () => handler.call(img, event);
              },
              { once: true }
            );
          },
        });
        return img;
      },
    });
  });
}
test("图片：摘要绑定、正常建模及超大解码尺寸不替换模型", async ({ page }) => {
  await ready(page);
  const input = await png(page),
    sha = crypto.createHash("sha256").update(input.buffer).digest("hex");
  await page.locator("#file-input").setInputFiles(input);
  await expect(page.locator(".img-preview .ip-name")).toHaveText("shape.png");
  await expect(page.locator(`.img-preview [title="${sha}"]`)).toBeVisible();
  expect(await page.evaluate(() => window.FX.sim.model.id)).toBe("image");
  await page.locator("#file-input").setInputFiles({
    name: "wide.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="1"><rect width="20000" height="1"/></svg>'
    ),
  });
  await expect(page.getByText(/图片导入失败：图片解码后超过/)).toBeVisible();
  await expect(page.locator(".img-preview .ip-name")).toHaveText("shape.png");
  expect(await page.evaluate(() => window.FX.sim.model.id)).toBe("image");
});
test("图片：取消或切换机型后丢弃迟到解码", async ({ page }) => {
  await ready(page);
  const input = await png(page),
    original = await page.evaluate(() => window.FX.sim.model.id);
  await holdImage(page);
  await page.locator("#file-input").setInputFiles(input);
  await page.waitForFunction(() => window.__imageHeld);
  await page.getByRole("button", { name: "取消图片导入", exact: true }).click();
  await page.evaluate(() => window.__releaseImage());
  expect(await page.evaluate(() => window.FX.sim.model.id)).toBe(original);
  await expect(page.locator("[data-image-import]")).toHaveCount(0);
  await holdImage(page);
  await page.locator("#file-input").setInputFiles({ ...input, name: "late.png" });
  await page.waitForFunction(() => window.__imageHeld);
  await page.locator(".model-card").nth(1).click();
  const newer = await page.evaluate(() => window.FX.sim.model.id);
  await page.evaluate(() => window.__releaseImage());
  expect(await page.evaluate(() => window.FX.sim.model.id)).toBe(newer);
  await expect(page.locator(".img-preview")).toHaveCount(0);
});
test("图片：选择内置模型后丢弃迟到解码", async ({ page }) => {
  await ready(page);
  const input = await png(page);
  await holdImage(page);
  await page.locator("#file-input").setInputFiles(input);
  await page.waitForFunction(() => window.__imageHeld);
  await page.locator(".model-card", { hasText: "行星齿轮" }).click();
  await page.evaluate(() => window.__releaseImage());
  expect(await page.evaluate(() => window.FX.sim.model.id)).toBe("gear");
  await expect(page.locator(".img-preview")).toHaveCount(0);
});
test("图片：改选 G-code 后旧解码不会覆盖真实路径", async ({ page }) => {
  await ready(page);
  const input = await png(page);
  await holdImage(page);
  await page.locator("#file-input").setInputFiles(input);
  await page.waitForFunction(() => window.__imageHeld);
  await page.locator("#gcode-input").setInputFiles({
    name: "newer.gcode",
    mimeType: "application/x-gcode",
    buffer: Buffer.from("G90\nM82\nG1 Z0.2 F600\nG1 X10 E1\n"),
  });
  await expect(page.locator("#gcode-summary")).toContainText("newer.gcode");
  const newer = await page.evaluate(() => window.FX.sim.model.id);
  await page.evaluate(() => window.__releaseImage());
  expect(await page.evaluate(() => window.FX.sim.model.id)).toBe(newer);
  await expect(page.locator("#gcode-summary")).toContainText("newer.gcode");
  await expect(page.locator(".img-preview")).toHaveCount(0);
});
