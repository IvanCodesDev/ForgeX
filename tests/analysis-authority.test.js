/* Stage 8.3：分析任务规则腿权威切流（ANALYSIS_AUTHORITY=node|csharp）。
   csharp 模式下 Node 保留身份/限流/数据源归属校验，把归一化行转发给
   POST /api/v1/analysis-tasks；收编 C# 终态快照后，既有 result / 轮询 /
   SSE 重放路由必须原样服务。node 模式（默认）与授权失败路径同样覆盖。 */
"use strict";

const assert = require("assert");
const http = require("http");
const { createApp } = require("../server/index");

const INTERNAL_SECRET = "analysis-authority-internal-secret-0123456789";

const apps = [];

function listenServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function listenApp(overrides) {
  const app = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    probeProvider: false,
    dataDir: "",
    ...overrides,
  });
  apps.push(app);
  return `http://127.0.0.1:${await listenServer(app.server)}`;
}

async function jfetch(base, path, opts) {
  const response = await fetch(base + path, opts);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应保留原文供断言
  }
  return { status: response.status, json, text };
}

function post(base, path, body) {
  return jfetch(base, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function collectSse(base, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(base + path, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error("SSE HTTP " + res.statusCode));
        return;
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              events.push(ev);
              if (ev.done) {
                req.destroy();
                resolve(events);
                return;
              }
            } catch {
              // 心跳注释行
            }
          }
        }
      });
      res.on("end", () => resolve(events));
    });
    req.on("error", reject);
    setTimeout(() => {
      req.destroy();
      reject(new Error("SSE timeout"));
    }, timeoutMs).unref();
  });
}

/* 模拟 ForgeX.Api：按 Stage 8.3 契约返回终态快照 + 全量事件。 */
function authoritySnapshot(request) {
  const id = "t_0123456789abcdef";
  const now = Date.now();
  const events = [
    { seq: 1, ts: now, stage: "authority", message: "C# Analytics 权威规则引擎计算中", progress: 0.25 },
    { seq: 2, ts: now, stage: "complete", message: "C# Analytics 权威结果已生成", progress: 1 },
    { seq: 3, ts: now, done: true, progress: 1, message: "分析完成" },
  ];
  const report = {
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
    engine: "server-rules",
    provenance: null,
    highlight: null,
    authorityEngine: { name: "forgex-analytics-csharp", version: "1.3.0" },
    statsBy: "csharp-analytics-authority",
    taskId: id,
    cached: false,
  };
  return {
    task: {
      id,
      question: request.question,
      datasourceId: request.datasourceId,
      engine: "server-rules",
      provider: "server-rules",
      status: "done",
      progress: 1,
      phase: "done",
      message: "分析完成",
      lastEventSeq: 3,
      report,
      createdAtUtc: new Date(now - 5).toISOString(),
      finishedAtUtc: new Date(now).toISOString(),
      expiresAtUtc: new Date(now + 3_600_000).toISOString(),
      links: { self: `/api/v1/analysis-tasks/${id}`, events: `/api/v1/analysis-tasks/${id}/events` },
    },
    events,
  };
}

async function main() {
  const observed = [];
  const authority = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      observed.push({ url: req.url, headers: req.headers, body });
      if (req.url !== "/api/v1/analysis-tasks") {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(authoritySnapshot(JSON.parse(body))));
    });
  });
  const authorityOrigin = `http://127.0.0.1:${await listenServer(authority)}`;

  try {
    // ── csharp 模式：规则腿创建与计算走 C#，Node 收编终态快照 ──
    const base = await listenApp({
      analysisAuthority: "csharp",
      gcodeAuthorityUrl: authorityOrigin,
      gcodeAuthorityInternalSecret: INTERNAL_SECRET,
    });
    const created = await post(base, "/api/analyze", { question: "哪台机故障率最高", datasourceId: "sample" });
    assert.strictEqual(created.status, 202);
    assert.strictEqual(created.json.taskId, "t_0123456789abcdef");
    assert.strictEqual(created.json.engine, "server-rules");
    assert.strictEqual(created.json.willUseAi, false);
    assert.strictEqual(created.json.quota, null);

    assert.strictEqual(observed.length, 1);
    const upstream = JSON.parse(observed[0].body);
    assert.strictEqual(upstream.schemaVersion, "1.0");
    assert.strictEqual(upstream.question, "哪台机故障率最高");
    assert.strictEqual(upstream.datasourceId, "sample");
    assert.ok(Array.isArray(upstream.rows) && upstream.rows.length > 0);
    assert.ok(["success", "fail"].includes(upstream.rows[0].status), "rows must use the analytics authority row contract");
    assert.strictEqual(upstream.provenance, null);
    assert.strictEqual(observed[0].headers["x-forgex-internal-token"], INTERNAL_SECRET);
    assert.match(observed[0].headers["x-forgex-tenant-id"], /^tn_[a-f0-9]{32}$/);
    assert.match(observed[0].headers["x-forgex-owner-id"], /^ow_[a-f0-9]{32}$/);
    assert.ok(!observed[0].headers.cookie && !observed[0].headers.authorization && !observed[0].headers["x-api-key"]);

    // 既有读取路由必须原样服务 C# 计算的任务
    const result = await jfetch(base, "/api/analyze/" + created.json.taskId + "/result");
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.json.statsBy, "csharp-analytics-authority");
    assert.strictEqual(result.json.taskId, created.json.taskId);
    const poll = await jfetch(base, "/api/analyze/" + created.json.taskId);
    assert.strictEqual(poll.status, 200);
    assert.strictEqual(poll.json.status, "done");
    assert.strictEqual(poll.json.progress, 1);
    const replay = await collectSse(base, "/api/analyze/" + created.json.taskId + "/stream", 3000);
    assert.strictEqual(replay.length, 3);
    assert.strictEqual(replay[0].stage, "authority");
    assert.strictEqual(replay.at(-1).done, true);

    // ── node 模式（默认回滚开关）：不触碰 sidecar，本地规则引擎照常执行 ──
    const before = observed.length;
    const nodeBase = await listenApp({ gcodeAuthorityUrl: authorityOrigin });
    const local = await post(nodeBase, "/api/analyze", { question: "成本趋势", datasourceId: "sample" });
    assert.strictEqual(local.status, 202);
    await collectSse(nodeBase, "/api/analyze/" + local.json.taskId + "/stream", 5000);
    const localResult = await jfetch(nodeBase, "/api/analyze/" + local.json.taskId + "/result");
    assert.strictEqual(localResult.status, 200);
    assert.strictEqual(observed.length, before, "node authority must not call the sidecar");

    // ── csharp 模式下 sidecar 不可用 → 502，不产生半个任务 ──
    const downBase = await listenApp({
      analysisAuthority: "csharp",
      gcodeAuthorityUrl: "http://127.0.0.1:9",
    });
    const down = await post(downBase, "/api/analyze", { question: "失败归因", datasourceId: "sample" });
    assert.strictEqual(down.status, 502);

    // ── 配置守卫：csharp 依赖 sidecar origin ──
    assert.throws(
      () => createApp({ analysisAuthority: "csharp", logLevel: "error", dataDir: "" }),
      /ANALYSIS_AUTHORITY=csharp/
    );

    console.log("Analysis authority proxy PASS: 28/28");
  } finally {
    for (const app of apps.reverse()) await app.close();
    await new Promise((resolve) => authority.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
