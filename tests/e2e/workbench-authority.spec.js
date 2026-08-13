/* React 工作台 × C# 权威 G-code 分析接线。

   dotnet 构建下导入 G-code 应创建一个异步作业、消费 SSE 进度，
   并在完整契约校验通过后于模型页原子呈现「C# 权威摘要」。
   上游由本用例以完整 1.4 契约 mock：断言覆盖创建参数、幂等键、
   请求体字节数与最终摘要文案。browser 构建（默认 CI 路径）自动跳过。 */
"use strict";

const path = require("path");
const { test, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
const GCODE_FIXTURE = path.join(ROOT, "validation", "fixtures", "cura-marlin.gcode");
const FIXTURE_BYTES = 350;
const JOB_ID = "3".repeat(32);
const SHA256 = "0881cfdac2ef41f6df48f7f5e0f47fd632dcddec8238955ce3a59a6bd754cf07";

function packedToolpathBase64() {
  const records = [
    [-108, -108, -8, -108, 0],
    [-8, -108, -8, -8, 0],
    [-8, -8, -108, -8, 0],
    [-108, -8, -108, -108, 0],
    [-98, -98, -18, -98, 2],
    [-18, -98, -18, -18, 2],
    [-18, -18, -98, -18, 2],
    [-98, -18, -98, -98, 2],
  ];
  const payload = Buffer.alloc(records.length * 20);
  records.forEach((record, index) => {
    const offset = index * 20;
    payload.writeFloatLE(record[0], offset);
    payload.writeFloatLE(record[1], offset + 4);
    payload.writeFloatLE(record[2], offset + 8);
    payload.writeFloatLE(record[3], offset + 12);
    payload.writeInt32LE(record[4], offset + 16);
  });
  return payload.toString("base64");
}

/* 新工作台不传 Profile 扩展：机型/材料落到 unspecified-*，材料限值取契约默认。 */
const EFFECTIVE = {
  machineProfileId: "unspecified-machine",
  materialProfileId: "unspecified-material",
  bedSizeMm: 256,
  coordinateOrigin: "corner",
  filamentDensityGPerCm3: 1.24,
  materialPriceCnyPerKg: 0,
  nozzleTemperatureMinC: 0,
  nozzleTemperatureMaxC: 500,
  bedTemperatureMinC: 0,
  materialMaxSpeedMmPerSecond: 1000,
  materialMaxFlowMm3PerSecond: 100,
};

function authorityResult() {
  const filamentMassG = 0.017895;
  return {
    schemaVersion: "1.0",
    engine: { version: "1.4.0", source: "gcode-import" },
    input: { sha256: SHA256, bytesRead: FIXTURE_BYTES, linesRead: 18 },
    profile: { ...EFFECTIVE, fingerprint: "f".repeat(64) },
    parameters: { ...EFFECTIVE },
    summary: {
      totalLayers: 2,
      heightMm: 0.4,
      extrusionLengthMm: 720,
      travelLengthMm: 42.426407,
      estimatedTimeSeconds: 36.424264,
      volumeCm3: 0.014432,
      filamentLengthM: 0.006,
      filamentMassG,
    },
    material: {
      materialProfileId: EFFECTIVE.materialProfileId,
      filamentDiameterMm: 1.75,
      densityGPerCm3: EFFECTIVE.filamentDensityGPerCm3,
      volumeCm3: 0.014432,
      filamentLengthM: 0.006,
      filamentMassG,
      priceCnyPerKg: 0,
      materialCostCny: 0,
    },
    risk: {
      level: "low",
      score: 6,
      nozzleTemperatureC: 210,
      bedTemperatureC: 60,
      maxExtrusionSpeedMmPerSecond: 48,
      maxVolumetricFlowMm3PerSecond: 7.2,
      findings: [
        {
          code: "gcode_speed_within_material_limit",
          severity: "low",
          message: "最高挤出速度在材料上限内",
          observed: 48,
          minimum: null,
          maximum: 1000,
          unit: "mm/s",
        },
      ],
    },
    bounds: { minX: -108, maxX: -8, minY: -108, maxY: -8 },
    layers: [
      {
        index: 0,
        zMm: 0.2,
        pathCount: 1,
        extrusionLengthMm: 400,
        travelLengthMm: 14.142135623730951,
        timeSeconds: 20.14142135623731,
        filamentLengthMm: 4,
        pathTypeCounts: { perimeter: 1 },
      },
      {
        index: 1,
        zMm: 0.4,
        pathCount: 1,
        extrusionLengthMm: 320,
        travelLengthMm: 0,
        timeSeconds: 16,
        filamentLengthMm: 2,
        pathTypeCounts: { infill: 1 },
      },
    ],
    visualization: {
      encoding: "forgex-toolpath-f32le-v1",
      recordStrideBytes: 20,
      sourceSegmentCount: 8,
      segmentCount: 8,
      truncated: false,
      samplingStride: 1,
      pathTypes: ["perimeter", "solid", "infill", "support", "skirt"],
      layers: [
        { index: 0, sourceSegmentCount: 4, segmentOffset: 0, segmentCount: 4 },
        { index: 1, sourceSegmentCount: 4, segmentOffset: 4, segmentCount: 4 },
      ],
      dataBase64: packedToolpathBase64(),
    },
    claims: {},
    pathTypeCounts: { perimeter: 1, infill: 1 },
    warnings: [],
  };
}

test.describe("Workbench C# authority wiring", () => {
  test.skip(process.env.E2E_GCODE_AUTHORITY !== "dotnet", "dedicated dotnet build is required");

  test("导入 G-code 创建异步作业并呈现权威摘要", async ({ page }) => {
    let creationCount = 0;
    let sseCount = 0;
    const base = `/api/v1/jobs/${JOB_ID}`;
    const links = { status: base, events: `${base}/events`, cancel: `${base}/cancel` };
    const result = authorityResult();

    await page.route("**/api/v1/gcode/analyses?*", async (route) => {
      creationCount += 1;
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(request.headers()["idempotency-key"]).toMatch(/^gcode-/);
      expect(request.postDataBuffer()?.byteLength).toBe(FIXTURE_BYTES);
      const query = new URL(request.url()).searchParams;
      expect(query.get("machineProfileId")).toBe(EFFECTIVE.machineProfileId);
      expect(query.get("materialProfileId")).toBe(EFFECTIVE.materialProfileId);
      expect(query.get("bedSizeMm")).toBe("256");
      expect(query.get("coordinateOrigin")).toBe("corner");
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "1.0",
          jobId: JOB_ID,
          status: "queued",
          input: { sha256: SHA256, bytesRead: FIXTURE_BYTES, linesRead: 0 },
          links,
        }),
      });
    });
    await page.route(`**${base}/events`, async (route) => {
      sseCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          'id: 1\nevent: progress\ndata: {"status":"running","progress":0.6,"phase":"parse"}\n\n' +
          'id: 2\nevent: terminal\ndata: {"status":"succeeded","progress":1,"phase":"completed"}\n\n',
      });
    });
    await page.route(`**${base}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "1.0",
          id: JOB_ID,
          kind: "gcode-analysis",
          status: "succeeded",
          progress: 1,
          phase: "completed",
          sequence: 2,
          createdAtUtc: "2026-08-12T00:00:00Z",
          startedAtUtc: "2026-08-12T00:00:01Z",
          finishedAtUtc: "2026-08-12T00:00:02Z",
          input: result.input,
          engineVersion: result.engine.version,
          result,
          error: null,
          links,
        }),
      });
    });

    await page.goto("/react");
    await page.waitForFunction(() => window.FX && window.FX.sim && window.FX.sim.slice, null, { timeout: 30_000 });

    // 打开模型页并导入夹具
    await page.locator("#flow-pills .flow-pill").first().click();
    await page.locator("#gcode-input").setInputFiles(GCODE_FIXTURE);

    // 浏览器解析摘要与 C# 权威摘要并存
    await expect(page.locator("#gcode-summary")).toBeVisible();
    await expect(page.locator("#authority-summary")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#authority-summary")).toContainText("C# 1.4.0 · gcode-import");
    await expect(page.locator("#authority-summary")).toContainText("2 层 · 0.01 m");
    await expect(page.locator("#authority-summary")).toContainText("low · 6/100 · 1 项发现");
    await expect(page.locator("#authority-summary")).toContainText("未配置材料单价");

    expect(creationCount).toBe(1);
    expect(sseCount).toBe(1);
  });
});
