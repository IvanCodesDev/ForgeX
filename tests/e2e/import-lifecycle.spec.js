"use strict";
const { test, expect } = require("@playwright/test");
const gcode = {
  name: "lifecycle.gcode",
  mimeType: "application/x-gcode",
  buffer: Buffer.from("G90\nM82\nG1 X0 Y0 Z0.2 F600\nG1 X10 Y0 E1 F600\n"),
};
const vertices = [
  [0, 0, 0],
  [10, 0, 0],
  [0, 10, 0],
  [0, 0, 10],
];
const mesh = {
  name: "lifecycle.stl",
  mimeType: "model/stl",
  buffer: Buffer.from(
    "solid t\n" +
      [
        [0, 2, 1],
        [0, 1, 3],
        [1, 2, 3],
        [2, 0, 3],
      ]
        .map(
          (face) =>
            "facet normal 0 0 0\nouter loop\n" +
            face.map((i) => "vertex " + vertices[i].join(" ") + "\n").join("") +
            "endloop\nendfacet\n"
        )
        .join("") +
      "endsolid t\n"
  ),
};
async function prepare(page, kind, fallback = false) {
  await page.goto("/react");
  await page.waitForFunction(() => window.FX?.sim?.slice);
  await page.locator("#flow-pills .flow-pill").first().click();
  await page.evaluate(
    ({ kind, fallback }) => {
      const Original = window.Worker;
      window.__importProbe = { held: false, terminated: false, released: false };
      window.Worker = new Proxy(Original, {
        construct(Target, args) {
          if (args[1]?.name !== `forgex-${kind}`) return Reflect.construct(Target, args);
          if (fallback) throw new Error("test: worker startup unavailable");
          window.Worker = Original;
          const worker = Reflect.construct(Target, args),
            descriptor = Object.getOwnPropertyDescriptor(Original.prototype, "onmessage");
          const terminate = worker.terminate.bind(worker);
          worker.terminate = () => {
            window.__importProbe.terminated = true;
            terminate();
          };
          Object.defineProperty(worker, "onmessage", {
            set(handler) {
              descriptor.set.call(worker, (event) => {
                if (event.data.type === "result") {
                  window.__importProbe.held = true;
                  window.__releaseImportWorker = () => {
                    handler.call(worker, event);
                    window.__importProbe.released = true;
                  };
                } else handler.call(worker, event);
              });
            },
          });
          return worker;
        },
      });
    },
    { kind, fallback }
  );
}
for (const kind of ["gcode", "mesh"]) {
  test(`${kind}：取消后台导入后丢弃已排队结果`, async ({ page }) => {
    await prepare(page, kind);
    const model = await page.evaluate(() => window.FX.sim.model.id);
    await page.locator(`#${kind}-input`).setInputFiles(kind === "gcode" ? gcode : mesh);
    await page.waitForFunction(() => window.__importProbe.held);
    await page
      .getByRole("button", { name: kind === "gcode" ? "取消 G-code 导入" : "取消网格导入", exact: true })
      .click();
    await page.evaluate(() => window.__releaseImportWorker());
    await expect(page.locator(`[data-${kind}-import]`)).toHaveCount(0);
    expect(await page.evaluate(() => window.__importProbe)).toMatchObject({ terminated: true, released: true });
    expect(await page.evaluate(() => window.FX.sim.model.id)).toBe(model);
    await expect(page.locator(kind === "gcode" ? "#gcode-summary" : "#mesh-summary")).toHaveCount(0);
  });
  test(`${kind}：随后导入另一类文件，旧结果不得覆盖新模型`, async ({ page }) => {
    await prepare(page, kind);
    await page.locator(`#${kind}-input`).setInputFiles(kind === "gcode" ? gcode : mesh);
    await page.waitForFunction(() => window.__importProbe.held);
    const newer = kind === "gcode" ? "mesh" : "gcode";
    await page.locator(`#${newer}-input`).setInputFiles(newer === "gcode" ? gcode : mesh);
    await expect(page.locator(newer === "gcode" ? "#gcode-summary" : "#mesh-summary")).toContainText(
      newer === "gcode" ? gcode.name : mesh.name
    );
    const model = await page.evaluate(() => window.FX.sim.model.id);
    await page.evaluate(() => window.__releaseImportWorker());
    await expect(page.locator(kind === "gcode" ? "#gcode-summary" : "#mesh-summary")).toHaveCount(0);
    expect(await page.evaluate(() => window.FX.sim.model.id)).toBe(model);
    expect(await page.evaluate(() => window.__importProbe.terminated)).toBe(true);
  });
  test(`${kind}：Worker 无法启动时保留主线程兼容导入`, async ({ page }) => {
    await prepare(page, kind, true);
    await page.locator(`#${kind}-input`).setInputFiles(kind === "gcode" ? gcode : mesh);
    await expect(page.locator(kind === "gcode" ? "#gcode-summary" : "#mesh-summary")).toContainText(
      kind === "gcode" ? gcode.name : mesh.name
    );
    expect(
      await page.evaluate(
        (kind) => (kind === "gcode" ? window.__forgexGcodeImportVia : window.__forgexMeshImportVia),
        kind
      )
    ).toBe("main");
  });
}
