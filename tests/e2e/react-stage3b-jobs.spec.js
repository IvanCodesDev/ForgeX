/* React Stage 3-B：在真实生产构建中验证异步 C# 作业、SSE 与权威摘要切换。 */
"use strict";

const path = require("path");
const { test, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
const GCODE_FIXTURE = path.join(ROOT, "validation", "fixtures", "cura-marlin.gcode");
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

test.describe("React Stage 3-B async authority", () => {
  test.skip(process.env.E2E_GCODE_AUTHORITY !== "dotnet", "dedicated dotnet build is required");

  test("creates one job, consumes SSE, and switches the primary summary", async ({ page }) => {
    let creationCount = 0;
    let sseCount = 0;
    const base = `/api/v1/jobs/${JOB_ID}`;
    const links = { status: base, events: `${base}/events`, cancel: `${base}/cancel` };
    const authority = {
      schemaVersion: "1.0",
      engine: { version: "1.3.0", source: "gcode-import" },
      input: { sha256: SHA256, bytesRead: 350, linesRead: 18 },
      profile: {
        machineProfileId: "corexy",
        materialProfileId: "PLA",
        bedSizeMm: 256,
        coordinateOrigin: "corner",
        filamentDensityGPerCm3: 1.24,
        fingerprint: "f".repeat(64),
      },
      parameters: { bedSizeMm: 256, coordinateOrigin: "corner", filamentDensityGPerCm3: 1.24 },
      summary: {
        totalLayers: 2,
        heightMm: 0.4,
        extrusionLengthMm: 720,
        travelLengthMm: 42.426407,
        estimatedTimeSeconds: 36.424264,
        volumeCm3: 0.014432,
        filamentLengthM: 0.006,
        filamentMassG: 0.017895,
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

    await page.route("**/api/v1/gcode/analyses?*", async (route) => {
      creationCount += 1;
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(request.headers()["idempotency-key"]).toMatch(/^gcode-/);
      expect(request.postDataBuffer()?.byteLength).toBe(350);
      const query = new URL(request.url()).searchParams;
      expect(query.get("machineProfileId")).toBe("corexy");
      expect(query.get("materialProfileId")).toBe("PLA");
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "1.0",
          jobId: JOB_ID,
          status: "queued",
          input: { sha256: SHA256, bytesRead: 350, linesRead: 0 },
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
      await page.waitForTimeout(100);
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
          createdAtUtc: "2026-08-11T00:00:00Z",
          startedAtUtc: "2026-08-11T00:00:01Z",
          finishedAtUtc: "2026-08-11T00:00:02Z",
          input: authority.input,
          engineVersion: authority.engine.version,
          result: authority,
          error: null,
          links,
        }),
      });
    });

    await page.goto("/react/#/gcode");
    await page.locator('input[type="file"][accept*=".gcode"]').setInputFiles(GCODE_FIXTURE);

    await expect(page.getByRole("heading", { name: "C# 权威结果已生效" })).toBeVisible();
    await expect(page.getByText("摘要口径：C# 权威结果", { exact: true })).toBeVisible();
    await expect(page.getByText(SHA256, { exact: true })).toBeVisible();
    await expect(page.getByText("C# 引擎权威口径", { exact: true })).toBeVisible();
    await expect(page.getByText("corexy / PLA", { exact: true })).toBeVisible();
    await expect(page.getByText("2 layers match", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /C# 有界工具路径 · 第 1 \/ 2 层/ })).toBeVisible();
    await expect(page.getByText(/8 \/ 8 segments · C# complete/)).toBeVisible();
    expect(creationCount).toBe(1);
    expect(sseCount).toBe(1);
  });
});
