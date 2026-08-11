"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server/index.js");

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log("  ✓ " + name);
  } else {
    failed++;
    console.error("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const observed = [];
  const jobId = "0123456789abcdef0123456789abcdef";
  const internalSecret = "stage3d-internal-secret-32-bytes-minimum";
  const authority = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observed.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url.endsWith("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
        res.end('id: 2\nevent: terminal\ndata: {"status":"succeeded"}\n\n');
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/api/v1/gcode/analyses")) {
        res.writeHead(202, { "content-type": "application/json", location: `/api/v1/jobs/${jobId}` });
        res.end(JSON.stringify({ jobId, status: "queued" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: jobId, status: req.url.endsWith("/cancel") ? "cancelled" : "succeeded" }));
    });
  });
  const authorityPort = await listen(authority);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-jobs-"));
  const app = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir,
    requireAuth: true,
    apiKeys: "node-key,other-key",
    gcodeAuthorityUrl: `http://127.0.0.1:${authorityPort}`,
    gcodeAsyncJobsEnabled: true,
    gcodeAuthorityInternalSecret: internalSecret,
  });
  const port = await listen(app.server);
  const base = `http://127.0.0.1:${port}`;
  const auth = { "X-API-Key": "node-key", Authorization: "Bearer node-key", Cookie: "secret=1" };

  const created = await fetch(base + "/api/v1/gcode/analyses?bedSizeMm=220", {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/x-gcode",
      "Idempotency-Key": "stage3a-1",
      "X-ForgeX-Internal-Token": "browser-forged-token",
      "X-ForgeX-Tenant-Id": "tn_ffffffffffffffffffffffffffffffff",
      "X-ForgeX-Owner-Id": "ow_ffffffffffffffffffffffffffffffff",
    },
    body: "G28\nG1 X1 Y1 E1\n",
  });
  check("异步创建经同源代理返回 202", created.status === 202, String(created.status));
  check("Location 由 sidecar 透传", created.headers.get("location") === `/api/v1/jobs/${jobId}`);
  const createSeen = observed[0];
  check("创建请求保留 query 与原始字节", createSeen.url.endsWith("?bedSizeMm=220") && createSeen.body.includes("G28"));
  check("Idempotency-Key 透传", createSeen.headers["idempotency-key"] === "stage3a-1");
  check("Node 使用内部密钥建立 sidecar 信任", createSeen.headers["x-forgex-internal-token"] === internalSecret);
  check(
    "Node 注入匿名化 tenant/owner 上下文",
    /^tn_[a-f0-9]{32}$/.test(createSeen.headers["x-forgex-tenant-id"] || "") &&
      /^ow_[a-f0-9]{32}$/.test(createSeen.headers["x-forgex-owner-id"] || "")
  );
  check(
    "浏览器伪造的内部上下文被覆盖",
    createSeen.headers["x-forgex-internal-token"] !== "browser-forged-token" &&
      createSeen.headers["x-forgex-tenant-id"] !== "tn_ffffffffffffffffffffffffffffffff" &&
      createSeen.headers["x-forgex-owner-id"] !== "ow_ffffffffffffffffffffffffffffffff"
  );
  check(
    "浏览器凭据不泄露给 sidecar",
    !createSeen.headers.cookie && !createSeen.headers.authorization && !createSeen.headers["x-api-key"]
  );

  const status = await fetch(base + `/api/v1/jobs/${jobId}`, { headers: auth });
  check("作业快照固定路径可读取", status.status === 200 && (await status.json()).status === "succeeded");
  const sameCallerSeen = observed.find((item) => item.method === "GET" && item.url === `/api/v1/jobs/${jobId}`);
  check(
    "同一调用方的 tenant/owner 在创建与读取间稳定",
    sameCallerSeen.headers["x-forgex-tenant-id"] === createSeen.headers["x-forgex-tenant-id"] &&
      sameCallerSeen.headers["x-forgex-owner-id"] === createSeen.headers["x-forgex-owner-id"]
  );
  const otherCaller = await fetch(base + `/api/v1/jobs/${jobId}`, { headers: { "X-API-Key": "other-key" } });
  await otherCaller.text();
  const otherCallerSeen = observed.filter((item) => item.method === "GET" && item.url === `/api/v1/jobs/${jobId}`).at(-1);
  check(
    "不同调用方获得不同的匿名化 owner/tenant",
    otherCallerSeen.headers["x-forgex-tenant-id"] !== createSeen.headers["x-forgex-tenant-id"] &&
      otherCallerSeen.headers["x-forgex-owner-id"] !== createSeen.headers["x-forgex-owner-id"]
  );
  const events = await fetch(base + `/api/v1/jobs/${jobId}/events`, {
    headers: { ...auth, "Last-Event-ID": "1" },
  });
  check("SSE 类型与事件帧透传", events.headers.get("content-type").startsWith("text/event-stream") && (await events.text()).includes("id: 2"));
  check("Last-Event-ID 透传", observed.find((item) => item.url.endsWith("/events")).headers["last-event-id"] === "1");
  const cancelled = await fetch(base + `/api/v1/jobs/${jobId}/cancel`, { method: "POST", headers: auth });
  check("取消路由返回稳定终态", cancelled.status === 200 && (await cancelled.json()).status === "cancelled");

  const anonymous = await fetch(base + `/api/v1/jobs/${jobId}`);
  check("REQUIRE_AUTH 下匿名作业读取被拒绝", anonymous.status === 401, String(anonymous.status));
  await app.close();

  const disabled = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "forgex-jobs-off-")),
    gcodeAuthorityUrl: `http://127.0.0.1:${authorityPort}`,
    gcodeAsyncJobsEnabled: false,
  });
  const disabledPort = await listen(disabled.server);
  const off = await fetch(`http://127.0.0.1:${disabledPort}/api/v1/gcode/analyses`, {
    method: "POST",
    headers: { "Content-Type": "application/x-gcode" },
    body: "G28\n",
  });
  check("独立回滚开关仅关闭异步创建", off.status === 503 && (await off.json()).code === "async_jobs_disabled");
  await disabled.close();

  const hanging = http.createServer(() => {});
  const hangingPort = await listen(hanging);
  const timeoutApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "forgex-jobs-timeout-")),
    gcodeAuthorityUrl: `http://127.0.0.1:${hangingPort}`,
    gcodeAuthorityTimeoutMs: 30,
  });
  const timeoutPort = await listen(timeoutApp.server);
  const timedOut = await fetch(`http://127.0.0.1:${timeoutPort}/api/v1/jobs/${jobId}`);
  check("非 SSE 作业代理超时返回结构化 504", timedOut.status === 504 && (await timedOut.json()).code === "authority_timeout");
  await timeoutApp.close();
  await close(hanging);
  await close(authority);
  let shortSecretRejected = false;
  try {
    createApp({ gcodeAuthorityInternalSecret: "too-short" });
  } catch (error) {
    shortSecretRejected = /至少需要 32/.test(error.message);
  }
  check("过短的 Node→C# 内部密钥在启动时拒绝", shortSecretRejected);
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
