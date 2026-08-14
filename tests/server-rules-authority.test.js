const assert = require("assert");
const http = require("http");
const { createApp } = require("../server/index");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function main() {
  let reports = 0;
  const authority = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/health/live") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end('{"status":"healthy"}');
      }
      assert.strictEqual(req.url, "/api/v1/analytics/reports");
      reports++;
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.strictEqual(request.schemaVersion, "1.0");
      assert.ok(Array.isArray(request.rows) && request.rows.length > 0);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        schemaVersion: "1.0",
        engine: { name: "forgex-analytics-csharp", version: "1.3.0" },
        report: {
          schemaVersion: 1,
          title: "authority",
          verdict: "authority",
          confidence: "high",
          sections: [],
          chart: null,
          evidence: [],
          intent: "overview",
          intentMatched: false,
          rowCount: request.rows.length,
          engine: "local-rules",
          provenance: null,
          highlight: null,
        },
      }));
    });
  });
  const port = await listen(authority);
  const app = createApp({
    forceMock: false,
    providerPref: "local",
    gcodeAuthorityUrl: `http://127.0.0.1:${port}`,
    analyticsAuthorityEnabled: true,
    probeProvider: true,
    rateLimitMs: 0,
    logLevel: "error",
    dataDir: "",
  });
  try {
    const probe = await app.ctx.tasks.probeProvider();
    assert.strictEqual(probe.ok, true);
    assert.strictEqual(app.ctx.tasks.provider.id, "server-rules");
    const task = app.ctx.tasks.create("概览", app.ctx.datasources.get("sample"), "test", { caller: "test" });
    for (let i = 0; i < 100 && task.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(task.status, "done");
    assert.strictEqual(task.report.engine, "server-rules");
    assert.strictEqual(task.report.statsBy, "csharp-analytics-authority");
    assert.strictEqual(reports, 1);
    console.log("Server rules authority PASS: 8/8");
  } finally {
    await app.close();
    await new Promise((resolve) => authority.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
