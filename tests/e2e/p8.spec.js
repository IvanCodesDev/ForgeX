/* P8 服务端校准发布：候选提交、审核发布与浏览器只读同步。 */
"use strict";

const { test, expect } = require("@playwright/test");

function candidateBundle() {
  return {
    format: "forgex-calibration-bundle",
    version: 1,
    id: "e2e-server-calibration",
    revision: 1,
    createdAt: "2026-07-28T00:00:00Z",
    provenance: "real-anonymized",
    source: {
      license: "CC0-1.0",
      note: "Anonymized Playwright fixture used only for the server approval workflow.",
    },
    models: [
      {
        id: "e2e-server-fx-pla",
        status: "candidate",
        scope: {
          machineId: "FX-SERVER-E2E",
          firmware: "Klipper 0.12",
          material: "PLA",
        },
        algorithm: "theil-sen",
        trainedAt: "2026-07-28T00:00:00Z",
        coefficients: { motionScale: 1.2, fixedOverheadSec: 30, sampleCount: 10 },
        validation: {
          holdoutSamples: 6,
          mape: 0.07,
          maxApe: 0.13,
          medianBias: 0.01,
          evaluatedAt: "2026-07-28T00:00:00Z",
        },
        thresholds: { maxMape: 0.2, maxBias: 0.12, minDriftSamples: 5 },
        trainingSetSha256: "b".repeat(64),
      },
    ],
  };
}

test("P8 候选模型经 API Key 审核后同步到浏览器", async ({ page, request }) => {
  const submitHeaders = { "X-API-Key": "e2e-calibration-submitter" };
  const reviewHeaders = { "X-API-Key": "e2e-calibration-reviewer" };
  const submitted = await request.post("/api/calibrations/submissions", {
    headers: submitHeaders,
    data: {
      bundle: candidateBundle(),
      note: "E2E submit for approval workflow",
    },
  });
  expect(submitted.status()).toBe(201);

  const reviewed = await request.post(
    "/api/calibrations/e2e-server-calibration/revisions/1/review",
    {
      headers: reviewHeaders,
      data: {
        decision: "approve",
        reason: "Holdout metrics and anonymized source reviewed by E2E.",
      },
    }
  );
  expect(reviewed.status()).toBe(200);

  await page.goto("/");
  await page.waitForFunction(
    () =>
      window.FX &&
      window.FXCalibrationRegistry.list().some((model) => model.id === "e2e-server-fx-pla"),
    null,
    { timeout: 30_000 }
  );
  const synced = await page.evaluate(() => ({
    model: window.FXCalibrationRegistry.list().find((item) => item.id === "e2e-server-fx-pla"),
    sync: window.FXApiClient.calibrationSync,
  }));
  expect(synced.model.status).toBe("active");
  expect(synced.model.bundleRevision).toBe(1);
  expect(synced.sync.status).toBe("ready");
  expect(synced.sync.count).toBeGreaterThanOrEqual(1);
  await expect(page.locator("#ctx-body")).toContainText("服务端已审核目录");
});
