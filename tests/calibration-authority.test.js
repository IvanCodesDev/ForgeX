const assert = require("assert");
const http = require("http");
const { createApp } = require("../server/index");
const { CALIBRATION_AUTHORITY_HARD_MAX_BYTES } = require("../server/config");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function main() {
  const observed = [];
  const authority = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observed.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          schemaVersion: "1.0",
          engine: { name: "forgex-calibration-csharp", version: "1.0.0" },
          training: {
            format: "forgex-time-calibration",
            version: 1,
            method: "theil-sen",
            scope: { machineId: "FX-TEST", firmware: "Marlin" },
            coefficients: { motionScale: 1.25, fixedOverheadSec: 90, sampleCount: 3 },
            trainingMetrics: { sampleCount: 3, maeSec: 0, mape: 0, rmseSec: 0, maxApe: 0, r2: 1 },
            crossValidation: null,
            holdoutMetrics: null,
            drift: null,
          },
        })
      );
    });
  });
  const authorityPort = await listen(authority);
  const app = createApp({
    forceMock: true,
    rateLimitMs: 0,
    logLevel: "error",
    dataDir: "",
    gcodeAuthorityUrl: `http://127.0.0.1:${authorityPort}`,
  });
  const nodePort = await listen(app.server);
  try {
    const body = JSON.stringify({
      schemaVersion: "1.0",
      scope: { machine_id: "FX-TEST", firmware: "Marlin" },
      samples: [
        { planned_time_sec: 100, actual_time_sec: 215 },
        { planned_time_sec: 200, actual_time_sec: 340 },
        { planned_time_sec: 400, actual_time_sec: 590 },
      ],
    });
    const response = await fetch(`http://127.0.0.1:${nodePort}/api/v1/calibration/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer should-not-forward" },
      body,
    });
    assert.strictEqual(response.status, 200);
    const result = await response.json();
    assert.strictEqual(result.engine.name, "forgex-calibration-csharp");
    assert.strictEqual(observed.length, 1);
    assert.strictEqual(observed[0].url, "/api/v1/calibration/train");
    assert.ok(!observed[0].headers.authorization);
    assert.ok(observed[0].body.equals(Buffer.from(body)));
    assert.strictEqual(app.cfg.calibrationAuthorityMaxBytes, CALIBRATION_AUTHORITY_HARD_MAX_BYTES);
    console.log("Calibration authority proxy PASS: 6/6");
  } finally {
    await app.close();
    await new Promise((resolve) => authority.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
