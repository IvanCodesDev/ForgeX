/* 上传 → 公共分析/SSE → 分享/撤销 → 重启后读取；仅启动一个 ForgeX.Api。 */
"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { startSingleProcess } = require("./lib/single-process");

function cleanup(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("forgex-single-process-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-single-process-"));
  const checks = [];
  let api;
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  const key = "single-process-" + crypto.randomBytes(12).toString("hex");
  const options = { port, storageRoot: directory, postgresUrl: process.env.POSTGRES_URL, apiKeys: key };
  const call = async (pathname, body) => {
    const response = await fetch(api.baseUrl + pathname, {
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, text: await response.text() };
  };
  const check = (name, condition) => {
    assert.ok(condition, name);
    checks.push(name);
    console.log("  PASS " + name);
  };
  try {
    api = await startSingleProcess(options);
    const health = await call("/healthz");
    check(
      "C# public health and PostgreSQL",
      health.status === 200 && JSON.parse(health.text).persistence === "postgres"
    );
    for (const pathname of ["/", "/react/", "/legacy", "/react/assets/style.css"]) {
      const result = await call(pathname);
      check("static " + pathname, result.status === 200);
    }
    check("private files denied", (await call("/server/index.js")).status === 404);
    const dataset = await call("/api/datasource", {
      csv: "machine,material,status\nM1,PLA,success\nM2,ABS,fail\n",
      name: "single-process.csv",
    });
    check("upload datasource", dataset.status === 201);
    const datasourceId = JSON.parse(dataset.text).datasourceId;
    const created = await call("/api/analyze", { question: "哪台机故障率最高", datasourceId });
    check("create public analysis", created.status === 202);
    const taskId = JSON.parse(created.text).taskId;
    const stream = await call(`/api/analyze/${taskId}/stream`);
    check(
      "public SSE terminal event",
      stream.status === 200 && /"done":\s*true/.test(stream.text) && !/^event:/m.test(stream.text)
    );
    const result = await call(`/api/analyze/${taskId}/result`);
    check("analysis result", result.status === 200 && JSON.parse(result.text).engine === "server-rules");
    const shared = await call(`/api/share/${taskId}`, {});
    check("create share", shared.status === 201);
    const share = JSON.parse(shared.text);
    const sharePath = new URL(share.publicUrl).pathname;
    check("public share readable", (await call(sharePath)).status === 200);
    check("metrics available", (await call("/metrics")).text.includes("forgex_tasks_total"));
    const gcode = await fetch(api.baseUrl + "/api/v1/gcode/analyses", {
      method: "POST",
      headers: { "Content-Type": "application/x-gcode", "X-API-Key": key },
      body: "G90\nM82\nG92 E0\nG1 Z0.2 F600\nG1 X10 Y10 F3000\nG1 X30 Y10 E1 F1200\nG1 X30 Y30 E2\nG1 Z0.4\nG1 X10 Y30 E3\n",
      signal: AbortSignal.timeout(15000),
    });
    check("G-code accepted by same process", gcode.status === 202);
    const jobId = (await gcode.json()).jobId;
    let job;
    const deadline = Date.now() + 30000;
    do {
      job = JSON.parse((await call(`/api/v1/jobs/${jobId}`)).text);
      if (["succeeded", "failed", "cancelled", "degraded"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    check("G-code result", job.status === "succeeded" && job.result != null);
    await api.stop();
    api = await startSingleProcess(options);
    check("analysis survives restart", (await call(`/api/analyze/${taskId}/result`)).text === result.text);
    check("share survives restart", (await call(sharePath)).status === 200);
    check("G-code survives restart", JSON.parse((await call(`/api/v1/jobs/${jobId}`)).text).status === "succeeded");
    const revoked = await call(`/api/share/${share.token}/revoke`, { revokeKey: share.revokeKey });
    check("revoke share", revoked.status === 200);
    await api.stop();
    api = await startSingleProcess(options);
    check("revocation survives restart", (await call(sharePath)).status === 404);
    const artifact = path.resolve(__dirname, "../backend/artifacts/single-process-deployment.json");
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(
      artifact,
      JSON.stringify({ schemaVersion: 1, status: "pass", process: "ForgeX.Api", checks }, null, 2) + "\n"
    );
    console.log(`Single-process deployment PASS ${checks.length}/${checks.length}`);
  } finally {
    if (api) await api.stop();
    cleanup(directory);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
