/* Stage 8.6a：数据源 / 知识库 / 校准治理三条资源腿的 C# 权威切流集成测试。
 *
 * 用 node:http 起一个假 ForgeX.Api sidecar 记录收到的请求，验证：
 *   [1] 配置校验：三开关取值、csharp 依赖 GCODE_AUTHORITY_URL 与内部信任密钥；
 *   [2] 默认 node 模式：三条腿全部本地完成，sidecar 一次都不被调用（回滚开关有效）；
 *   [3] csharp 模式：
 *       - 数据源：上传经可信通道转发（tenant/owner 匿名化哈希）、响应透传、
 *         本地校验不转发、C# problem 原样映射、sidecar 不可达 → 502；
 *       - 分析：datasourceId 从 C# 读取（含 404 文案），知识列表也从 C# 拉取；
 *       - 知识库：登记 / 检索透传，Node 只补 retrievalEnabled 与 note；
 *       - 校准治理：公开目录不带内部令牌；submitter / reviewer 身份仍在 Node 判定，
 *         actor 头与 tenant 派生与 §7.3 一致；C# 409 problem 原样透传；
 *       - /healthz 的 calibrations 统计与 /metrics 的 gauge 语义。
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

const INTERNAL_SECRET = "stage86-resource-internal-secret-32-bytes";
const ALPHA_KEY = "alpha-key";
const REVIEW_KEY = "review-key";
const DS_ID = "ds_" + "a".repeat(24);
const DS_MISSING = "ds_" + "0".repeat(24);
const SAMPLE_ROWS = [
  { machine_id: "M1", model_name: "Bracket", material: "PLA", status: "success", duration_min: 42, cost_fen: 1250, fail_reason: "" },
  { machine_id: "M2", model_name: "Bracket", material: "ABS", status: "fail", duration_min: 55, cost_fen: 1800, fail_reason: "warping" },
  { machine_id: "M1", model_name: "Gear", material: "PLA", status: "success", duration_min: 30, cost_fen: 900, fail_reason: "" },
];
const PROVENANCE = { source: "user-upload", synthetic: false, badge: null, note: "用户上传数据，来源由上传方负责。", generator: null };

function problem(res, status, code, title) {
  res.writeHead(status, { "content-type": "application/problem+json; charset=utf-8" });
  res.end(JSON.stringify({ type: "urn:forgex:problem:" + code, title, status, code, traceId: "t", instance: "/x" }));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/* 假 ForgeX.Api：按 URL 返回固定形状，并记录每次调用。 */
function createFakeSidecar() {
  const observed = [];
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
      const path = req.url.split("?")[0];
      const route = req.method + " " + path;
      if (route === "POST /api/v1/datasources") {
        if (body && body.csv === "machine,material\n") return problem(res, 400, "csv_invalid", "CSV 解析失败：x");
        return json(res, 201, {
          datasourceId: DS_ID,
          name: String(body && body.name != null ? body.name : "print_jobs.csv").slice(0, 80),
          rows: 2,
          sha256: "b".repeat(64),
          deduplicated: false,
          provenance: PROVENANCE,
        });
      }
      if (route === "GET /api/v1/datasources/" + DS_ID) {
        return json(res, 200, {
          datasourceId: DS_ID,
          name: "jobs.csv",
          rows: SAMPLE_ROWS,
          contentSha256: "b".repeat(64),
          cacheKey: "c".repeat(64),
          provenance: PROVENANCE,
          builtin: false,
          warnings: [],
          createdAt: 1788652800000,
          expiresAt: 4102444800000,
        });
      }
      if (route === "GET /api/v1/datasources/sample") {
        return json(res, 200, {
          datasourceId: "sample",
          name: "内置机群仿真数据",
          rows: SAMPLE_ROWS,
          contentSha256: "d".repeat(64),
          cacheKey: "d".repeat(64),
          provenance: { source: "farm-simulation", synthetic: true, badge: "机群仿真", note: "x", generator: "farm" },
          builtin: true,
          warnings: [],
          createdAt: 1788652800000,
        });
      }
      if (route === "GET /api/v1/datasources/" + DS_MISSING) return problem(res, 404, "not_found", "数据源不存在或已过期");
      if (route === "POST /api/v1/knowledge") {
        return json(res, 201, {
          knowledgeId: "kb_0123456789abcdef",
          name: String(body && body.name != null ? body.name : "knowledge.md").slice(0, 80),
          chunks: String(body && body.text).length,
          createdAt: 1788652800000,
          expiresAt: 4102444800000,
        });
      }
      if (route === "GET /api/v1/knowledge") {
        return json(res, 200, {
          docs: [{ knowledgeId: "kb_0123456789abcdef", name: "工艺手册.md", text: "喷嘴温度过高会拉丝。", createdAt: 1788652800000, expiresAt: 4102444800000 }],
        });
      }
      if (route === "POST /api/v1/knowledge/search") {
        return json(res, 200, {
          question: body.question,
          docCount: 1,
          hits: [{ name: "工艺手册.md", text: "喷嘴温度过高会拉丝。", score: 1.234 }],
        });
      }
      if (route === "GET /api/v1/calibrations") {
        return json(res, 200, {
          format: "forgex-calibration-catalog",
          version: 1,
          items: [{ id: "b", revision: 1, digest: "e".repeat(64), bundle: { format: "forgex-calibration-bundle" }, approvedAt: 1, approvedBy: "22222222" }],
        });
      }
      if (route === "GET /api/v1/calibrations/stats") return json(res, 200, { approved: 3, pending: 1 });
      if (route === "GET /api/v1/calibrations/submissions") {
        return json(res, 200, { submissions: [{ key: "b@2", id: "b", revision: 2, status: "pending" }] });
      }
      if (route === "POST /api/v1/calibrations/submissions") {
        return json(res, 201, {
          id: "b",
          revision: 2,
          status: "pending",
          digest: "f".repeat(64),
          submittedBy: req.headers["x-forgex-actor-key-id"],
        });
      }
      if (route === "POST /api/v1/calibrations/b/revisions/2/review") {
        return problem(res, 409, "calibration_conflict", "该提交已经完成审核");
      }
      json(res, 501, { error: "unexpected sidecar request: " + route });
    });
  });
  return { server, observed };
}

async function main() {
  /* ── [1] 配置校验 ─────────────────────────────────────────────── */
  console.log("[1] 三开关配置校验");
  check(
    "DATASOURCES_AUTHORITY 取值非法被拒绝",
    /DATASOURCES_AUTHORITY must be node or csharp/.test(
      throwsMessage(() => getConfig({ datasourcesAuthority: "maybe", gcodeAuthorityUrl: "" })) || ""
    )
  );
  check(
    "KNOWLEDGE_AUTHORITY=csharp 缺 GCODE_AUTHORITY_URL 被拒绝",
    /GCODE_AUTHORITY_URL/.test(
      throwsMessage(() => getConfig({ knowledgeAuthority: "csharp", gcodeAuthorityUrl: "" })) || ""
    )
  );
  check(
    "CALIBRATION_GOVERNANCE_AUTHORITY=csharp 缺内部信任密钥被拒绝",
    /GCODE_AUTHORITY_INTERNAL_SECRET/.test(
      throwsMessage(() =>
        getConfig({
          calibrationGovernanceAuthority: "csharp",
          gcodeAuthorityUrl: "http://127.0.0.1:1",
          gcodeAuthorityInternalSecret: "",
        })
      ) || ""
    )
  );
  const parsed = getConfig({
    datasourcesAuthority: " CSHARP ",
    knowledgeAuthority: "node",
    calibrationGovernanceAuthority: "csharp",
    gcodeAuthorityUrl: "http://127.0.0.1:1",
    gcodeAuthorityInternalSecret: INTERNAL_SECRET,
    resourceAuthorityTimeoutMs: "0",
  });
  check(
    "开关规范化与超时下限",
    parsed.datasourcesAuthority === "csharp" && parsed.knowledgeAuthority === "node" &&
      parsed.calibrationGovernanceAuthority === "csharp" && parsed.resourceAuthorityTimeoutMs === 1,
    JSON.stringify([parsed.datasourcesAuthority, parsed.knowledgeAuthority, parsed.resourceAuthorityTimeoutMs])
  );

  const sidecar = createFakeSidecar();
  const sidecarOrigin = `http://127.0.0.1:${await listen(sidecar.server)}`;
  const csv = "machine,material,status,duration_min\nM1,PLA,success,42\nM2,ABS,fail,55\n";

  /* ── [2] 默认 node 模式 ────────────────────────────────────────── */
  console.log("[2] 默认 node 模式：sidecar 零调用");
  const nodeApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: "",
    datasourcesAuthority: "node",
    knowledgeAuthority: "node",
    calibrationGovernanceAuthority: "node",
    gcodeAuthorityUrl: sidecarOrigin,
    gcodeAuthorityInternalSecret: INTERNAL_SECRET,
  });
  const nodeBase = `http://127.0.0.1:${await listen(nodeApp.server)}`;
  try {
    const upload = await fetch(nodeBase + "/api/datasource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv, name: "jobs.csv" }),
    });
    const knowledge = await fetch(nodeBase + "/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "喷嘴温度过高会拉丝。" }),
    });
    const catalog = await fetch(nodeBase + "/api/calibrations");
    await Promise.all([upload.json(), knowledge.json(), catalog.json()]);
    check(
      "三条腿本地完成，sidecar 未被调用",
      upload.status === 201 && knowledge.status === 201 && catalog.status === 200 && sidecar.observed.length === 0,
      JSON.stringify([upload.status, knowledge.status, catalog.status, sidecar.observed.length])
    );
  } finally {
    await nodeApp.close();
  }

  /* ── [3] csharp 模式 ──────────────────────────────────────────── */
  console.log("[3] csharp 模式：可信通道转发");
  const csharpApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: "",
    apiKeys: ALPHA_KEY,
    calibrationReviewKeys: REVIEW_KEY,
    datasourcesAuthority: "csharp",
    knowledgeAuthority: "csharp",
    calibrationGovernanceAuthority: "csharp",
    gcodeAuthorityUrl: sidecarOrigin,
    gcodeAuthorityInternalSecret: INTERNAL_SECRET,
  });
  const base = `http://127.0.0.1:${await listen(csharpApp.server)}`;
  const anonymousTenant = opaque("tn_", "ip:127.0.0.1");
  const anonymousOwner = opaque("ow_", "ip:127.0.0.1");
  const last = () => sidecar.observed.at(-1);
  try {
    // 数据源上传
    sidecar.observed.length = 0;
    const upload = await fetch(base + "/api/datasource", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "session-probe=1" },
      body: JSON.stringify({ csv, name: "jobs.csv", provenance: { synthetic: true, badge: "仿真" } }),
    });
    const uploadBody = await upload.json();
    const uploadSeen = last();
    check(
      "上传转发到 /api/v1/datasources 并携带匿名化 tenant/owner",
      upload.status === 201 && uploadSeen && uploadSeen.url === "/api/v1/datasources" &&
        uploadSeen.headers["x-forgex-internal-token"] === INTERNAL_SECRET &&
        uploadSeen.headers["x-forgex-tenant-id"] === anonymousTenant &&
        uploadSeen.headers["x-forgex-owner-id"] === anonymousOwner &&
        !uploadSeen.headers.cookie && !uploadSeen.headers.authorization,
      JSON.stringify(uploadSeen && uploadSeen.headers)
    );
    check(
      "上传请求体原样转发（csv / name / provenance）",
      uploadSeen && uploadSeen.body && uploadSeen.body.csv === csv && uploadSeen.body.name === "jobs.csv" &&
        uploadSeen.body.provenance && uploadSeen.body.provenance.synthetic === true,
      JSON.stringify(uploadSeen && uploadSeen.body)
    );
    let deepEqual = true;
    try {
      require("assert").deepStrictEqual(uploadBody, {
        datasourceId: DS_ID,
        name: "jobs.csv",
        rows: 2,
        sha256: "b".repeat(64),
        deduplicated: false,
        provenance: PROVENANCE,
      });
    } catch {
      deepEqual = false;
    }
    check("上传响应与 sidecar 返回深相等（201）", deepEqual, JSON.stringify(uploadBody));

    const before = sidecar.observed.length;
    const emptyCsv = await fetch(base + "/api/datasource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: "" }),
    });
    const emptyBody = await emptyCsv.json();
    check(
      "csv 为空由 Node 本地 400，不转发",
      emptyCsv.status === 400 && emptyBody.error === "csv 字段不能为空" && sidecar.observed.length === before,
      JSON.stringify(emptyBody)
    );

    const invalid = await fetch(base + "/api/datasource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: "machine,material\n" }),
    });
    const invalidBody = await invalid.json();
    check(
      "C# 400 problem 映射为 Node {error: title}",
      invalid.status === 400 && invalidBody.error === "CSV 解析失败：x",
      JSON.stringify(invalidBody)
    );

    // 分析：数据源与知识列表都从 C# 读取
    sidecar.observed.length = 0;
    const analyze = await fetch(base + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasourceId: DS_ID, question: "哪台机器失败率最高？" }),
    });
    const analyzeBody = await analyze.json();
    const urls = sidecar.observed.map((item) => item.method + " " + item.url);
    check(
      "分析读取 C# 数据源与知识列表",
      analyze.status === 202 && urls.includes("GET /api/v1/datasources/" + DS_ID) && urls.includes("GET /api/v1/knowledge"),
      JSON.stringify([analyze.status, urls, analyzeBody])
    );
    if (analyze.status === 202) {
      const deadline = Date.now() + 5000;
      let result = null;
      let resultStatus = 0;
      while (Date.now() < deadline) {
        const poll = await fetch(base + "/api/analyze/" + analyzeBody.taskId + "/result");
        resultStatus = poll.status;
        result = await poll.json();
        if (poll.status !== 202) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      check(
        "规则引擎在 C# 返回的行数据上完成分析",
        resultStatus === 200 && result && result.rowCount === SAMPLE_ROWS.length,
        JSON.stringify({ resultStatus, rowCount: result && result.rowCount, error: result && result.error })
      );
    }
    const missing = await fetch(base + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasourceId: DS_MISSING, question: "x" }),
    });
    const missingBody = await missing.json();
    check(
      "C# 404 → 数据源不存在或已过期，请重新上传",
      missing.status === 404 && missingBody.error === "数据源不存在或已过期，请重新上传",
      JSON.stringify(missingBody)
    );
    const unsafeBefore = sidecar.observed.length;
    const unsafe = await fetch(base + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datasourceId: "../etc/passwd", question: "x" }),
    });
    await unsafe.json();
    check("非法 datasourceId 本地 404，不转发", unsafe.status === 404 && sidecar.observed.length === unsafeBefore, unsafe.status);

    // 知识库
    sidecar.observed.length = 0;
    const kb = await fetch(base + "/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "喷嘴温度过高会拉丝。", name: "工艺手册.md" }),
    });
    const kbBody = await kb.json();
    const kbSeen = last();
    check(
      "知识登记转发到 /api/v1/knowledge，Node 补 retrievalEnabled/note",
      kb.status === 201 && kbSeen && kbSeen.url === "/api/v1/knowledge" && kbSeen.method === "POST" &&
        kbSeen.headers["x-forgex-tenant-id"] === anonymousTenant &&
        kbBody.knowledgeId === "kb_0123456789abcdef" && kbBody.name === "工艺手册.md" &&
        kbBody.chunks === "喷嘴温度过高会拉丝。".length && kbBody.retrievalEnabled === false &&
        typeof kbBody.note === "string" && kbBody.note.includes("当前配置下不会被使用"),
      JSON.stringify(kbBody)
    );
    const search = await fetch(base + "/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "  喷嘴温度 ", topK: "1" }),
    });
    const searchBody = await search.json();
    const searchSeen = last();
    check(
      "检索转发到 /api/v1/knowledge/search 且响应透传",
      search.status === 200 && searchSeen && searchSeen.url === "/api/v1/knowledge/search" &&
        searchSeen.body.question === "喷嘴温度" && searchSeen.body.topK === "1" &&
        searchBody.docCount === 1 && searchBody.hits.length === 1 && searchBody.hits[0].score === 1.234 &&
        searchBody.question === "喷嘴温度",
      JSON.stringify([searchSeen && searchSeen.body, searchBody])
    );
    const emptyQuestionBefore = sidecar.observed.length;
    const emptyQuestion = await fetch(base + "/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "   " }),
    });
    const emptyQuestionBody = await emptyQuestion.json();
    check(
      "question 为空由 Node 本地 400，不转发",
      emptyQuestion.status === 400 && emptyQuestionBody.error === "question 不能为空" &&
        sidecar.observed.length === emptyQuestionBefore,
      JSON.stringify(emptyQuestionBody)
    );

    // 校准治理
    sidecar.observed.length = 0;
    const catalog = await fetch(base + "/api/calibrations");
    const catalogBody = await catalog.json();
    const catalogSeen = last();
    check(
      "公开目录转发 /api/v1/calibrations 且不携带内部令牌",
      catalog.status === 200 && catalogSeen && catalogSeen.url === "/api/v1/calibrations" &&
        !catalogSeen.headers["x-forgex-internal-token"] && !catalogSeen.headers["x-forgex-tenant-id"] &&
        catalogBody.format === "forgex-calibration-catalog" && catalogBody.version === 1 &&
        catalogBody.items.length === 1 && catalogBody.items[0].id === "b",
      JSON.stringify([catalogSeen && catalogSeen.headers, catalogBody])
    );
    const anonymousSubmitBefore = sidecar.observed.length;
    const anonymousSubmit = await fetch(base + "/api/calibrations/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundle: {} }),
    });
    const anonymousSubmitBody = await anonymousSubmit.json();
    check(
      "无 key 提交由 Node 401，不转发",
      anonymousSubmit.status === 401 && anonymousSubmitBody.error === "校准候选提交需要有效 API Key" &&
        sidecar.observed.length === anonymousSubmitBefore,
      JSON.stringify(anonymousSubmitBody)
    );
    const submit = await fetch(base + "/api/calibrations/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + ALPHA_KEY },
      body: JSON.stringify({ bundle: { format: "forgex-calibration-bundle", id: "b", revision: 2 }, note: "n" }),
    });
    const submitBody = await submit.json();
    const submitSeen = last();
    const alphaId = keyId(ALPHA_KEY);
    check(
      "submitter 提交转发并携带 actor 头与 key 派生 tenant",
      submit.status === 201 && submitSeen && submitSeen.url === "/api/v1/calibrations/submissions" &&
        submitSeen.headers["x-forgex-actor-key-id"] === alphaId &&
        submitSeen.headers["x-forgex-actor-role"] === "submitter" &&
        submitSeen.headers["x-forgex-tenant-id"] === opaque("tn_", "key:" + alphaId) &&
        submitSeen.headers["x-forgex-owner-id"] === opaque("ow_", "key:" + alphaId) &&
        submitSeen.headers["x-forgex-internal-token"] === INTERNAL_SECRET && !submitSeen.headers.authorization &&
        submitSeen.body.bundle.id === "b" && submitSeen.body.note === "n" &&
        submitBody.id === "b" && submitBody.revision === 2 && submitBody.status === "pending" &&
        submitBody.digest === "f".repeat(64) && submitBody.submittedBy === alphaId,
      JSON.stringify([submitSeen && submitSeen.headers, submitBody])
    );
    const plainList = await fetch(base + "/api/calibrations/submissions", {
      headers: { Authorization: "Bearer " + ALPHA_KEY },
    });
    const plainListBody = await plainList.json();
    check(
      "普通 key 查看审批队列由 Node 403",
      plainList.status === 403 && plainListBody.error === "当前凭据没有校准审核权限",
      JSON.stringify(plainListBody)
    );
    const list = await fetch(base + "/api/calibrations/submissions", {
      headers: { "X-API-Key": REVIEW_KEY },
    });
    const listBody = await list.json();
    const listSeen = last();
    const reviewId = keyId(REVIEW_KEY);
    check(
      "reviewer 列表转发并携带 reviewer actor 头",
      list.status === 200 && listSeen && listSeen.url === "/api/v1/calibrations/submissions" && listSeen.method === "GET" &&
        listSeen.headers["x-forgex-actor-key-id"] === reviewId && listSeen.headers["x-forgex-actor-role"] === "reviewer" &&
        listSeen.headers["x-forgex-tenant-id"] === opaque("tn_", "key:" + reviewId) &&
        listBody.submissions.length === 1 && listBody.submissions[0].key === "b@2",
      JSON.stringify([listSeen && listSeen.headers, listBody])
    );
    const review = await fetch(base + "/api/calibrations/b/revisions/2/review", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + REVIEW_KEY },
      body: JSON.stringify({ decision: "approve", reason: "Holdout metrics reviewed carefully." }),
    });
    const reviewBody = await review.json();
    const reviewSeen = last();
    check(
      "审核转发到 /api/v1/calibrations/b/revisions/2/review，C# 409 原样透传",
      review.status === 409 && reviewBody.error === "该提交已经完成审核" && reviewSeen &&
        reviewSeen.url === "/api/v1/calibrations/b/revisions/2/review" &&
        reviewSeen.headers["x-forgex-actor-role"] === "reviewer" && reviewSeen.body.decision === "approve",
      JSON.stringify([reviewSeen && reviewSeen.url, reviewBody])
    );

    // healthz / metrics
    const health = await fetch(base + "/healthz");
    const healthBody = await health.json();
    check(
      "/healthz 的 calibrations 统计来自 C# /api/v1/calibrations/stats",
      health.status === 200 && healthBody.ok === true && healthBody.calibrations.approved === 3 &&
        healthBody.calibrations.pending === 1 && healthBody.calibrations.writesEnabled === true,
      JSON.stringify(healthBody.calibrations)
    );
    const metrics = await fetch(base + "/metrics");
    const metricsText = await metrics.text();
    check(
      "/metrics：Node 本地存储 gauge 为 0，校准统计取自 C#",
      metrics.status === 200 && metricsText.includes("forgex_datasources 0\n") &&
        metricsText.includes("forgex_knowledge_docs 0\n") && metricsText.includes("forgex_calibrations_approved 3\n") &&
        metricsText.includes("forgex_calibrations_pending 1\n"),
      metricsText.split("\n").filter((line) => line.startsWith("forgex_datasources") || line.startsWith("forgex_calibrations")).join(" | ")
    );
  } finally {
    await csharpApp.close();
  }

  /* ── [4] sidecar 不可达 ───────────────────────────────────────── */
  console.log("[4] sidecar 不可达 → 502");
  const closedProbe = http.createServer();
  const closedPort = await listen(closedProbe);
  await close(closedProbe);
  const downApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: "",
    apiKeys: ALPHA_KEY,
    datasourcesAuthority: "csharp",
    knowledgeAuthority: "csharp",
    calibrationGovernanceAuthority: "csharp",
    gcodeAuthorityUrl: `http://127.0.0.1:${closedPort}`,
    gcodeAuthorityInternalSecret: INTERNAL_SECRET,
  });
  const downBase = `http://127.0.0.1:${await listen(downApp.server)}`;
  try {
    const upload = await fetch(downBase + "/api/datasource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv }),
    });
    const uploadBody = await upload.json();
    check("数据源 502 文案", upload.status === 502 && uploadBody.error === "数据源服务暂不可用，请稍后再试", JSON.stringify(uploadBody));
    const kb = await fetch(downBase + "/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    const kbBody = await kb.json();
    check("知识库 502 文案", kb.status === 502 && kbBody.error === "知识库服务暂不可用，请稍后再试", JSON.stringify(kbBody));
    const catalog = await fetch(downBase + "/api/calibrations");
    const catalogBody = await catalog.json();
    check("校准 502 文案", catalog.status === 502 && catalogBody.error === "校准服务暂不可用，请稍后再试", JSON.stringify(catalogBody));
    const submit = await fetch(downBase + "/api/calibrations/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + ALPHA_KEY },
      body: JSON.stringify({ bundle: {} }),
    });
    const submitBody = await submit.json();
    check("已鉴权提交在 sidecar 不可达时 502", submit.status === 502 && submitBody.error === "校准服务暂不可用，请稍后再试", JSON.stringify(submitBody));
    const health = await fetch(downBase + "/healthz");
    const healthBody = await health.json();
    check(
      "/healthz 报告 persistence_unavailable",
      health.status === 503 && healthBody.ok === false && healthBody.error === "persistence_unavailable",
      JSON.stringify(healthBody)
    );
  } finally {
    await downApp.close();
  }

  await close(sidecar.server);

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  // 不用 process.exit()：让 undici keep-alive 套接字自然收尾（同 auth-authority）。
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
