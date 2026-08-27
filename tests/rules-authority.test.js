/* Stage 8.3 规则计算腿权威切流（RULES_ENGINE_AUTHORITY=node|csharp）集成测试。
 *
 * 用 node:http 起一个假 C# sidecar，按 backend/src/ForgeX.Api/RulesEngineEndpoints.cs 与
 * backend/src/ForgeX.Contracts/RulesEngineContracts.cs 仿真 5 个端点（dataset normalize/meta/farm、
 * brief、calibration validate），并记录收到的请求（方法 / 路径 / 请求头 / 请求体）供断言。
 *
 * 覆盖四类场景：
 *   [1] 配置校验：RULES_ENGINE_AUTHORITY / RULES_ENGINE_TIMEOUT_MS 的默认值、归一化、
 *       非法取值与「csharp 模式缺 GCODE_AUTHORITY_URL」的报错文案；
 *   [2] csharp 边界直连：normalizeCsv/meta/farm/buildBrief/validateBundle 五个方法的
 *       HTTP 请求形状（方法、路径、请求体、请求头）与响应消费（逐字段核对）、farm/meta 记忆化；
 *   [3] csharp 消费链路端到端：datasource 种子/create、calibration 提交、
 *       分析任务（openai provider 经 brief→提示词）全部经假 sidecar 打通；
 *   [4] 默认 node 模式：不设开关时假 sidecar 收到 0 个请求，行为与 classic 规则腿逐项一致；
 *   [5] 错误路径：非 2xx、信封契约损坏、各端点响应形状损坏、非 JSON、超时、失败不缓存。
 */
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");

const { createApp } = require("../server/index");
const { getConfig } = require("../server/config");
const { createRulesEngine } = require("../server/services/rules-engine");
const localEngine = require("../server/services/local-engine");
const { buildBrief: classicBuildBrief } = require("../server/services/brief");
const { validateBundle: classicValidateBundle } = require("../server/services/calibration");

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

function deepEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch (e) {
    return false;
  }
}

/** 执行同步函数并返回其抛出的错误消息（未抛错返回 null）。 */
function throwsMessage(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
}

/** 执行异步函数并返回其 reject 的错误（未失败返回 null）。 */
async function rejectedWith(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── 假 C# sidecar 的固定响应（形状对齐 RulesEngineContracts.cs） ────────────
   数值刻意与 classic 规则腿不同（minSample=7、独有的行/文案），
   这样「响应被正确消费」的断言不可能靠 node 本地计算碰巧通过。 */

const FAKE_ENGINE = { name: "forgex-analytics-csharp", version: "9.9.9-test" };
const FAKE_CATALOG = {
  farm: {
    source: "sim-farm",
    synthetic: true,
    badge: "假机群",
    note: "fake sidecar farm provenance",
    generator: { name: "fake-sidecar", version: 1, seed: 42 },
  },
  upload: {
    source: "user-upload",
    synthetic: false,
    badge: "假上传",
    note: "fake sidecar upload provenance",
    generator: null,
  },
};
const FAKE_FARM_ROWS = [
  {
    job_id: "CS-J1", date: "2026-08-01", machine_id: "CS-01", model_name: "benchy", material: "PLA",
    layer_height_mm: 0.2, duration_min: 100, filament_g: 40, cost_fen: 900,
    status: "success", fail_reason: null, energy_kwh: 0.5,
  },
  {
    job_id: "CS-J2", date: "2026-08-02", machine_id: "CS-02", model_name: "vase", material: "PETG",
    layer_height_mm: 0.28, duration_min: 60, filament_g: 25, cost_fen: 700,
    status: "fail", fail_reason: "翘边", energy_kwh: 0.3,
  },
];
const FAKE_FARM_CSV = "job_id,date\nCS-J1,2026-08-01\nCS-J2,2026-08-02";
const FAKE_FIELDS = [
  "job_id", "date", "machine_id", "model_name", "material",
  "layer_height_mm", "duration_min", "filament_g", "cost_fen",
  "status", "fail_reason", "energy_kwh",
];
const FAKE_MIN_SAMPLE = 7;
const FAKE_NORMALIZED = {
  rows: [
    {
      job_id: "N-1", date: "2026-08-03", machine_id: "CS-03", model_name: "cube", material: "ABS",
      layer_height_mm: 0.2, duration_min: 30, filament_g: 10, cost_fen: 300,
      status: "success", fail_reason: null, energy_kwh: 0.2,
    },
  ],
  errors: ["第 3 行：filament_g 不是有效数值（abc）"],
  csv: "job_id,date\nN-1,2026-08-03",
};
const FAKE_BRIEF = { text: "## 假简报正文：仅供契约测试", facts: { rowCount: 2, fake: true } };
const FAKE_VALIDATE = { ok: true, errors: [] };

function createFakeSidecar() {
  const observed = [];
  const held = [];
  const state = { behave: null, validate: FAKE_VALIDATE };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch (e) {
        // 保留 raw 供断言，非 JSON 请求体不该出现在正常路径
      }
      const record = { method: req.method, url: req.url, headers: req.headers, raw, body };
      observed.push(record);
      if (state.behave && state.behave(req, res, record)) return;

      const json = (payload) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const envelope = { schemaVersion: "1.0", engine: FAKE_ENGINE };
      if (req.method === "GET" && req.url === "/api/v1/analytics/datasets/farm") {
        return json({ ...envelope, csv: FAKE_FARM_CSV, rows: FAKE_FARM_ROWS, provenance: FAKE_CATALOG.farm });
      }
      if (req.method === "GET" && req.url === "/api/v1/analytics/datasets/meta") {
        return json({ ...envelope, fields: FAKE_FIELDS, minSample: FAKE_MIN_SAMPLE, provenance: FAKE_CATALOG });
      }
      if (req.method === "POST" && req.url === "/api/v1/analytics/datasets/normalize") {
        return json({ ...envelope, rows: FAKE_NORMALIZED.rows, errors: FAKE_NORMALIZED.errors, csv: FAKE_NORMALIZED.csv });
      }
      if (req.method === "POST" && req.url === "/api/v1/analytics/briefs") {
        return json({ ...envelope, text: FAKE_BRIEF.text, facts: FAKE_BRIEF.facts });
      }
      if (req.method === "POST" && req.url === "/api/v1/calibration/validate") {
        return json({ ...envelope, ok: state.validate.ok, errors: state.validate.errors });
      }
      // csharp 模式下 engine.analyze 复用 providers.js 的 reports 通道（契约见 csharpAnalyticsProvider）
      if (req.method === "POST" && req.url === "/api/v1/analytics/reports") {
        const rows = (body && body.rows) || [];
        return json({
          schemaVersion: "1.0",
          engine: FAKE_ENGINE,
          report: {
            schemaVersion: 1, title: "权威报告", verdict: "假 sidecar 权威结论", confidence: "high",
            sections: [], chart: null, evidence: [], intent: "overview", intentMatched: false,
            rowCount: rows.length, engine: "local-rules", provenance: null, highlight: null,
          },
        });
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"unknown endpoint"}');
    });
  });
  return {
    server,
    observed,
    held,
    state,
    count(url) {
      return observed.filter((record) => record.url === url).length;
    },
    find(url) {
      return observed.find((record) => record.url === url);
    },
    close() {
      return new Promise((resolve) => {
        server.close(resolve);
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      });
    },
  };
}

/** 能通过 classic 校准验证的候选 bundle（与 tests/calibration-service.test.js 同源）。 */
function candidate(id, revision) {
  return {
    format: "forgex-calibration-bundle",
    version: 1,
    id: id || "rules-authority",
    revision: revision || 1,
    createdAt: "2026-07-28T00:00:00Z",
    provenance: "real-anonymized",
    source: {
      license: "CC-BY-4.0",
      note: "Anonymized production pairs submitted for independent calibration review.",
    },
    models: [
      {
        id: (id || "rules-authority") + "-pla",
        status: "candidate",
        scope: { machineId: "FX-P8-01", firmware: "Klipper 0.12", material: "PLA" },
        algorithm: "theil-sen",
        trainedAt: "2026-07-28T00:00:00Z",
        coefficients: { motionScale: 1.18, fixedOverheadSec: 80, sampleCount: 12 },
        validation: {
          holdoutSamples: 6,
          mape: 0.08,
          maxApe: 0.16,
          medianBias: 0.02,
          evaluatedAt: "2026-07-28T00:00:00Z",
        },
        thresholds: { maxMape: 0.2, maxBias: 0.12, minDriftSamples: 5 },
        trainingSetSha256: "c".repeat(64),
      },
    ],
  };
}

const MISSING_URL_MESSAGE = "RULES_ENGINE_AUTHORITY=csharp 需要先配置 GCODE_AUTHORITY_URL（共用同一 C# sidecar）";

async function main() {
  // 隔离环境：本测试断言「默认值」，不能被 shell 导出的开关污染；结束后原样恢复。
  const ENV_KEYS = ["RULES_ENGINE_AUTHORITY", "RULES_ENGINE_TIMEOUT_MS"];
  const savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  try {
    /* ══ [1] 配置校验 ═══════════════════════════ */
    console.log("\n[1] 配置校验（RULES_ENGINE_AUTHORITY / RULES_ENGINE_TIMEOUT_MS）");

    const defaults = getConfig({ gcodeAuthorityUrl: "" });
    check("默认 node 模式与 30s 超时", defaults.rulesEngineAuthority === "node" && defaults.rulesEngineTimeoutMs === 30000);
    check("默认配置产出 node 引擎", createRulesEngine({ config: defaults }).mode === "node");
    check(
      "csharp 模式缺 GCODE_AUTHORITY_URL 时抛错（文案对齐实现）",
      throwsMessage(() => getConfig({ rulesEngineAuthority: "csharp", gcodeAuthorityUrl: "" })) === MISSING_URL_MESSAGE
    );
    check(
      "非法取值被拒绝",
      throwsMessage(() => getConfig({ rulesEngineAuthority: "java", gcodeAuthorityUrl: "" })) ===
        "RULES_ENGINE_AUTHORITY must be node or csharp"
    );
    const normalizedCfg = getConfig({ rulesEngineAuthority: " CSHARP ", gcodeAuthorityUrl: "http://127.0.0.1:1" });
    check("大小写与空白被归一化为 csharp", normalizedCfg.rulesEngineAuthority === "csharp");
    check("csharp 配置产出 csharp 引擎", createRulesEngine({ config: normalizedCfg }).mode === "csharp");

    process.env.RULES_ENGINE_AUTHORITY = "csharp";
    process.env.RULES_ENGINE_TIMEOUT_MS = "1234";
    try {
      check(
        "环境变量开关生效且缺 URL 同样抛错",
        throwsMessage(() => getConfig({ gcodeAuthorityUrl: "" })) === MISSING_URL_MESSAGE
      );
      const fromEnv = getConfig({ gcodeAuthorityUrl: "http://127.0.0.1:1" });
      check("环境变量超时生效", fromEnv.rulesEngineAuthority === "csharp" && fromEnv.rulesEngineTimeoutMs === 1234);
    } finally {
      delete process.env.RULES_ENGINE_AUTHORITY;
      delete process.env.RULES_ENGINE_TIMEOUT_MS;
    }

    /* ══ [2] csharp 边界直连：五个方法的请求/响应契约 ═══════ */
    console.log("\n[2] csharp 模式：五个端点的请求/响应契约");
    const sidecar = createFakeSidecar();
    const origin = "http://127.0.0.1:" + (await listen(sidecar.server));
    const csharpCfg = getConfig({ rulesEngineAuthority: "csharp", gcodeAuthorityUrl: origin, dataDir: "" });
    const engine = createRulesEngine({ config: csharpCfg });
    check("工厂按配置产出 csharp 引擎", engine.mode === "csharp");

    const farm = await engine.farm();
    const farmReq = sidecar.find("/api/v1/analytics/datasets/farm");
    check("farm：GET 假 sidecar 且无请求体", farmReq && farmReq.method === "GET" && farmReq.raw === "");
    check("farm：Accept application/json", farmReq && farmReq.headers.accept === "application/json");
    check(
      "farm：csv/rows/provenance 逐项消费",
      farm.csv === FAKE_FARM_CSV && deepEqual(farm.rows, FAKE_FARM_ROWS) && deepEqual(farm.provenance, FAKE_CATALOG.farm)
    );
    await engine.farm();
    check("farm：不变量记忆化，只取一次", sidecar.count("/api/v1/analytics/datasets/farm") === 1);

    const meta = await engine.meta();
    check(
      "meta：GET 且 fields/minSample/provenance 逐项消费",
      sidecar.count("/api/v1/analytics/datasets/meta") === 1 &&
        deepEqual(meta.fields, FAKE_FIELDS) &&
        meta.minSample === FAKE_MIN_SAMPLE &&
        deepEqual(meta.provenance, FAKE_CATALOG)
    );
    await engine.meta();
    check("meta：不变量记忆化，只取一次", sidecar.count("/api/v1/analytics/datasets/meta") === 1);

    const normalized = await engine.normalizeCsv("job_id,date\nU-1,2026-08-05");
    const normalizeReq = sidecar.find("/api/v1/analytics/datasets/normalize");
    check(
      "normalizeCsv：POST + JSON 请求头",
      normalizeReq && normalizeReq.method === "POST" &&
        String(normalizeReq.headers["content-type"] || "").includes("application/json")
    );
    check(
      "normalizeCsv：请求体 {schemaVersion, csvText}",
      normalizeReq && deepEqual(normalizeReq.body, { schemaVersion: "1.0", csvText: "job_id,date\nU-1,2026-08-05" })
    );
    check("normalizeCsv：rows/errors/csv 逐项消费", deepEqual(normalized, FAKE_NORMALIZED));
    await engine.normalizeCsv(null);
    const nullNormalizeReq = sidecar.observed.filter((r) => r.url === "/api/v1/analytics/datasets/normalize")[1];
    check("normalizeCsv：null 入参按空串发送", nullNormalizeReq && nullNormalizeReq.body.csvText === "");

    const brief = await engine.buildBrief(FAKE_FARM_ROWS);
    const briefReq = sidecar.find("/api/v1/analytics/briefs");
    check(
      "buildBrief：POST 请求体 {schemaVersion, rows}",
      briefReq && briefReq.method === "POST" &&
        briefReq.body.schemaVersion === "1.0" && deepEqual(briefReq.body.rows, FAKE_FARM_ROWS)
    );
    check("buildBrief：text/facts 逐项消费", brief.text === FAKE_BRIEF.text && deepEqual(brief.facts, FAKE_BRIEF.facts));

    const boundaryBundle = candidate("cs-boundary", 1);
    const validated = await engine.validateBundle(boundaryBundle);
    const validateReq = sidecar.find("/api/v1/calibration/validate");
    check(
      "validateBundle：POST 请求体 {schemaVersion, bundle}",
      validateReq && validateReq.method === "POST" &&
        validateReq.body.schemaVersion === "1.0" && deepEqual(validateReq.body.bundle, boundaryBundle)
    );
    check("validateBundle：ok/errors 逐项消费", validated.ok === true && deepEqual(validated.errors, []));
    await sidecar.close();

    /* ══ [3] csharp 消费链路端到端 ═══════════════ */
    console.log("\n[3] csharp 模式：消费链路端到端（datasource / calibration / brief→AI 提示词）");
    const sidecar2 = createFakeSidecar();
    const origin2 = "http://127.0.0.1:" + (await listen(sidecar2.server));

    // 假 OpenAI 兼容端点：openaiProvider 是 buildBrief 的真实消费方（简报→提示词）
    const openaiRequests = [];
    const narrative = { title: "假AI标题", verdict: "假AI结论", sections: [{ h: "小节", lines: ["要点"] }] };
    const openai = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        openaiRequests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(narrative) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
      });
    });
    const openaiPort = await listen(openai);

    const app = createApp({
      rulesEngineAuthority: "csharp",
      gcodeAuthorityUrl: origin2,
      providerPref: "openai",
      openaiKey: "test-key",
      openaiModel: "fake-model",
      openaiBaseUrl: `http://127.0.0.1:${openaiPort}`,
      probeProvider: false,
      rateLimitMs: 0,
      logLevel: "error",
      dataDir: "",
    });
    try {
      check("app 单例引擎为 csharp 模式", app.ctx.rulesEngine.mode === "csharp");

      const sample = await app.ctx.datasources.get("sample");
      check(
        "datasource 种子：内置 sample 来自 sidecar farm 端点",
        sidecar2.count("/api/v1/analytics/datasets/farm") === 1 &&
          sample && sample.csv === FAKE_FARM_CSV &&
          deepEqual(sample.rows, FAKE_FARM_ROWS) && deepEqual(sample.provenance, FAKE_CATALOG.farm)
      );
      check(
        "datasource 种子：内容摘要按 sidecar csv 计算",
        sample.contentSha256 === crypto.createHash("sha256").update(FAKE_FARM_CSV).digest("hex")
      );

      const created = await app.ctx.datasources.create("upload.csv", "raw,csv,text", null, "user:test");
      check(
        "datasource create：normalize + meta 都走 sidecar",
        sidecar2.count("/api/v1/analytics/datasets/normalize") === 1 && sidecar2.count("/api/v1/analytics/datasets/meta") === 1
      );
      check(
        "datasource create：行/告警/规范化 csv 来自 sidecar 响应",
        deepEqual(created.rows, FAKE_NORMALIZED.rows) &&
          deepEqual(created.warnings, FAKE_NORMALIZED.errors) &&
          created.csv === FAKE_NORMALIZED.csv
      );
      check("datasource create：provenance 兜底取自 sidecar meta 目录", deepEqual(created.provenance, FAKE_CATALOG.upload));

      const submitted = await app.ctx.calibrations.submit(candidate("cs-e2e", 1), "reviewer-a", "csharp e2e submit");
      const validateReq2 = sidecar2.find("/api/v1/calibration/validate");
      check(
        "calibration 提交：验证请求携带完整 bundle 并进入 pending",
        submitted.status === "pending" && validateReq2 && deepEqual(validateReq2.body.bundle, candidate("cs-e2e", 1))
      );

      sidecar2.state.validate = { ok: false, errors: ["假 sidecar 判定：模型 holdout 不达标"] };
      const submitError = await rejectedWith(() =>
        app.ctx.calibrations.submit(candidate("cs-e2e-bad", 1), "reviewer-a", "rejected by sidecar")
      );
      check(
        "calibration 提交：sidecar 验证失败转为 HTTP 400 且文案透传",
        submitError && submitError.status === 400 && submitError.message === "假 sidecar 判定：模型 holdout 不达标"
      );
      sidecar2.state.validate = FAKE_VALIDATE;

      const task = app.ctx.tasks.create("整体失败率如何？", sample, "test-req", { caller: "test" });
      for (let i = 0; i < 400 && task.status === "running"; i++) await sleep(5);
      check("分析任务（openai provider）在 csharp 模式下完成", task.status === "done", task.error || task.status);
      check("统计核走 sidecar reports 端点", sidecar2.count("/api/v1/analytics/reports") === 1);
      const briefReq2 = sidecar2.find("/api/v1/analytics/briefs");
      check("brief 生成走 sidecar briefs 端点且行集为数据源行", briefReq2 && deepEqual(briefReq2.body.rows, FAKE_FARM_ROWS));
      const prompt =
        openaiRequests[0] && openaiRequests[0].body.messages && openaiRequests[0].body.messages[1].content;
      check("sidecar 简报正文进入 AI 提示词", typeof prompt === "string" && prompt.includes(FAKE_BRIEF.text));
      check(
        "AI 叙述与权威统计合并进报告",
        task.report && task.report.title === "假AI标题" && task.report.engine === "openai-compatible"
      );
    } finally {
      await app.close();
      await sidecar2.close();
      await new Promise((resolve) => openai.close(resolve));
    }

    /* ══ [4] 默认 node 模式：零 sidecar 流量，行为与 classic 一致 ═══ */
    console.log("\n[4] 默认 node 模式：零 sidecar 流量，行为与 classic 一致");
    const sidecar3 = createFakeSidecar();
    const origin3 = "http://127.0.0.1:" + (await listen(sidecar3.server));
    delete process.env.RULES_ENGINE_AUTHORITY; // 再删一次：getConfig 可能已从 server/.env 回填
    const nodeApp = createApp({
      gcodeAuthorityUrl: origin3,
      forceMock: true,
      probeProvider: false,
      rateLimitMs: 0,
      logLevel: "error",
      dataDir: "",
    });
    try {
      check("未设 RULES_ENGINE_AUTHORITY 时引擎为 node 模式", nodeApp.ctx.rulesEngine.mode === "node");

      const sample = await nodeApp.ctx.datasources.get("sample");
      check(
        "node 种子：内置 sample 与 classic farm 数据一致",
        sample.csv === localEngine.farmCsv() &&
          deepEqual(sample.rows, localEngine.farmRows()) &&
          deepEqual(sample.provenance, localEngine.PROVENANCE.farm)
      );

      const csvText = [
        "job_id,date,machine_id,model_name,material,layer_height_mm,duration_min,filament_g,cost_fen,status,fail_reason,energy_kwh",
        "J-1,2026-07-01,M-01,benchy,PLA,0.2,120,50,1200,success,,0.8",
        "J-2,2026-07-02,M-02,benchy,PLA,0.2,90,40,1000,fail,adhesion,0.6",
        "J-3,2026-07-03,M-03,vase,PETG,0.28,abc,30,900,success,,0.5",
      ].join("\n");
      const engineOut = await nodeApp.ctx.rulesEngine.normalizeCsv(csvText);
      const classicOut = localEngine.parseCsv(csvText);
      check(
        "node normalizeCsv 与 classic parseCsv/toCsv 一致（含行级告警）",
        deepEqual(engineOut, { rows: classicOut.rows, errors: classicOut.errors, csv: localEngine.toCsv(classicOut.rows) }) &&
          engineOut.errors.length > 0
      );

      const nodeMeta = await nodeApp.ctx.rulesEngine.meta();
      check(
        "node meta 与 classic 契约一致",
        deepEqual(nodeMeta, { fields: localEngine.FIELDS, minSample: localEngine.MIN_SAMPLE, provenance: localEngine.PROVENANCE })
      );

      const nodeBrief = await nodeApp.ctx.rulesEngine.buildBrief(sample.rows);
      check("node buildBrief 与 classic brief 一致", deepEqual(nodeBrief, classicBuildBrief(sample.rows)));

      const nodeBundle = candidate("node-e2e", 1);
      const engineChecked = await nodeApp.ctx.rulesEngine.validateBundle(nodeBundle);
      const classicChecked = classicValidateBundle(nodeBundle);
      check(
        "node validateBundle 与 classic registry 一致",
        deepEqual(engineChecked, { ok: classicChecked.ok, errors: classicChecked.errors }) && engineChecked.ok === true
      );

      const nodeSubmitted = await nodeApp.ctx.calibrations.submit(candidate("node-e2e", 1), "reviewer-a", "node e2e submit");
      const nodeCreated = await nodeApp.ctx.datasources.create("upload.csv", csvText, null, "user:test");
      check(
        "node 消费链路可用（datasource create / calibration 提交）",
        nodeSubmitted.status === "pending" &&
          deepEqual(nodeCreated.rows, classicOut.rows) &&
          deepEqual(nodeCreated.provenance, localEngine.PROVENANCE.upload)
      );

      check("整个 node 流程假 sidecar 收到 0 个请求", sidecar3.observed.length === 0, String(sidecar3.observed.length));
    } finally {
      await nodeApp.close();
      await sidecar3.close();
    }

    /* ══ [5] csharp 错误路径 ═════════════════════ */
    console.log("\n[5] csharp 模式错误路径（预期与 rules-engine.js 实现逐字对齐）");
    const sidecar4 = createFakeSidecar();
    const origin4 = "http://127.0.0.1:" + (await listen(sidecar4.server));
    const errCfg = getConfig({ rulesEngineAuthority: "csharp", gcodeAuthorityUrl: origin4, rulesEngineTimeoutMs: 300, dataDir: "" });
    const freshEngine = () => createRulesEngine({ config: errCfg });
    try {
      sidecar4.state.behave = (req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("boom");
        return true;
      };
      let error = await rejectedWith(() => freshEngine().normalizeCsv("x"));
      check("HTTP 500：抛「状态码 + 响应正文」", error && error.message === "C# rules engine HTTP 500: boom", error && error.message);

      sidecar4.state.behave = (req, res) => {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("x".repeat(500));
        return true;
      };
      error = await rejectedWith(() => freshEngine().buildBrief([]));
      check("HTTP 502：响应正文截断到 240 字符", error && error.message === "C# rules engine HTTP 502: " + "x".repeat(240));

      sidecar4.state.behave = (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ schemaVersion: "2.0", engine: FAKE_ENGINE, rows: [], errors: [], csv: "" }));
        return true;
      };
      error = await rejectedWith(() => freshEngine().normalizeCsv("x"));
      check(
        "schemaVersion 不符：契约错误并带端点路径",
        error && error.message === "C# rules engine response contract is invalid (/api/v1/analytics/datasets/normalize)"
      );

      sidecar4.state.behave = (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ schemaVersion: "1.0", engine: { name: "someone-else", version: "1" }, ok: true, errors: [] }));
        return true;
      };
      error = await rejectedWith(() => freshEngine().validateBundle({}));
      check(
        "engine.name 不符：契约错误并带端点路径",
        error && error.message === "C# rules engine response contract is invalid (/api/v1/calibration/validate)"
      );

      const shapeCases = [
        ["farm", (e) => e.farm(), { csv: 123, rows: FAKE_FARM_ROWS, provenance: FAKE_CATALOG.farm },
          "C# rules engine farm dataset response is invalid"],
        ["meta", (e) => e.meta(), { fields: "nope", minSample: 5, provenance: FAKE_CATALOG },
          "C# rules engine dataset meta response is invalid"],
        ["normalizeCsv", (e) => e.normalizeCsv("x"), { rows: {}, errors: [], csv: "" },
          "C# rules engine normalize response is invalid"],
        ["buildBrief", (e) => e.buildBrief([]), { text: 42, facts: {} },
          "C# rules engine brief response is invalid"],
        ["validateBundle", (e) => e.validateBundle({}), { ok: "yes", errors: [] },
          "C# rules engine calibration validate response is invalid"],
      ];
      for (const [name, run, payload, message] of shapeCases) {
        sidecar4.state.behave = (req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(Object.assign({ schemaVersion: "1.0", engine: FAKE_ENGINE }, payload)));
          return true;
        };
        error = await rejectedWith(() => run(freshEngine()));
        check(`${name} 响应形状损坏：按实现报错`, error && error.message === message, error && error.message);
      }

      sidecar4.state.behave = (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not-json{");
        return true;
      };
      error = await rejectedWith(() => freshEngine().normalizeCsv("x"));
      check("响应非 JSON：response.json() 的解析错误原样上抛", error && error.name === "SyntaxError", error && error.name);

      sidecar4.state.behave = (req, res, record) => {
        sidecar4.held.push({ res, record });
        return true; // 永不响应，逼出 AbortSignal.timeout
      };
      error = await rejectedWith(() => freshEngine().normalizeCsv("x"));
      check("sidecar 无响应：按 rulesEngineTimeoutMs 中止（TimeoutError）", error && error.name === "TimeoutError", error && error.name);
      sidecar4.held.forEach((h) => {
        try {
          h.res.destroy();
        } catch (e) {
          // 客户端中止后连接可能已销毁
        }
      });

      sidecar4.state.behave = (req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("down");
        return true;
      };
      const farmCountBefore = sidecar4.count("/api/v1/analytics/datasets/farm");
      const retryEngine = freshEngine();
      error = await rejectedWith(() => retryEngine.farm());
      check("farm 首次失败：错误上抛", error && error.message === "C# rules engine HTTP 500: down");
      sidecar4.state.behave = null; // sidecar 恢复健康
      const recovered = await retryEngine.farm();
      check(
        "farm 失败不缓存：恢复后同一引擎重试成功",
        recovered.csv === FAKE_FARM_CSV && sidecar4.count("/api/v1/analytics/datasets/farm") === farmCountBefore + 2
      );
    } finally {
      await sidecar4.close();
    }
  } finally {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error("测试框架异常：", error);
  process.exitCode = 1;
});
