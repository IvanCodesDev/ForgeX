/* Stage 8.6b：分享腿（SHARES_AUTHORITY）的 C# 权威切流集成测试，口径对齐 resource-authority.test.js。
 *
 * 用 node:http 起一个假 ForgeX.Api sidecar 记录收到的请求，验证：
 *   [1] 配置校验：开关取值、csharp 依赖 GCODE_AUTHORITY_URL、超时下限；
 *   [2] 默认 node 模式：创建 / 公开页 / 撤销全部本地完成，sidecar 一次都不被调用（回滚开关有效）；
 *   [3] csharp 模式：
 *       - 任务归属仍在 Node 判定：任务不存在 404、他人任务 403 都不转发；
 *       - 创建经可信通道转发（tenant/owner 匿名化哈希、不泄漏 cookie / authorization），
 *         请求体带任务的 report / question / engine，Node 只改写 publicUrl（PUBLIC_BASE / Origin / 相对路径 + note）；
 *       - sidecar 5xx 或 201 无 token → 502 文案；
 *       - 公开页不注入任何身份头，HTML 与 content-type 原样透传、Cache-Control no-cache，404 / 5xx 映射；
 *       - 撤销 200 / 404 / 403 / 其它状态 → 502 映射；
 *       - /metrics 的 forgex_shares 在 csharp 模式下为 0（本地存储未被使用）；
 *   [4] 超时与 sidecar 不可达 → 502。
 */
"use strict";

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

const INTERNAL_SECRET = "stage86b-shares-internal-secret-32-bytes!";
const ALPHA_KEY = "alpha-share-key";
const BETA_KEY = "beta-share-key";
const TOKEN = "ab".repeat(9);
const MISSING = "00".repeat(9);
const BROKEN = "be".repeat(9);
const SLOW = "5a".repeat(9);
const REVOKE_KEY = "cd".repeat(9);
const EXPIRES_AT = 4102444800000;
const PAGE_HTML =
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>&#x63A2;&#x9488; — FORGE·X 智造洞察</title></head>' +
  "<body><h1>&#x63A2;&#x9488;</h1></body></html>";
const CSV = "machine,material,status,duration_min\nM1,PLA,success,42\nM2,ABS,fail,55\nM1,PLA,fail,50\n";

function problem(res, status, code, title) {
  res.writeHead(status, { "content-type": "application/problem+json; charset=utf-8" });
  res.end(JSON.stringify({ type: "urn:forgex:problem:" + code, title, status, code, traceId: "t", instance: "/x" }));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/* 假 ForgeX.Api：分享三端点。createMode 由测试在调用前切换（ok / boom / no-token）。 */
function createFakeSidecar() {
  const observed = [];
  const state = { createMode: "ok" };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      observed.push({ method: req.method, url: req.url, headers: req.headers, body });
      const route = req.method + " " + req.url.split("?")[0];
      if (route === "POST /api/v1/shares") {
        if (state.createMode === "boom") return problem(res, 500, "internal", "boom");
        if (state.createMode === "no-token") return json(res, 201, { publicUrl: "/share/" });
        return json(res, 201, {
          publicUrl: "/share/" + TOKEN,
          token: TOKEN,
          revokeKey: REVOKE_KEY,
          expiresAt: EXPIRES_AT,
          note: "publicUrl 为相对路径；部署时请配置 Shares:PublicBase 或由代理改写。",
        });
      }
      if (route === "GET /share/" + TOKEN) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        return res.end(PAGE_HTML);
      }
      if (route === "GET /share/" + SLOW) {
        return setTimeout(() => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(PAGE_HTML);
        }, 400);
      }
      if (route === "GET /share/" + MISSING) return problem(res, 404, "share_not_found", "分享页不存在、已过期或已被撤销");
      if (route === "GET /share/" + BROKEN) return problem(res, 500, "internal", "boom");
      if (route === "POST /api/v1/shares/" + TOKEN + "/revoke") {
        if (body && body.revokeKey === REVOKE_KEY) return json(res, 200, { revoked: true });
        return problem(res, 403, "bad_revoke_key", "撤销密钥不正确");
      }
      if (route === "POST /api/v1/shares/" + MISSING + "/revoke") return problem(res, 404, "share_not_found", "分享不存在或已过期");
      if (route === "POST /api/v1/shares/" + BROKEN + "/revoke") return problem(res, 500, "internal", "boom");
      json(res, 501, { error: "unexpected sidecar request: " + route });
    });
  });
  return { server, observed, state };
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
  return { status: response.status, headers: response.headers, json: parsed, text };
}

/* 上传 → 分析 → 等终态，返回 { taskId, report }。分享要求任务 done 且归属调用方。 */
async function completeTask(base, key) {
  const auth = { Authorization: "Bearer " + key };
  const upload = await postJson(base, "/api/datasource", { csv: CSV, name: "jobs.csv" }, auth);
  if (upload.status !== 201) throw new Error("upload failed: " + upload.text);
  const analyze = await postJson(base, "/api/analyze", { datasourceId: upload.json.datasourceId, question: "哪台机器失败率最高？" }, auth);
  if (analyze.status !== 202) throw new Error("analyze failed: " + analyze.text);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const poll = await fetch(base + "/api/analyze/" + analyze.json.taskId + "/result", { headers: auth });
    const body = await poll.json();
    if (poll.status === 200) return { taskId: analyze.json.taskId, report: body };
    if (poll.status !== 202) throw new Error("analysis failed: " + JSON.stringify(body));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("analysis did not finish in time");
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
  console.log("[1] SHARES_AUTHORITY 配置校验");
  check(
    "SHARES_AUTHORITY 取值非法被拒绝",
    /SHARES_AUTHORITY must be node or csharp/.test(throwsMessage(() => getConfig({ sharesAuthority: "maybe", gcodeAuthorityUrl: "" })) || "")
  );
  check(
    "SHARES_AUTHORITY=csharp 缺 GCODE_AUTHORITY_URL 被拒绝",
    /GCODE_AUTHORITY_URL/.test(throwsMessage(() => getConfig({ sharesAuthority: "csharp", gcodeAuthorityUrl: "" })) || "")
  );
  const parsed = getConfig({ sharesAuthority: " CSHARP ", gcodeAuthorityUrl: "http://127.0.0.1:1", sharesAuthorityTimeoutMs: "0" });
  check(
    "开关规范化与超时下限",
    parsed.sharesAuthority === "csharp" && parsed.sharesAuthorityTimeoutMs === 1,
    JSON.stringify([parsed.sharesAuthority, parsed.sharesAuthorityTimeoutMs])
  );

  const sidecar = createFakeSidecar();
  const sidecarOrigin = `http://127.0.0.1:${await listen(sidecar.server)}`;

  /* ── [2] 默认 node 模式 ────────────────────────────────────────── */
  console.log("[2] 默认 node 模式：sidecar 零调用");
  const nodeApp = baseApp({ sharesAuthority: "node", gcodeAuthorityUrl: sidecarOrigin });
  const nodeBase = `http://127.0.0.1:${await listen(nodeApp.server)}`;
  try {
    const { taskId } = await completeTask(nodeBase, ALPHA_KEY);
    const created = await postJson(nodeBase, "/api/share/" + taskId, {}, { Authorization: "Bearer " + ALPHA_KEY });
    const page = await fetch(nodeBase + "/share/" + (created.json && created.json.token));
    const pageText = await page.text();
    const revoked = await postJson(
      nodeBase,
      "/api/share/" + created.json.token + "/revoke",
      { revokeKey: created.json.revokeKey },
      { Authorization: "Bearer " + ALPHA_KEY }
    );
    check(
      "创建 / 公开页 / 撤销全部本地完成，sidecar 未被调用",
      created.status === 201 && page.status === 200 && pageText.includes("FORGE·X 智造洞察") && revoked.status === 200 &&
        sidecar.observed.length === 0,
      JSON.stringify([created.status, page.status, revoked.status, sidecar.observed.length])
    );
  } finally {
    await nodeApp.close();
  }

  /* ── [3] csharp 模式 ──────────────────────────────────────────── */
  console.log("[3] csharp 模式：可信通道转发");
  const csharpApp = baseApp({ sharesAuthority: "csharp", gcodeAuthorityUrl: sidecarOrigin });
  const base = `http://127.0.0.1:${await listen(csharpApp.server)}`;
  const alphaAuth = { Authorization: "Bearer " + ALPHA_KEY };
  const alphaId = keyId(ALPHA_KEY);
  const last = () => sidecar.observed.at(-1);
  try {
    const { taskId, report } = await completeTask(base, ALPHA_KEY);
    sidecar.observed.length = 0;

    const missing = await postJson(base, "/api/share/t_0000000000000000", {}, alphaAuth);
    check(
      "任务不存在由 Node 404，不转发",
      missing.status === 404 && missing.json.error === "任务不存在或已过期" && sidecar.observed.length === 0,
      JSON.stringify(missing.json)
    );
    const foreign = await postJson(base, "/api/share/" + taskId, {}, { Authorization: "Bearer " + BETA_KEY });
    check(
      "他人任务由 Node 403，不转发",
      foreign.status === 403 && foreign.json.error === "无权访问该资源" && sidecar.observed.length === 0,
      JSON.stringify(foreign.json)
    );

    const created = await postJson(base, "/api/share/" + taskId, {}, { ...alphaAuth, Origin: "https://ui.example", Cookie: "session-probe=1" });
    const createdSeen = last();
    check(
      "创建转发到 /api/v1/shares 并携带匿名化 tenant/owner，不泄漏 cookie / authorization",
      created.status === 201 && createdSeen && createdSeen.method === "POST" && createdSeen.url === "/api/v1/shares" &&
        createdSeen.headers["x-forgex-internal-token"] === INTERNAL_SECRET &&
        createdSeen.headers["x-forgex-tenant-id"] === opaque("tn_", "key:" + alphaId) &&
        createdSeen.headers["x-forgex-owner-id"] === opaque("ow_", "key:" + alphaId) &&
        !createdSeen.headers.cookie && !createdSeen.headers.authorization && !createdSeen.headers.origin,
      JSON.stringify(createdSeen && createdSeen.headers)
    );
    check(
      "转发体携带任务的 report / question / engine",
      createdSeen && createdSeen.body && createdSeen.body.report && createdSeen.body.report.title === report.title &&
        createdSeen.body.report.verdict === report.verdict && createdSeen.body.question === "哪台机器失败率最高？" &&
        typeof createdSeen.body.engine === "string" && createdSeen.body.engine.length > 0 &&
        createdSeen.body.upstreamTaskId == null,
      JSON.stringify(createdSeen && createdSeen.body && { question: createdSeen.body.question, engine: createdSeen.body.engine, title: createdSeen.body.report && createdSeen.body.report.title })
    );
    check(
      "响应改写 publicUrl 为 Origin + /share/token，其余字段透传，无 note",
      created.json.publicUrl === "https://ui.example/share/" + TOKEN && created.json.token === TOKEN &&
        created.json.revokeKey === REVOKE_KEY && created.json.expiresAt === EXPIRES_AT && created.json.note === undefined,
      JSON.stringify(created.json)
    );
    const relative = await postJson(base, "/api/share/" + taskId, {}, alphaAuth);
    check(
      "无 PUBLIC_BASE 且无 Origin：相对路径 + note",
      relative.status === 201 && relative.json.publicUrl === "/share/" + TOKEN && typeof relative.json.note === "string" &&
        relative.json.note.includes("PUBLIC_BASE"),
      JSON.stringify(relative.json)
    );
    sidecar.state.createMode = "boom";
    const boom = await postJson(base, "/api/share/" + taskId, {}, alphaAuth);
    check("sidecar 500 → 502 分享服务暂不可用", boom.status === 502 && boom.json.error === "分享服务暂不可用，请稍后再试", JSON.stringify(boom.json));
    sidecar.state.createMode = "no-token";
    const noToken = await postJson(base, "/api/share/" + taskId, {}, alphaAuth);
    check("sidecar 201 无 token → 502", noToken.status === 502 && noToken.json.error === "分享服务暂不可用，请稍后再试", JSON.stringify(noToken.json));
    sidecar.state.createMode = "ok";

    // 公开页
    sidecar.observed.length = 0;
    const page = await fetch(base + "/share/" + TOKEN, { headers: { Cookie: "session-probe=1" } });
    const pageText = await page.text();
    const pageSeen = last();
    check(
      "公开页转发 GET /share/{token} 且不带任何身份头",
      page.status === 200 && pageSeen && pageSeen.method === "GET" && pageSeen.url === "/share/" + TOKEN &&
        !pageSeen.headers["x-forgex-internal-token"] && !pageSeen.headers["x-forgex-tenant-id"] &&
        !pageSeen.headers["x-forgex-owner-id"] && !pageSeen.headers.cookie,
      JSON.stringify(pageSeen && pageSeen.headers)
    );
    check(
      "HTML 与 content-type 原样透传，Cache-Control no-cache",
      pageText === PAGE_HTML && page.headers.get("content-type") === "text/html; charset=utf-8" &&
        page.headers.get("cache-control") === "no-cache",
      JSON.stringify([page.headers.get("content-type"), page.headers.get("cache-control"), pageText.slice(0, 60)])
    );
    const pageMissing = await fetch(base + "/share/" + MISSING);
    const pageMissingBody = await pageMissing.json();
    check(
      "sidecar 404 → 分享页不存在、已过期或已被撤销",
      pageMissing.status === 404 && pageMissingBody.error === "分享页不存在、已过期或已被撤销",
      JSON.stringify(pageMissingBody)
    );
    const pageBroken = await fetch(base + "/share/" + BROKEN);
    const pageBrokenBody = await pageBroken.json();
    check("sidecar 500 → 公开页 502", pageBroken.status === 502 && pageBrokenBody.error === "分享服务暂不可用，请稍后再试", JSON.stringify(pageBrokenBody));

    // 撤销
    sidecar.observed.length = 0;
    const wrongKey = await postJson(base, "/api/share/" + TOKEN + "/revoke", { revokeKey: "wrong" }, alphaAuth);
    const wrongSeen = last();
    check(
      "撤销转发 /api/v1/shares/{token}/revoke，携带 revokeKey 与身份头；C# 403 → 撤销密钥不正确",
      wrongKey.status === 403 && wrongKey.json.error === "撤销密钥不正确" && wrongSeen &&
        wrongSeen.url === "/api/v1/shares/" + TOKEN + "/revoke" && wrongSeen.body.revokeKey === "wrong" &&
        wrongSeen.headers["x-forgex-internal-token"] === INTERNAL_SECRET &&
        wrongSeen.headers["x-forgex-owner-id"] === opaque("ow_", "key:" + alphaId),
      JSON.stringify([wrongKey.json, wrongSeen && wrongSeen.body])
    );
    const revokeMissing = await postJson(base, "/api/share/" + MISSING + "/revoke", { revokeKey: REVOKE_KEY }, alphaAuth);
    check("C# 404 → 分享不存在或已过期", revokeMissing.status === 404 && revokeMissing.json.error === "分享不存在或已过期", JSON.stringify(revokeMissing.json));
    const revokeBroken = await postJson(base, "/api/share/" + BROKEN + "/revoke", { revokeKey: REVOKE_KEY }, alphaAuth);
    check("C# 500 → 撤销 502", revokeBroken.status === 502 && revokeBroken.json.error === "分享服务暂不可用，请稍后再试", JSON.stringify(revokeBroken.json));
    const revoked = await postJson(base, "/api/share/" + TOKEN + "/revoke", { revokeKey: REVOKE_KEY }, alphaAuth);
    check("C# 200 → {revoked: true}", revoked.status === 200 && revoked.json.revoked === true, JSON.stringify(revoked.json));

    const metrics = await fetch(base + "/metrics");
    const metricsText = await metrics.text();
    check(
      "/metrics：csharp 模式下 Node 本地 forgex_shares 为 0",
      metrics.status === 200 && metricsText.includes("forgex_shares 0\n"),
      metricsText.split("\n").filter((line) => line.startsWith("forgex_shares")).join(" | ")
    );
  } finally {
    await csharpApp.close();
  }

  /* ── [4] 超时与 sidecar 不可达 ───────────────────────────────── */
  console.log("[4] 超时 / sidecar 不可达 → 502");
  const slowApp = baseApp({ sharesAuthority: "csharp", gcodeAuthorityUrl: sidecarOrigin, sharesAuthorityTimeoutMs: 50 });
  const slowBase = `http://127.0.0.1:${await listen(slowApp.server)}`;
  try {
    const slow = await fetch(slowBase + "/share/" + SLOW);
    const slowBody = await slow.json();
    check("SHARES_AUTHORITY_TIMEOUT_MS 超时 → 502", slow.status === 502 && slowBody.error === "分享服务暂不可用，请稍后再试", JSON.stringify(slowBody));
  } finally {
    await slowApp.close();
  }

  const closedProbe = http.createServer();
  const closedPort = await listen(closedProbe);
  await close(closedProbe);
  const downApp = baseApp({ sharesAuthority: "csharp", gcodeAuthorityUrl: `http://127.0.0.1:${closedPort}` });
  const downBase = `http://127.0.0.1:${await listen(downApp.server)}`;
  try {
    const { taskId } = await completeTask(downBase, ALPHA_KEY);
    const created = await postJson(downBase, "/api/share/" + taskId, {}, { Authorization: "Bearer " + ALPHA_KEY });
    check("不可达：创建 502", created.status === 502 && created.json.error === "分享服务暂不可用，请稍后再试", JSON.stringify(created.json));
    const page = await fetch(downBase + "/share/" + TOKEN);
    const pageBody = await page.json();
    check("不可达：公开页 502", page.status === 502 && pageBody.error === "分享服务暂不可用，请稍后再试", JSON.stringify(pageBody));
    const revoke = await postJson(downBase, "/api/share/" + TOKEN + "/revoke", { revokeKey: REVOKE_KEY }, { Authorization: "Bearer " + ALPHA_KEY });
    check("不可达：撤销 502", revoke.status === 502 && revoke.json.error === "分享服务暂不可用，请稍后再试", JSON.stringify(revoke.json));
  } finally {
    await downApp.close();
  }

  await close(sidecar.server);

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  // 不用 process.exit()：让 undici keep-alive 套接字自然收尾（同 resource-authority）。
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
