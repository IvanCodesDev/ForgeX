/* Stage 8.6c-1：分析任务只读切流（ANALYSIS_TASKS_AUTHORITY）的 C# 权威集成测试，口径对齐 shares-authority.test.js。
 *
 * 用 node:http 起一个假 ForgeX.Api sidecar 记录收到的请求，验证：
 *   [1] 配置校验：开关取值、csharp 依赖 GCODE_AUTHORITY_URL / 内部密钥 / PERSISTENCE_PROVIDER=postgres；
 *   [2] 默认 node 模式：创建 / 结果 / 轮询 / SSE 全部本地完成，sidecar 一次都不被调用（回滚开关有效）；
 *   [3] csharp 模式：
 *       - 结果与轮询经可信通道读 GET /api/v1/analysis-tasks/{id}（tenant/owner 匿名化哈希、不泄漏 cookie / authorization），
 *         key 身份与匿名 ip 身份的头派生都与 §7.3 一致；
 *       - 快照 → Node 形状映射：done → 200 报告原样；running → 202；failed → 502 + errorMessage（缺省「分析失败」）；
 *         C# 404 → 404「任务不存在或已过期」；C# 5xx → 502「分析任务服务暂不可用，请稍后再试」；
 *       - 轮询形状 { taskId, status, engine, progress, message, error? }；
 *       - 8.6c-2a：/stream 消费 C# /events 命名帧并重新组成无名 data: 帧——progress/message 帧原样转发、心跳转发、
 *         C# done 快照帧不转发（事件里已有终态）或合成 Node 形状终态（重启恢复的 failed 任务）、Last-Event-ID 透传、
 *         C# 404 / 5xx 在发头前映射为 404 / 502；
 *       - POST 创建仍在 Node 本地（随 8.6c-2b 迁移）；
 *   [4] 超时（复用 RESOURCE_AUTHORITY_TIMEOUT_MS）与 sidecar 不可达 → 502。
 */
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");

const { createApp } = require("../server/index");
const { getConfig } = require("../server/config");

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function throwsMessage(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function opaque(prefix, value) {
  return prefix + crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function keyId(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function deepEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

const INTERNAL_SECRET = "stage86c1-analysis-tasks-internal-secret-32b";
const ALPHA_KEY = "alpha-task-key";
const BETA_KEY = "beta-task-key";
const DONE_ID = "t_done00000000000000";
const RUNNING_ID = "t_running00000000000";
const FAILED_ID = "t_failed000000000000";
const FAILED_NOMSG_ID = "t_failednomsg0000000";
const MISSING_ID = "t_missing00000000000";
const BROKEN_ID = "t_broken000000000000";
const SLOW_ID = "t_slow00000000000000";
const RECOVERED_ID = "t_recovered000000000";
// C# /events 重放的就是 Node 落库的事件对象：前两条是 progress 帧（有 stage），第三条是 Node 的终态事件（无 stage → message 帧）。
const STREAM_EVENTS = [
  { seq: 1, ts: 1788782400000, stage: "queued", message: "已排队", progress: 0.03 },
  { seq: 2, ts: 1788782400200, stage: "engine", message: "规则引擎计算中", progress: 0.6 },
  { seq: 3, ts: 1788782400400, done: true, progress: 1, message: "分析完成" },
];
const REPORT = {
  title: "失败率分析",
  verdict: "M2 的失败率显著高于其它机器。",
  rowCount: 3,
  confidence: "中",
  sections: [{ h: "结论", lines: ["M2/ABS 组合失败 1 次。"] }],
  chart: { kind: "bar-rate", title: "按机器失败率", items: [{ label: "M2", value: 1 }, { label: "M1", value: 0 }] },
};
const CSV = "machine,material,status,duration_min\nM1,PLA,success,42\nM2,ABS,fail,55\nM1,PLA,fail,50\n";

function snapshot(id, status, extra) {
  return {
    id,
    question: "哪台机器失败率最高？",
    datasourceId: "ds_" + "a".repeat(24),
    engine: "local",
    provider: "rules",
    status,
    progress: status === "running" ? 0.4 : 1,
    phase: status === "running" ? "engine" : status,
    message: status === "running" ? "规则引擎计算中" : status === "done" ? "分析完成" : "分析失败",
    lastSequence: 4,
    report: status === "done" ? REPORT : null,
    errorMessage: null,
    upstreamTaskId: null,
    createdAt: "2026-09-06T12:00:00Z",
    finishedAt: status === "running" ? null : "2026-09-06T12:00:01Z",
    expiresAt: "2026-09-06T13:00:00Z",
    links: { self: "/api/v1/analysis-tasks/" + id, events: "/api/v1/analysis-tasks/" + id + "/events" },
    ...(extra || {}),
  };
}

function problem(res, status, code, title) {
  res.writeHead(status, { "content-type": "application/problem+json; charset=utf-8" });
  res.end(JSON.stringify({ type: "urn:forgex:problem:" + code, title, status, code, traceId: "t", instance: "/x" }));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/* 按 C# EventsAsync 的帧格式写一帧：id / event / data。 */
function sseFrame(res, id, event, payload) {
  res.write("id: " + id + "\nevent: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n");
}

/* 假 ForgeX.Api：GET /api/v1/analysis-tasks/{id} 按 id 返回固定快照；/{id}/events 重放命名帧。 */
function createFakeSidecar() {
  const observed = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observed.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const route = req.method + " " + req.url.split("?")[0];
      const prefix = "GET /api/v1/analysis-tasks/";
      if (!route.startsWith(prefix)) return json(res, 501, { error: "unexpected sidecar request: " + route });
      let id = route.slice(prefix.length);
      if (id.endsWith("/events")) {
        id = id.slice(0, -"/events".length);
        if (id === MISSING_ID) return problem(res, 404, "analysis_task_not_found", "Analysis task not found");
        if (id === BROKEN_ID) return problem(res, 500, "internal", "boom");
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store" });
        if (id === RECOVERED_ID) {
          // 重启恢复成 failed 的任务：事件里没有终态事件，只有 C# 自己的 done 快照帧。
          sseFrame(res, 1, "progress", STREAM_EVENTS[0]);
          sseFrame(res, 2, "done", snapshot(id, "failed", { errorMessage: "服务重启时任务中断", report: null }));
          return res.end();
        }
        // Last-Event-ID 续传：只重放 seq 更大的事件（与 C# 一致）；心跳注释夹在中间。
        const since = Number(req.headers["last-event-id"] || 0);
        res.write(": heartbeat\n\n");
        for (const event of STREAM_EVENTS) {
          if (event.seq <= since) continue;
          sseFrame(res, event.seq, event.stage ? "progress" : "message", event);
        }
        sseFrame(res, 4, "done", snapshot(id, "done"));
        return res.end();
      }
      if (id === DONE_ID) return json(res, 200, snapshot(id, "done"));
      if (id === RUNNING_ID) return json(res, 200, snapshot(id, "running"));
      if (id === FAILED_ID) return json(res, 200, snapshot(id, "failed", { errorMessage: "上游超时" }));
      if (id === FAILED_NOMSG_ID) return json(res, 200, snapshot(id, "failed"));
      if (id === MISSING_ID) return problem(res, 404, "analysis_task_not_found", "Analysis task not found");
      if (id === BROKEN_ID) return problem(res, 500, "internal", "boom");
      if (id === SLOW_ID) return setTimeout(() => json(res, 200, snapshot(id, "done")), 400);
      json(res, 501, { error: "unexpected task id: " + id });
    });
  });
  return { server, observed };
}

/* 宽容的假连接池：任何 SQL 都返回空结果。csharp 模式的两条 GET 根本不该碰它，
   但 createApp 启用 postgres 持久化后其它路径（/healthz、创建、SSE）仍会经 withTransaction 走到这里。 */
function createFakePool() {
  const pool = {
    queries: [],
    async connect() {
      return {
        query: async (sql, params) => {
          pool.queries.push({ sql, params });
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
    async query(sql, params) {
      pool.queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    async end() {},
    on() {},
  };
  return pool;
}

async function getJson(base, pathname, headers) {
  const response = await fetch(base + pathname, { headers: headers || {} });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, json: parsed, text };
}

async function postJson(base, pathname, body, headers) {
  const response = await fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, json: parsed, text };
}

/* 上传 → 分析 → 等终态，返回 { taskId, report }。 */
async function completeTask(base, key) {
  const auth = { Authorization: "Bearer " + key };
  const upload = await postJson(base, "/api/datasource", { csv: CSV, name: "jobs.csv" }, auth);
  if (upload.status !== 201) throw new Error("upload failed: " + upload.text);
  const analyze = await postJson(base, "/api/analyze", { datasourceId: upload.json.datasourceId, question: "哪台机器失败率最高？" }, auth);
  if (analyze.status !== 202) throw new Error("analyze failed: " + analyze.text);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const poll = await getJson(base, "/api/analyze/" + analyze.json.taskId + "/result", auth);
    if (poll.status === 200) return { taskId: analyze.json.taskId, report: poll.json };
    if (poll.status !== 202) throw new Error("analysis failed: " + poll.text);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("analysis did not finish in time");
}

/* 读 SSE 首帧后立即断开：只证明 /stream 由 Node 本地服务。 */
async function streamStatus(base, pathname, headers) {
  const controller = new AbortController();
  const response = await fetch(base + pathname, { headers: headers || {}, signal: controller.signal });
  const contentType = response.headers.get("content-type") || "";
  let body = null;
  if (!contentType.includes("event-stream")) body = await response.text();
  controller.abort();
  return { status: response.status, contentType, body };
}

/* 读完整条 SSE 直到服务端关闭，按空行切帧：注释行进 comments，data 行 JSON 解析进 events。 */
async function readSse(base, pathname, headers) {
  const response = await fetch(base + pathname, { headers: headers || {} });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.includes("event-stream")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, contentType, json: parsed, text, events: [], comments: [], named: [] };
  }
  const events = [];
  const comments = [];
  const named = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line.length);
    if (!lines.length) continue;
    for (const line of lines) {
      if (line.startsWith(":")) comments.push(line.slice(1).trim());
      else if (line.startsWith("event:")) named.push(line.slice(6).trim());
      else if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5).trim()));
    }
  }
  return { status: response.status, contentType, text, events, comments, named };
}

function baseApp(overrides) {
  return createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: "",
    apiKeys: `${ALPHA_KEY},${BETA_KEY}`,
    gcodeAuthorityInternalSecret: INTERNAL_SECRET,
    ...overrides,
  });
}

async function main() {
  /* ── [1] 配置校验 ─────────────────────────────────────────────── */
  console.log("[1] ANALYSIS_TASKS_AUTHORITY 配置校验");
  check(
    "取值非法被拒绝",
    /ANALYSIS_TASKS_AUTHORITY must be node or csharp/.test(
      throwsMessage(() => getConfig({ analysisTasksAuthority: "maybe", gcodeAuthorityUrl: "" })) || ""
    )
  );
  check(
    "csharp 缺 GCODE_AUTHORITY_URL 被拒绝",
    /GCODE_AUTHORITY_URL/.test(throwsMessage(() => getConfig({ analysisTasksAuthority: "csharp", gcodeAuthorityUrl: "" })) || "")
  );
  check(
    "csharp 缺内部信任密钥被拒绝",
    /GCODE_AUTHORITY_INTERNAL_SECRET/.test(
      throwsMessage(() =>
        getConfig({ analysisTasksAuthority: "csharp", gcodeAuthorityUrl: "http://127.0.0.1:1", gcodeAuthorityInternalSecret: "" })
      ) || ""
    )
  );
  check(
    "csharp + PERSISTENCE_PROVIDER=file 被拒绝",
    /PERSISTENCE_PROVIDER=postgres/.test(
      throwsMessage(() =>
        getConfig({
          analysisTasksAuthority: "csharp",
          gcodeAuthorityUrl: "http://127.0.0.1:1",
          gcodeAuthorityInternalSecret: INTERNAL_SECRET,
          persistenceProvider: "file",
        })
      ) || ""
    )
  );
  const parsed = getConfig({
    analysisTasksAuthority: " CSHARP ",
    gcodeAuthorityUrl: "http://127.0.0.1:1",
    gcodeAuthorityInternalSecret: INTERNAL_SECRET,
    persistenceProvider: "postgres",
    postgresUrl: "postgres://fake/forgex",
    resourceAuthorityTimeoutMs: "0",
  });
  check(
    "开关规范化，超时复用 RESOURCE_AUTHORITY_TIMEOUT_MS 且有下限",
    parsed.analysisTasksAuthority === "csharp" && parsed.resourceAuthorityTimeoutMs === 1,
    JSON.stringify([parsed.analysisTasksAuthority, parsed.resourceAuthorityTimeoutMs])
  );

  const sidecar = createFakeSidecar();
  const sidecarOrigin = `http://127.0.0.1:${await listen(sidecar.server)}`;
  const alphaAuth = { Authorization: "Bearer " + ALPHA_KEY };

  /* ── [2] 默认 node 模式 ────────────────────────────────────────── */
  console.log("[2] 默认 node 模式：sidecar 零调用");
  const nodeApp = baseApp({ analysisTasksAuthority: "node", gcodeAuthorityUrl: sidecarOrigin });
  const nodeBase = `http://127.0.0.1:${await listen(nodeApp.server)}`;
  try {
    const { taskId, report } = await completeTask(nodeBase, ALPHA_KEY);
    const poll = await getJson(nodeBase, "/api/analyze/" + taskId, alphaAuth);
    const stream = await streamStatus(nodeBase, "/api/analyze/" + taskId + "/stream", alphaAuth);
    check(
      "创建 / 结果 / 轮询 / SSE 全部本地完成，sidecar 未被调用",
      report && report.rowCount === 3 && poll.status === 200 && poll.json.status === "done" && poll.json.taskId === taskId &&
        stream.status === 200 && stream.contentType.includes("text/event-stream") && sidecar.observed.length === 0,
      JSON.stringify([poll.status, poll.json, stream.status, stream.contentType, sidecar.observed.length])
    );
  } finally {
    await nodeApp.close();
  }

  /* ── [3] csharp 模式 ──────────────────────────────────────────── */
  console.log("[3] csharp 模式：结果与轮询读 C# 快照");
  const pool = createFakePool();
  const csharpApp = baseApp({
    analysisTasksAuthority: "csharp",
    persistenceProvider: "postgres",
    postgresUrl: "postgres://fake/forgex",
    postgresPool: pool,
    gcodeAuthorityUrl: sidecarOrigin,
  });
  const base = `http://127.0.0.1:${await listen(csharpApp.server)}`;
  const alphaId = keyId(ALPHA_KEY);
  const last = () => sidecar.observed.at(-1);
  try {
    sidecar.observed.length = 0;
    const queriesBefore = pool.queries.length;
    const done = await getJson(base, "/api/analyze/" + DONE_ID + "/result", { ...alphaAuth, Cookie: "session-probe=1" });
    const doneSeen = last();
    check(
      "结果读经 GET /api/v1/analysis-tasks/{id}，携带匿名化 tenant/owner，不泄漏 cookie / authorization",
      done.status === 200 && doneSeen && doneSeen.method === "GET" && doneSeen.url === "/api/v1/analysis-tasks/" + DONE_ID &&
        doneSeen.headers["x-forgex-internal-token"] === INTERNAL_SECRET &&
        doneSeen.headers["x-forgex-tenant-id"] === opaque("tn_", "key:" + alphaId) &&
        doneSeen.headers["x-forgex-owner-id"] === opaque("ow_", "key:" + alphaId) &&
        !doneSeen.headers.cookie && !doneSeen.headers.authorization,
      JSON.stringify(doneSeen && doneSeen.headers)
    );
    check("done → 200，报告原样透传", done.status === 200 && deepEqual(done.json, REPORT), JSON.stringify(done.json));
    check(
      "csharp 读路径不碰本地任务表（假池零查询）",
      pool.queries.length === queriesBefore,
      JSON.stringify(pool.queries.slice(queriesBefore).map((item) => item.sql).slice(0, 3))
    );
    const anonymous = await getJson(base, "/api/analyze/" + DONE_ID + "/result");
    const anonymousSeen = last();
    check(
      "匿名身份按 ip 派生 tenant/owner 头",
      anonymous.status === 200 && anonymousSeen &&
        anonymousSeen.headers["x-forgex-tenant-id"] === opaque("tn_", "ip:127.0.0.1") &&
        anonymousSeen.headers["x-forgex-owner-id"] === opaque("ow_", "ip:127.0.0.1"),
      JSON.stringify(anonymousSeen && anonymousSeen.headers)
    );
    const running = await getJson(base, "/api/analyze/" + RUNNING_ID + "/result", alphaAuth);
    check("running → 202 {status: running}", running.status === 202 && deepEqual(running.json, { status: "running" }), JSON.stringify(running.json));
    const failedTask = await getJson(base, "/api/analyze/" + FAILED_ID + "/result", alphaAuth);
    check("failed → 502 + errorMessage", failedTask.status === 502 && failedTask.json.error === "上游超时", JSON.stringify(failedTask.json));
    const failedNoMsg = await getJson(base, "/api/analyze/" + FAILED_NOMSG_ID + "/result", alphaAuth);
    check("failed 无文案 → 502「分析失败」", failedNoMsg.status === 502 && failedNoMsg.json.error === "分析失败", JSON.stringify(failedNoMsg.json));
    const missing = await getJson(base, "/api/analyze/" + MISSING_ID + "/result", alphaAuth);
    check("C# 404 → 任务不存在或已过期", missing.status === 404 && missing.json.error === "任务不存在或已过期", JSON.stringify(missing.json));
    const broken = await getJson(base, "/api/analyze/" + BROKEN_ID + "/result", alphaAuth);
    check(
      "C# 500 → 502 分析任务服务暂不可用",
      broken.status === 502 && broken.json.error === "分析任务服务暂不可用，请稍后再试",
      JSON.stringify(broken.json)
    );

    // 轮询
    const pollDone = await getJson(base, "/api/analyze/" + DONE_ID, alphaAuth);
    check(
      "轮询 done → {taskId, status, engine, progress, message}，无 error 键",
      pollDone.status === 200 &&
        deepEqual(pollDone.json, { taskId: DONE_ID, status: "done", engine: "local", progress: 1, message: "分析完成" }),
      JSON.stringify(pollDone.json)
    );
    const pollRunning = await getJson(base, "/api/analyze/" + RUNNING_ID, alphaAuth);
    check(
      "轮询 running → progress / message 来自快照",
      pollRunning.status === 200 && pollRunning.json.status === "running" && pollRunning.json.progress === 0.4 &&
        pollRunning.json.message === "规则引擎计算中",
      JSON.stringify(pollRunning.json)
    );
    const pollFailed = await getJson(base, "/api/analyze/" + FAILED_ID, alphaAuth);
    check(
      "轮询 failed → 带 error",
      pollFailed.status === 200 && pollFailed.json.status === "failed" && pollFailed.json.error === "上游超时",
      JSON.stringify(pollFailed.json)
    );
    const pollMissing = await getJson(base, "/api/analyze/" + MISSING_ID, alphaAuth);
    check("轮询 C# 404 → 任务不存在或已过期", pollMissing.status === 404 && pollMissing.json.error === "任务不存在或已过期", JSON.stringify(pollMissing.json));

    // SSE：消费 C# /events 命名帧，重新组成无名 data: 帧
    sidecar.observed.length = 0;
    const stream = await readSse(base, "/api/analyze/" + DONE_ID + "/stream", { ...alphaAuth, Cookie: "session-probe=1" });
    const streamSeen = last();
    check(
      "/stream 经可信通道打开 C# /events，携带匿名化 tenant/owner，不泄漏 cookie",
      stream.status === 200 && stream.contentType.includes("text/event-stream") && streamSeen &&
        streamSeen.url === "/api/v1/analysis-tasks/" + DONE_ID + "/events" &&
        streamSeen.headers.accept === "text/event-stream" &&
        streamSeen.headers["x-forgex-internal-token"] === INTERNAL_SECRET &&
        streamSeen.headers["x-forgex-owner-id"] === opaque("ow_", "key:" + alphaId) && !streamSeen.headers.cookie,
      JSON.stringify(streamSeen && streamSeen.headers)
    );
    check(
      "progress / message 帧原样转成无名 data: 帧，C# done 快照帧不重复转发，心跳透传",
      deepEqual(stream.events, STREAM_EVENTS) && stream.named.length === 0 && stream.comments.includes("connected") &&
        stream.comments.includes("heartbeat"),
      JSON.stringify([stream.events, stream.named, stream.comments])
    );
    const resumed = await readSse(base, "/api/analyze/" + DONE_ID + "/stream", { ...alphaAuth, "Last-Event-ID": "2" });
    const resumedSeen = last();
    check(
      "Last-Event-ID 透传到 C#，只收到 seq > 2 的事件",
      resumedSeen && resumedSeen.headers["last-event-id"] === "2" && deepEqual(resumed.events, [STREAM_EVENTS[2]]),
      JSON.stringify([resumedSeen && resumedSeen.headers["last-event-id"], resumed.events])
    );
    const recovered = await readSse(base, "/api/analyze/" + RECOVERED_ID + "/stream", alphaAuth);
    const synthesized = recovered.events[1];
    check(
      "事件里没有终态时，用 C# done 快照合成 Node 形状的失败终态",
      recovered.events.length === 2 && deepEqual(recovered.events[0], STREAM_EVENTS[0]) && synthesized &&
        synthesized.done === true && synthesized.seq === 2 && synthesized.error === "服务重启时任务中断" &&
        synthesized.message === "分析失败：服务重启时任务中断" && typeof synthesized.ts === "number",
      JSON.stringify(recovered.events)
    );
    const streamMissing = await readSse(base, "/api/analyze/" + MISSING_ID + "/stream", alphaAuth);
    check(
      "C# /events 404 → 发头前映射为 404 任务不存在或已过期",
      streamMissing.status === 404 && streamMissing.json && streamMissing.json.error === "任务不存在或已过期",
      JSON.stringify([streamMissing.status, streamMissing.json])
    );
    const streamBroken = await readSse(base, "/api/analyze/" + BROKEN_ID + "/stream", alphaAuth);
    check(
      "C# /events 500 → 502 分析任务服务暂不可用",
      streamBroken.status === 502 && streamBroken.json && streamBroken.json.error === "分析任务服务暂不可用，请稍后再试",
      JSON.stringify([streamBroken.status, streamBroken.json])
    );

    // 创建仍在 Node
    const before = sidecar.observed.length;
    const create = await postJson(base, "/api/analyze", { question: "" }, alphaAuth);
    check(
      "POST /api/analyze 仍由 Node 本地校验（question 为空 400，不转发）",
      create.status === 400 && create.json.error === "question 不能为空" && sidecar.observed.length === before,
      JSON.stringify(create.json)
    );
  } finally {
    await csharpApp.close();
  }

  /* ── [4] 超时与 sidecar 不可达 ───────────────────────────────── */
  console.log("[4] 超时 / sidecar 不可达 → 502");
  const slowApp = baseApp({
    analysisTasksAuthority: "csharp",
    persistenceProvider: "postgres",
    postgresUrl: "postgres://fake/forgex",
    postgresPool: createFakePool(),
    gcodeAuthorityUrl: sidecarOrigin,
    resourceAuthorityTimeoutMs: 50,
  });
  const slowBase = `http://127.0.0.1:${await listen(slowApp.server)}`;
  try {
    const slow = await getJson(slowBase, "/api/analyze/" + SLOW_ID + "/result", alphaAuth);
    check(
      "RESOURCE_AUTHORITY_TIMEOUT_MS 超时 → 502",
      slow.status === 502 && slow.json.error === "分析任务服务暂不可用，请稍后再试",
      JSON.stringify(slow.json)
    );
  } finally {
    await slowApp.close();
  }

  const closedProbe = http.createServer();
  const closedPort = await listen(closedProbe);
  await close(closedProbe);
  const downApp = baseApp({
    analysisTasksAuthority: "csharp",
    persistenceProvider: "postgres",
    postgresUrl: "postgres://fake/forgex",
    postgresPool: createFakePool(),
    gcodeAuthorityUrl: `http://127.0.0.1:${closedPort}`,
  });
  const downBase = `http://127.0.0.1:${await listen(downApp.server)}`;
  try {
    const result = await getJson(downBase, "/api/analyze/" + DONE_ID + "/result", alphaAuth);
    check("不可达：结果 502", result.status === 502 && result.json.error === "分析任务服务暂不可用，请稍后再试", JSON.stringify(result.json));
    const poll = await getJson(downBase, "/api/analyze/" + DONE_ID, alphaAuth);
    check("不可达：轮询 502", poll.status === 502 && poll.json.error === "分析任务服务暂不可用，请稍后再试", JSON.stringify(poll.json));
    const stream = await readSse(downBase, "/api/analyze/" + DONE_ID + "/stream", alphaAuth);
    check(
      "不可达：进度流 502（发头前）",
      stream.status === 502 && stream.json && stream.json.error === "分析任务服务暂不可用，请稍后再试",
      JSON.stringify([stream.status, stream.json])
    );
  } finally {
    await downApp.close();
  }

  await close(sidecar.server);

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  // 不用 process.exit()：让 undici keep-alive 套接字自然收尾（同 shares-authority）。
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
